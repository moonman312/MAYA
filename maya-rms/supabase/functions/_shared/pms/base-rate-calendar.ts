/**
 * Capture the property's OWN rate for each room-night into base_rate_calendar.
 *
 * Why this exists: the engine used to take its base from the newest
 * reservation's base_rate, which the reservations_sync_base_rate trigger fills
 * from current_rate — what the guest actually paid. So once MAYA pushed an
 * adjusted rate and someone booked at it, that booking came back through the
 * sync as the cell's base. The rule had not re-fired (ladder rules correctly
 * stay quiet while their condition holds) but the number underneath it had
 * moved, and only ever upward; when the rule later deactivated, the cell
 * reverted to the RAISED number instead of the hotel's own rate. Measured on
 * the sandbox: $200 -> $230 published -> booked at $230 -> $264.50, and a
 * revert that landed on $230 while never-sold rooms correctly returned to $200.
 *
 * It also removes the quiet first day: a brand-new property has no reservations
 * on future dates and therefore no base for them, so the engine skipped those
 * cells entirely and priced nothing until bookings arrived.
 *
 * THE REFRESH RULE, and it is the whole safety story: a cell may be captured
 * only while MAYA has never pushed a rate to it. After we push, the PMS is
 * reporting our own adjustment back to us, and storing that as "the hotel's
 * rate" would rebuild the compounding bug this table exists to prevent.
 * rate_updates is the record of what we have pushed. Any row there counts,
 * whatever its status: the ledger keeps one row per cell, so a later failed or
 * skipped attempt overwrites the row of an earlier send the PMS still holds.
 * The one exception is a skipped row that says nothing was ever sent to its
 * night (attempts 0, see push-guardrails.ts): a night held back by a
 * guardrail since before its first send still quotes the hotel's own rate,
 * and freezing its base there would price it on a number the hotel has since
 * changed.
 *
 * The other is a sent-to night whose stored base is 0: closed, or rates not
 * loaded, when MAYA sent a typed price to it. MAYA never sends 0 or less, so
 * the 0 is not an echo, and the engine never prices a 0 base on its own: left
 * frozen, the night was abandoned for good once the typed price was cleared,
 * even after the hotel loaded its rate. So when the PMS now quotes something
 * other than the last price MAYA is known to have put there, and that row is
 * over an hour old (a job still settling can quote an older MAYA price), the
 * hotel set it, and it is captured. Known means a sent row's price, or the
 * sent_price a skipped row kept from the send under it. A row that only
 * tried a price (failed, or held back over a failed send) says nothing about
 * what is in the PMS: its price may never have landed while an earlier send
 * of MAYA's did, and that send must not come back as the hotel's rate. Such
 * a night stays frozen.
 *
 * Every other cell is re-read, not just captured once. The hotel changes its
 * rates in the PMS while MAYA is simulating, and a base read once, weeks ago,
 * would have the first live push write over those changes.
 *
 * A rate the hotel changed in the PMS on a night MAYA has sent to is not
 * captured either: it is adopted as a manual price for that night
 * (pms-edits.ts), once MAYA's own send there has settled. That happens here,
 * before the tick evaluates, so the same tick publishes the hotel's rate and
 * the push has nothing to send. A send whose price this read finds in the
 * PMS is stamped settled here too.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PmsRatePushAdapter, RateCalendarEntry, RateTargetMap } from "./rate-push.ts";
import { ledgerRowNeverSent } from "./push-guardrails.ts";
import { adoptPmsEdits, type PushedNightRead } from "./pms-edits.ts";
import { mwsEnv } from "../mews/env.ts";
import { isMissingColumnError } from "../engine/snapshots.ts";
import { evalIsoToHotelDateString } from "../engine/timezone.ts";
import {
  type HotelClock,
  lastNightOf,
  MAX_PRICING_HORIZON_DAYS,
  pricingHorizonDays,
  readHotelClock,
} from "./pricing-window.ts";

export type SeedCalendarResult =
  | { ok: false; reason: "unsupported" | "no_rate_targets" | "no_room_types"; captured: 0 }
  | {
      ok: true;
      /** Cells written: new, or the PMS rate moved. */
      captured: number;
      /** Cells the PMS still quotes at the stored rate; not written. */
      unchanged: number;
      /** Nights MAYA has pushed to, left alone. */
      skippedAlreadyPushed: number;
      /**
       * Of those, how many the hotel changed in the PMS since MAYA's send
       * there settled, now open manual prices at the PMS rate (pms-edits.ts).
       */
      pmsEditsAdopted: number;
      /** Of `captured`, sent-to nights stored at 0 that the hotel has since loaded a rate for. */
      loadedAfterZeroBase: number;
      days: number;
      /**
       * `stay_date|room_type_id` of every night whose rate in the PMS this
       * read found moved: base rates written, and nights pms-edits.ts took
       * (a change, a closed night, a new base).
       */
      movedCells: string[];
      /**
       * Of movedCells, the nights the push must not send a new price to this
       * tick although the PMS was read (pms-edits.ts holdCells): the ones it
       * has at 0 over a send not known to have landed with a manual price
       * open, or the ones it could not record when taking the hotel's
       * changes failed.
       */
      holdCells: string[];
      /** Taking the hotel's changes failed; the next refresh tries again. */
      pmsEditsFailed?: true;
    };

