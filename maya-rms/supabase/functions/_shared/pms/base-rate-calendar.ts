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
 *
 * Every other cell is re-read, not just captured once. The hotel changes its
 * rates in the PMS while MAYA is simulating, and a base read once, weeks ago,
 * would have the first live push write over those changes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PmsRatePushAdapter, RateCalendarEntry, RateTargetMap } from "./rate-push.ts";
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
       * Of those, how many the PMS now quotes differently from the price MAYA
       * last sent: someone changed the rate in the PMS after our push. Counted
       * only; what to do about them is not decided yet.
       */
      pmsEditedPushedNights: number;
      days: number;
    };

export type EnsureCalendarResult =
  | SeedCalendarResult
  | { ok: false; reason: "throttled" | "covered" | "failed"; captured: 0 };

const CHUNK = 500;
const PAGE = 1000;
/**
 * Two rates within half a cent are the same rate. The column is numeric(10,2),
 * so a PMS rate with a third decimal never compares exactly equal to what was
 * stored, and would be rewritten on every refresh.
 */
const HALF_CENT = 0.005 + 1e-9;
const DEFAULT_REFRESH_MINUTES = 60;

function ratesDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) > HALF_CENT;
}

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
  opts: { horizonDays?: number; today?: string } = {},
): Promise<SeedCalendarResult> {
  if (!adapter.fetchRateCalendar && !adapter.readBaseRateCalendar) {
    return { ok: false, reason: "unsupported", captured: 0 };
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
  if (localByExternal.size === 0) return { ok: false, reason: "no_room_types", captured: 0 };

  const read = await readPmsCalendar(adapter, firstDate, lastDate);
  if (!read) return { ok: false, reason: "no_rate_targets", captured: 0 };

  // Read after the PMS, so a push that landed in between is seen here.
  const pushed = await readAll(
    supabase,
    "rate_updates",
    "stay_date, room_type_id, price, status",
    hotelId,
    firstDate,
    lastDate,
    ["stay_date", "room_type_id", "id"],
    "pushed cells",
  );
  const pushedCells = new Set<string>();
  const lastSentPrice = new Map<string, number>();
  for (const p of pushed) {
    if (!p.room_type_id) continue;
    const key = `${p.stay_date}|${p.room_type_id}`;
    pushedCells.add(key);
    if (p.status === "sent" && p.price != null) lastSentPrice.set(key, Number(p.price));
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
  let pmsEditedPushedNights = 0;
  for (const e of read.entries) {
    const roomTypeId = localByExternal.get(e.externalRoomTypeId);
    if (!roomTypeId) continue;
    const key = `${e.stayDate}|${roomTypeId}`;
    // One row per cell. Two in one upsert make Postgres reject the whole
    // statement ("cannot affect row a second time").
    if (seen.has(key)) continue;
    seen.add(key);
    if (pushedCells.has(key)) {
      skippedAlreadyPushed++;
      const sent = lastSentPrice.get(key);
      if (sent != null && ratesDiffer(e.price, sent)) pmsEditedPushedNights++;
      continue;
    }
    const was = storedPrice.get(key);
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

  return { ok: true, captured: rows.length, unchanged, skippedAlreadyPushed, pmsEditedPushedNights, days: horizon };
}

/** Targets and nightly rates, from one read where the vendor allows it; null when nothing is targetable. */
async function readPmsCalendar(
  adapter: PmsRatePushAdapter,
  firstDate: string,
  lastDate: string,
): Promise<{ targets: RateTargetMap; entries: RateCalendarEntry[] } | null> {
  if (adapter.readBaseRateCalendar) {
    const read = await adapter.readBaseRateCalendar(firstDate, lastDate);
    return Object.keys(read.targets).length > 0 ? read : null;
  }
  const targets = await adapter.resolveRateTargets({ today: firstDate });
  if (Object.keys(targets).length === 0) return null;
  return { targets, entries: await adapter.fetchRateCalendar!(firstDate, lastDate, targets) };
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
 * seedBaseRateCalendar, so this is safe on a live hotel.
 *
 * Failures are swallowed: a hotel with no calendar prices exactly as it did
 * before this table existed, so a PMS hiccup here must never take down a tick.
 * A failed run is not marked as a refresh, so the next tick tries again.
 */
export async function ensureBaseRateCalendar(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  opts: { horizonDays?: number; clock?: HotelClock; refreshIntervalMs?: number } = {},
): Promise<EnsureCalendarResult> {
  if (!adapter.fetchRateCalendar && !adapter.readBaseRateCalendar) {
    return { ok: false, reason: "unsupported", captured: 0 };
  }

  const horizon = Math.max(1, Math.min(MAX_PRICING_HORIZON_DAYS, Math.floor(opts.horizonDays ?? pricingHorizonDays())));

  try {
    const clock = opts.clock ?? (await readHotelClock(supabase, hotelId));
    const last = await lastRefreshedAt(supabase, hotelId, adapter.pmsType);

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

    const result = await seedBaseRateCalendar(supabase, hotelId, adapter, { horizonDays: horizon, today: clock.today });
    if (last !== "unknown") await markRefreshed(supabase, hotelId, adapter.pmsType, clock.at);
    return result;
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "ensureBaseRateCalendar",
        hotelId,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      }),
    );
    return { ok: false, reason: "failed", captured: 0 };
  }
}

/** When this hotel's calendar was last read from the PMS; null if never, "unknown" if it can't be told. */
async function lastRefreshedAt(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
): Promise<string | null | "unknown"> {
  const { data, error } = await supabase
    .from("pms_connections")
    .select("base_rates_refreshed_at")
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
  return data.base_rates_refreshed_at ? String(data.base_rates_refreshed_at) : null;
}

/**
 * Stamped with the tick's instant, not the time the read finished: a refresh
 * that starts at 23:59 and ends after midnight covered the earlier day's
 * window, and the next tick has to see that.
 */
async function markRefreshed(supabase: SupabaseClient, hotelId: string, pmsType: string, at: string): Promise<void> {
  const { error } = await supabase
    .from("pms_connections")
    .update({ base_rates_refreshed_at: at })
    .eq("hotel_id", hotelId)
    .eq("pms_type", pmsType);
  if (error) {
    // The calendar itself is written; the cost is one extra read next tick.
    console.error(JSON.stringify({ fn: "ensureBaseRateCalendar", hotelId, step: "mark_refreshed", error: error.message }));
  }
}