/**
 * `deferred`: a refresh was due but too little time was left to start it, or
 * it ran out of time. Not stamped, so the next tick refreshes. `failed` with
 * `step: "pms_read"`: the read of the PMS itself failed, rather than a read
 * or write of MAYA's own.
 */
export type EnsureCalendarResult =
  | SeedCalendarResult
  | { ok: false; reason: "throttled" | "covered" | "failed" | "deferred"; captured: 0 }
  | { ok: false; reason: "failed"; captured: 0; step: "pms_read" };

const CHUNK = 500;
const PAGE = 1000;
/**
 * Two rates within half a cent are the same rate. The column is numeric(10,2),
 * so a PMS rate with a third decimal never compares exactly equal to what was
 * stored, and would be rewritten on every refresh.
 */
const HALF_CENT = 0.005 + 1e-9;
const DEFAULT_REFRESH_MINUTES = 60;
/**
 * A refresh starts only with this long left before its deadline. One Cloudbeds
 * getRatePlans read can wait out a 429 and then take tens of seconds.
 */
export const BASE_REFRESH_RESERVE_MS = 60_000;
/** How old MAYA's last send to a zero-base night must be before a different PMS rate is taken as the hotel's. */
const ZERO_BASE_SETTLE_MS = 60 * 60_000;

function ratesDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) > HALF_CENT;
}

/** Errors the PMS read threw, told apart from the database's, as they were thrown. */
const pmsReadErrors = new WeakSet<object>();

/** How often a hotel's calendar is re-read, from MAYA_BASE_RATE_REFRESH_MINUTES. */
export function baseRateRefreshIntervalMs(raw: string | undefined = mwsEnv("MAYA_BASE_RATE_REFRESH_MINUTES")): number {
  const n = Number(raw);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_REFRESH_MINUTES) * 60_000;
}

/**
 * Read the PMS for [today, today + horizon - 1] and write every cell MAYA has
 * not pushed to whose rate is new or changed. Unchanged cells cost no write.
 *
 * Throws when a read or a write fails, so the caller counts the run as failed
 * and does not mark the calendar fresh. Writes go nearest night first and stop
 * at the first failed chunk, so a hole is never left behind later nights.
 */
export async function seedBaseRateCalendar(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  opts: { horizonDays?: number; today?: string; deadlineAt?: number; at?: string } = {},
): Promise<SeedCalendarResult> {
  return (await seedWithTargets(supabase, hotelId, adapter, opts)).result;
}

/**
 * seedBaseRateCalendar, and the rate targets the read resolved (null when
 * there was no read). `at` is the instant a PMS change is adopted at: the
 * tick's, which its evaluation prices at too.
 */
async function seedWithTargets(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  opts: { horizonDays?: number; today?: string; deadlineAt?: number; at?: string },
): Promise<{ result: SeedCalendarResult; targets: RateTargetMap | null }> {
  if (!adapter.fetchRateCalendar && !adapter.readBaseRateCalendar) {
    return { result: { ok: false, reason: "unsupported", captured: 0 }, targets: null };
  }

  const horizon = Math.max(1, Math.min(MAX_PRICING_HORIZON_DAYS, Math.floor(opts.horizonDays ?? pricingHorizonDays())));
  const firstDate = opts.today ?? (await readHotelClock(supabase, hotelId)).today;
  const lastDate = lastNightOf(firstDate, horizon);

  const { data: rtRows, error: rtError } = await supabase
    .from("room_types")
    .select("id, external_room_type_id")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (rtError) throw new Error(`Failed to read room types: ${rtError.message}`);
  const localByExternal = new Map<string, string>();
  for (const r of rtRows ?? []) {
    if (r.external_room_type_id) localByExternal.set(String(r.external_room_type_id), String(r.id));
  }
  if (localByExternal.size === 0) return { result: { ok: false, reason: "no_room_types", captured: 0 }, targets: null };

  let read: Awaited<ReturnType<typeof readPmsCalendar>>;
  try {
    read = await readPmsCalendar(adapter, firstDate, lastDate, opts.deadlineAt);
  } catch (e) {
    if (e != null && typeof e === "object") pmsReadErrors.add(e);
    throw e;
  }
  if (!read) return { result: { ok: false, reason: "no_rate_targets", captured: 0 }, targets: null };

  // Read after the PMS, so a push that landed in between is seen here.
  const { rows: pushed, settleKnown } = await readPushedCells(supabase, hotelId, firstDate, lastDate);
  // Each pushed cell's ledger row.
  const pushedCells = new Map<string, Record<string, unknown>>();
  // The last price each pushed cell is known to hold from MAYA, and when its row was written.
  const knownSent = new Map<string, { price: number; atMs: number }>();
  for (const p of pushed) {
    if (!p.room_type_id || ledgerRowNeverSent(p)) continue;
    const key = `${p.stay_date}|${p.room_type_id}`;
    pushedCells.set(key, p);
    const price = p.status === "sent" ? p.price : p.status === "skipped" ? p.sent_price : null;
    if (price != null) {
      knownSent.set(key, { price: Number(price), atMs: p.pushed_at != null ? Date.parse(String(p.pushed_at)) : NaN });
    }
  }

  const stored = await readAll(
    supabase,
    "base_rate_calendar",
    "stay_date, room_type_id, price",
    hotelId,
    firstDate,
    lastDate,
    ["stay_date", "room_type_id"],
    "stored base rates",
  );
  const storedPrice = new Map<string, number>();
  for (const s of stored) storedPrice.set(`${s.stay_date}|${s.room_type_id}`, Number(s.price));

  const capturedAt = new Date().toISOString();
  const rows: { hotel_id: string; stay_date: string; room_type_id: string; price: number; source: string; captured_at: string }[] = [];
  const seen = new Set<string>();
  let unchanged = 0;
  let skippedAlreadyPushed = 0;
  let loadedAfterZeroBase = 0;
  // Pushed nights as the PMS quotes them now, for pms-edits.ts.
  const pushedReads: PushedNightRead[] = [];
  const settledBefore = Date.now() - ZERO_BASE_SETTLE_MS;
  for (const e of read.entries) {
    const roomTypeId = localByExternal.get(e.externalRoomTypeId);
    if (!roomTypeId) continue;
    const key = `${e.stayDate}|${roomTypeId}`;
    // One row per cell. Two in one upsert make Postgres reject the whole
    // statement ("cannot affect row a second time").
    if (seen.has(key)) continue;
    seen.add(key);
    const was = storedPrice.get(key);
    if (pushedCells.has(key)) {
      // See the header: a zero base under a send is not MAYA's echo.
      const sent = knownSent.get(key);
      const hotelLoadedIt =
        was != null &&
        !ratesDiffer(was, 0) &&
        ratesDiffer(e.price, 0) &&
        sent != null &&
        ratesDiffer(e.price, sent.price) &&
        !(sent.atMs > settledBefore);
      if (!hotelLoadedIt) {
        skippedAlreadyPushed++;
        pushedReads.push({
          stayDate: e.stayDate,
          roomTypeId,
          externalRoomTypeId: e.externalRoomTypeId,
          pmsRate: e.price,
          ledger: pushedCells.get(key)!,
        });
        continue;
      }
      loadedAfterZeroBase++;
    }
    if (was != null && !ratesDiffer(e.price, was)) {
      unchanged++;
      continue;
    }
    rows.push({
      hotel_id: hotelId,
      stay_date: e.stayDate,
      room_type_id: roomTypeId,
      price: e.price,
      source: "pms",
      captured_at: capturedAt,
    });
  }

  rows.sort((a, b) =>
    a.stay_date < b.stay_date ? -1 : a.stay_date > b.stay_date ? 1 : a.room_type_id < b.room_type_id ? -1 : 1,
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from("base_rate_calendar")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "hotel_id,stay_date,room_type_id" });
    if (error) {
      throw new Error(`Failed to write base rates from ${rows[i].stay_date}: ${error.message}`);
    }
  }

  // A database without the settle columns can't tell a settled send, so nothing there is a hand edit.
  const pmsEdits =
    settleKnown && pushedReads.length > 0
      ? await adoptPmsEdits(supabase, hotelId, adapter.pmsType, pushedReads, read.targets, { firstDate, lastDate }, opts.at ?? capturedAt, {
        sendsZero: adapter.acceptsZeroRate === true,
      })
      : null;

  return {
    result: {
      ok: true,
      captured: rows.length,
      unchanged,
      skippedAlreadyPushed,
      pmsEditsAdopted: pmsEdits?.adopted ?? 0,
      loadedAfterZeroBase,
      days: horizon,
      movedCells: [...rows.map((r) => `${r.stay_date}|${r.room_type_id}`), ...(pmsEdits?.movedCells ?? [])],
      holdCells: pmsEdits?.holdCells ?? [],
      ...(pmsEdits?.failed ? { pmsEditsFailed: true as const } : {}),
    },
    targets: read.targets,
  };
}

/**
 * The window's ledger rows. sent_price and the settle columns (confirmed_at,
 * pms_edited_at) are read too, and left out on a database the push guardrails
 * migration has not given them to yet: only sent rows then say what MAYA put
 * in the PMS, and `settleKnown` is false, so no night is taken as changed in
 * the PMS.
 */
async function readPushedCells(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ rows: any[]; settleKnown: boolean }> {
  const read = (columns: string) =>
    readAll(supabase, "rate_updates", columns, hotelId, firstDate, lastDate, ["stay_date", "room_type_id", "id"], "pushed cells");
  const base =
    "stay_date, room_type_id, price, status, attempts, pushed_at, pms_type, external_room_type_id, external_rate_id, pms_job_reference";
  try {
    return { rows: await read(`${base}, sent_price, confirmed_at, pms_edited_at`), settleKnown: true };
  } catch (e) {
    if (!isMissingColumnError(e)) throw e;
    return { rows: await read(base), settleKnown: false };
  }
}

/** Targets and nightly rates, from one read where the vendor allows it; null when nothing is targetable. */
async function readPmsCalendar(
  adapter: PmsRatePushAdapter,
  firstDate: string,
  lastDate: string,
  deadlineAt?: number,
): Promise<{ targets: RateTargetMap; entries: RateCalendarEntry[] } | null> {
  if (adapter.readBaseRateCalendar) {
    const read = await adapter.readBaseRateCalendar(firstDate, lastDate, { deadlineAt });
    return Object.keys(read.targets).length > 0 ? read : null;
  }
  const targets = await adapter.resolveRateTargets({ today: firstDate, lastNight: lastDate, deadlineAt });
  if (Object.keys(targets).length === 0) return null;
  return { targets, entries: await adapter.fetchRateCalendar!(firstDate, lastDate, targets, { deadlineAt }) };
}

/**
 * A window of one table, paged. A 60-night horizon on a property with 20 room
 * types is past PostgREST's 1,000-row cap, and every pushed cell past it would
 * have been re-captured with our own rate.
 */
async function readAll(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  hotelId: string,
  firstDate: string,
  lastDate: string,
  orderBy: string[],
  what: string,
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from(table)
      .select(columns)
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate);
    for (const col of orderBy) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to read ${what}: ${error.message}`);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/**
 * Keep the calendar covering the pricing window and current with the PMS.
 *
 * Re-reads the whole window when it is due: never refreshed, last refreshed
 * longer ago than the interval (60 minutes by default,
 * MAYA_BASE_RATE_REFRESH_MINUTES), or last refreshed on an earlier hotel date,
 * so the night that just rolled into the window has its base before the engine
 * prices it and the push sends it. Otherwise it costs one small read.
 *
 * `clock` is the tick's instant and hotel date, shared with the evaluation and
 * push that follow. Cells MAYA has already pushed to are excluded inside
 * seedBaseRateCalendar, so this is safe on a live hotel; a rate the hotel
 * changed on one of them is adopted as a manual price set at that instant.
 *
 * `deadlineAt` bounds the read: a due refresh with less than
 * BASE_REFRESH_RESERVE_MS left does not start, and the PMS client stops
 * waiting out rate limits past it. Either way the result is `deferred`, not
 * stamped, and the tick still evaluates on the stored calendar.
 *
 * The rate targets the read resolved are written to the push's cache when
 * they differ from it, so the push sends to the rate this read priced on
 * rather than one a stale cache still names.
 *
 * Failures are swallowed: a hotel with no calendar prices exactly as it did
 * before this table existed, so a PMS hiccup here must never take down a tick.
 * Only a read that worked is marked as a refresh. A failed one, or one that
 * found nothing to target (no_rate_targets, no_room_types), is not, so the
 * next tick tries again and the push keeps holding nights it never sent to.
 */
export async function ensureBaseRateCalendar(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  opts: { horizonDays?: number; clock?: HotelClock; refreshIntervalMs?: number; deadlineAt?: number } = {},
): Promise<EnsureCalendarResult> {
  if (!adapter.fetchRateCalendar && !adapter.readBaseRateCalendar) {
    return { ok: false, reason: "unsupported", captured: 0 };
  }

  const horizon = Math.max(1, Math.min(MAX_PRICING_HORIZON_DAYS, Math.floor(opts.horizonDays ?? pricingHorizonDays())));

  try {
    const clock = opts.clock ?? (await readHotelClock(supabase, hotelId));
    const connection = await lastRefreshedAt(supabase, hotelId, adapter.pmsType);
    const last = connection === "unknown" ? "unknown" : connection.refreshedAt;

    if (last === "unknown") {
      // No record of when it last ran (the column's migration has not run, or
      // the read failed): fill gaps only, as before, rather than calling the
      // PMS on every tick.
      const { data: newest, error } = await supabase
        .from("base_rate_calendar")
        .select("stay_date")
        .eq("hotel_id", hotelId)
        .gte("stay_date", clock.today)
        .order("stay_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Failed to read calendar coverage: ${error.message}`);
      if (newest?.stay_date && String(newest.stay_date) >= lastNightOf(clock.today, horizon)) {
        return { ok: false, reason: "covered", captured: 0 };
      }
    } else if (last !== null) {
      const intervalMs = opts.refreshIntervalMs ?? baseRateRefreshIntervalMs();
      const fresh = Date.parse(clock.at) - Date.parse(last) < intervalMs;
      const sameHotelDay = evalIsoToHotelDateString(last, clock.timeZone) === clock.today;
      if (fresh && sameHotelDay) return { ok: false, reason: "throttled", captured: 0 };
    }

    if (opts.deadlineAt != null && opts.deadlineAt - Date.now() < BASE_REFRESH_RESERVE_MS) {
      return { ok: false, reason: "deferred", captured: 0 };
    }
    const { result, targets } = await seedWithTargets(supabase, hotelId, adapter, {
      horizonDays: horizon,
      today: clock.today,
      deadlineAt: opts.deadlineAt,
      at: clock.at,
    });
    if (connection !== "unknown" && result.ok) {
      const cached = connection.pushRateTargets;
      const newTargets = targets && Object.keys(targets).length > 0 && !sameTargets(targets, cached) ? targets : null;
      await markRefreshed(supabase, hotelId, adapter.pmsType, clock.at, newTargets);
    }
    return result;
  } catch (e) {
    const outOfTime = opts.deadlineAt != null && Date.now() >= opts.deadlineAt;
    console.error(
      JSON.stringify({
        fn: "ensureBaseRateCalendar",
        hotelId,
        ...(outOfTime ? { outOfTime: true } : {}),
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      }),
    );
    if (outOfTime) return { ok: false, reason: "deferred", captured: 0 };
    return e != null && typeof e === "object" && pmsReadErrors.has(e)
      ? { ok: false, reason: "failed", captured: 0, step: "pms_read" }
      : { ok: false, reason: "failed", captured: 0 };
  }
}

/** Same room types to the same rates, whatever the key order. */
function sameTargets(a: RateTargetMap, b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const other = b as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(other).length && keys.every((k) => other[k] === a[k]);
}

/**
 * When this hotel's calendar was last read from the PMS (null if never) and
 * the push's cached targets; "unknown" if it can't be told.
 */
async function lastRefreshedAt(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
): Promise<{ refreshedAt: string | null; pushRateTargets: unknown } | "unknown"> {
  const { data, error } = await supabase
    .from("pms_connections")
    .select("base_rates_refreshed_at, push_rate_targets")
    .eq("hotel_id", hotelId)
    .eq("pms_type", pmsType)
    .maybeSingle();
  if (error) {
    console.error(
      JSON.stringify({
        fn: "ensureBaseRateCalendar",
        hotelId,
        step: "last_refresh",
        ...(isMissingColumnError(error)
          ? { schema: "pre-migration", migration: "99_supabase_migration_push_guardrails_v1.sql" }
          : {}),
        error: error.message,
      }),
    );
    return "unknown";
  }
  // No connection row to stamp: refreshing on every tick would never stop.
  if (!data) return "unknown";
  return {
    refreshedAt: data.base_rates_refreshed_at ? String(data.base_rates_refreshed_at) : null,
    pushRateTargets: data.push_rate_targets ?? null,
  };
}

/**
 * Stamped with the tick's instant, not the time the read finished: a refresh
 * that starts at 23:59 and ends after midnight covered the earlier day's
 * window, and the next tick has to see that. `targets`, when given, replaces
 * the push's cached map in the same write.
 */
async function markRefreshed(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  at: string,
  targets: RateTargetMap | null = null,
): Promise<void> {
  const { error } = await supabase
    .from("pms_connections")
    .update({ base_rates_refreshed_at: at, ...(targets ? { push_rate_targets: targets } : {}) })
    .eq("hotel_id", hotelId)
    .eq("pms_type", pmsType);
  if (error) {
    // The calendar itself is written; the cost is one extra read next tick.
    console.error(JSON.stringify({ fn: "ensureBaseRateCalendar", hotelId, step: "mark_refreshed", error: error.message }));
  }
}
