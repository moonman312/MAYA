/**
 * Shared outbound rate-push orchestrator (PMS-agnostic).
 *
 * After the engine writes prices to `published_price`, this delivers them back
 * to the PMS — but ONLY for hotels in LIVE mode, and ONLY prices that changed
 * since the last successful push (tracked in `public.rate_updates`).
 *
 * Safety:
 *   • Gate 1 — hotel_settings.simulation_mode must be FALSE (Live). Sim hotels
 *     compute + display prices but never write to the PMS.
 *   • Gate 2 — the caller (Edge function) only invokes this when MAYA_PUSH_RATES
 *     is enabled, so deploying the code changes nothing until you opt in.
 *   • Idempotency — a cell is skipped when the ledger already recorded a 'sent'
 *     push at the same price, so we never spam unchanged rates.
 *   • Retries — every failure is classified (push-failure.ts). A cause that
 *     clears on its own is retried quietly each tick, up to MAX_PUSH_ATTEMPTS
 *     at one price, then once a day. A known critical cause is not sent again
 *     until the price or the cell's rate target changes, or a day has passed.
 *   • Incidents — failures are filed by cause and the owner hears about the
 *     ones that need a person (push-incidents.ts). A run with nothing failing
 *     and nothing on record as failing makes no extra database call for this.
 *   • Target freshness — the cached room-type→rate map is re-resolved whenever a
 *     cell it doesn't cover shows up, and dropped after a push rejection, so a
 *     new room type or a rebuilt rate catalog heals on the next tick.
 *   • Window — [hotel today, hotel today + horizon - 1], the same nights the
 *     tick evaluated (pricing-window.ts).
 *   • Guardrails — every cell about to be sent is checked against its room
 *     type as it is now (active, floor, ceiling), the night's PMS base, the
 *     window and the price's age. A cell that fails is recorded as skipped
 *     with a reason code and never sent. Codes: push-guardrails.ts.
 *   • Ledger — each batch is recorded as soon as the PMS answers it. If that
 *     write fails, no further batch goes out this run: a send the ledger does
 *     not know about is re-sent every tick, and the base rate calendar can
 *     read it back as the hotel's own rate.
 *
 * Vendor specifics live behind PmsRatePushAdapter (Cloudbeds today; Mews next).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { lastNightOf, MAX_PRICING_HORIZON_DAYS, pricingHorizonDays, readHotelClock } from "./pricing-window.ts";
import {
  checkPushGuardrails,
  type GuardrailCode,
  type GuardrailRoomType,
  ledgerRowNeverSent,
  NO_RATE_TARGET_REASON,
  pushMaxPriceAgeMs,
} from "./push-guardrails.ts";
import {
  classifyPushFailure,
  isIncidentSkipReason,
  JOB_UNCONFIRMED_MESSAGE,
  type PushFailure,
  retryDecision,
  type TargetGap,
} from "./push-failure.ts";
import {
  type IncidentRecordSummary,
  recordPushIncidents,
  type RunCell,
  type RunFailure,
} from "./push-incidents.ts";

/** external_room_type_id -> external rate identifier (Cloudbeds base rateID, etc.). */
export type RateTargetMap = Record<string, string>;

export type RateCell = {
  stayDate: string;
  roomTypeId: string;
  externalRoomTypeId: string;
  price: number;
};

export type CellPushResult = {
  cell: RateCell;
  ok: boolean;
  jobReference?: string | null;
  error?: string;
  /** The HTTP status of a refused send, when the vendor answered with one. */
  httpStatus?: number | null;
  /**
   * Not attempted: the deadline passed before its call started. Not a
   * failure, and not recorded, so the next tick sends it.
   */
  deferred?: boolean;
};

/** One room-night of the property's own rate, as the PMS reports it. */
export type RateCalendarEntry = {
  stayDate: string;
  externalRoomTypeId: string;
  price: number;
};

export interface PmsRatePushAdapter {
  pmsType: "cloudbeds" | "mews" | "think";
  /**
   * Resolve external_room_type_id -> external rate id: the room type's BASE
   * rate, and only that. A room type with no base rate is left out of the map
   * rather than given some other plan, so its cells are recorded as skipped
   * instead of landing on a package. `today` is the hotel's date, for a
   * vendor whose catalog read needs a date window.
   */
  resolveRateTargets(opts?: { today?: string }): Promise<RateTargetMap>;
  /**
   * Why the last catalog read left this room type out of the map, when the
   * adapter can tell: its only rates follow another plan, it has rates but
   * none is a base, or the catalog does not list it at all. Null when there
   * has been no read yet or the vendor's catalog does not say. Optional.
   */
  missingTargetReason?(externalRoomTypeId: string): TargetGap | null;
  /**
   * Push cells (already carrying their externalRateId); batch internally per
   * vendor limits. No vendor call starts after `deadlineAt`: the cells it
   * would have carried come back with `deferred: true`.
   */
  pushCells(
    cells: Array<RateCell & { externalRateId: string }>,
    opts?: { deadlineAt?: number },
  ): Promise<CellPushResult[]>;
  /**
   * Ask the vendor what became of jobs we already submitted. patchRate-style
   * endpoints are asynchronous, so "accepted" is not "applied" — without this
   * a failed job stays recorded as sent and the idempotency check suppresses
   * the retry forever. Optional: a vendor with synchronous writes has nothing
   * to reconcile.
   */
  fetchJobOutcomes?(
    jobReferences: string[],
  ): Promise<Record<string, { done: boolean; ok: boolean; message?: string }>>;

  /**
   * Read the property's OWN rate for each room-night in the window — what the
   * hotel charges before MAYA touches anything — from the targeted rate only.
   * Feeds base_rate_calendar, which is why its result must never be stored for
   * a cell we have already pushed to: the number would be our own output
   * coming back as an input.
   *
   * Optional so an adapter can land before its rate read does; callers treat a
   * missing implementation as "no calendar available" rather than an error.
   */
  fetchRateCalendar?(
    startDate: string,
    endDate: string,
    targets: RateTargetMap,
  ): Promise<RateCalendarEntry[]>;

  /**
   * resolveRateTargets and fetchRateCalendar from one read, for a vendor whose
   * catalog and nightly rates come back together (Cloudbeds' getRatePlans).
   * Optional: without it the calendar makes the two calls.
   */
  readBaseRateCalendar?(
    startDate: string,
    endDate: string,
  ): Promise<{ targets: RateTargetMap; entries: RateCalendarEntry[] }>;
}

export type RatePushOptions = {
  /**
   * How many nights to consider pushing, from the hotel's today. The scheduled
   * tick passes the horizon it just evaluated, so no night goes out that this
   * tick did not price. Default: pricingHorizonDays().
   */
  pushHorizonDays?: number;
  /**
   * The hotel's date the window starts on. The tick passes the one it priced
   * with; without it the hotel's timezone is read here.
   */
  today?: string;
  /** Force re-resolve of the cached rate targets. */
  refreshTargets?: boolean;
  /**
   * Absolute time (ms) after which no further vendor call starts, checked
   * before every call the adapter makes. Cells not sent stay unrecorded, so
   * the next tick picks them up, nearest nights first.
   */
  deadlineAt?: number;
  /**
   * The instant of an evaluation of this hotel that finished just before this
   * push, over at least the push window. The tick passes it when its own
   * evaluation succeeded; without it the newest evaluation_run_log row is
   * read, and only if some price's own row is too old to vouch for it.
   */
  evaluatedAt?: string;
};

export type RatePushSummary =
  | { pushed: false; reason: "not_live" | "no_published_prices" | "no_rate_targets" }
  | {
      pushed: true;
      cellsConsidered: number;
      sent: number;
      failed: number;
      skippedUnchanged: number;
      skippedNoTarget: number;
      skippedExhausted: number;
      /** Failed cells not re-sent: their cause is known and critical, and nothing about them changed. */
      skippedHeld?: number;
      /** Changed cells held back by a guardrail, recorded as skipped. */
      skippedGuardrail: number;
      /** skippedGuardrail by reason code, when there were any. */
      guardrails?: Partial<Record<GuardrailCode, number>>;
      /** Cells whose rate job the vendor confirmed as applied. */
      jobsConfirmed?: number;
      /** Cells the vendor ACCEPTED then rejected — put back in play, not left looking live. */
      jobsRejected?: number;
      /** Changed cells not attempted: the deadline passed, or a ledger write failed first. */
      deferred?: number;
      /**
       * A rate_updates write failed and nothing more was sent this run.
       * `unrecorded` cells reached the PMS (or were refused by it) with no
       * ledger row to show for it.
       */
      ledgerWriteFailed?: { unrecorded: number; error: string };
      /** What recording failures as incidents did, when there was anything to record. */
      incidents?: IncidentRecordSummary | { error: string };
    };

/** Cells handed to one adapter.pushCells call. 300 is ten full Cloudbeds patchRate calls. */
const PUSH_BATCH_CELLS = 300;
/**
 * How long a sent cell's job keeps being asked about after the run that sent
 * it. A large first push submits dozens of jobs, and one still running after
 * the run's last look, or missing from the vendor's recent-jobs list that
 * time, used to be recorded as sent for good: nothing ever asked again.
 */
const RECONCILE_LOOKBACK_MS = 60 * 60_000;
/**
 * Past this age a job the vendor has not reported on is taken as not applied:
 * its cells are written back as failed and sent again (reconcileJobOutcomes).
 */
const RECONCILE_UNCONFIRMED_AFTER_MS = 45 * 60_000;
/**
 * Earlier jobs this isolate has already seen decided, by hotel, PMS and job
 * reference. A confirmed job's cells stay "sent" in the ledger for the whole
 * lookback, so without this every tick asked the vendor about it again,
 * counted its cells as confirmed again, and took it as unconfirmed once it
 * dropped off the vendor's recent-jobs list.
 */
const decidedJobs = new Set<string>();
const DECIDED_JOBS_MAX = 5000;

function decidedKey(hotelId: string, pmsType: string, ref: string): string {
  return `${hotelId}|${pmsType}|${ref}`;
}

function markDecided(hotelId: string, pmsType: string, jobRef: string): void {
  if (decidedJobs.size >= DECIDED_JOBS_MAX) decidedJobs.clear();
  decidedJobs.add(decidedKey(hotelId, pmsType, jobRef));
}

/** Test hook: forget which jobs were already decided. */
export function resetDecidedJobs(): void {
  decidedJobs.clear();
}

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll(makeQuery: () => any): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let from = 0;
  let guard = 0;
  for (;;) {
    if (++guard > 1000) break;
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < 1000) break;
    from += 1000;
  }
  return all;
}

export async function pushRatesForHotel(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  opts: RatePushOptions = {},
): Promise<RatePushSummary> {
  // ── Gate 1: LIVE mode only ────────────────────────────────────────────────
  const { data: settings } = await supabase
    .from("hotel_settings")
    .select("simulation_mode")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  // Default (missing row) is treated as simulation → do not push.
  if (settings?.simulation_mode !== false) {
    return { pushed: false, reason: "not_live" };
  }

  // The hotel's calendar, not UTC's: see pricing-window.ts.
  const horizon = Math.max(1, Math.min(MAX_PRICING_HORIZON_DAYS, Math.floor(opts.pushHorizonDays ?? pricingHorizonDays())));
  const firstDate = opts.today ?? (await readHotelClock(supabase, hotelId)).today;
  const lastDate = lastNightOf(firstDate, horizon);

  // ── Load engine output for the window ─────────────────────────────────────
  const ppRows = await fetchAll(() =>
    supabase
      .from("published_price")
      .select("stay_date, room_type_id, price, computed_at")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );
  if (ppRows.length === 0) return { pushed: false, reason: "no_published_prices" };

  // Every room type, active or not: a switched-off type's leftover rows have
  // to be seen to be held back and recorded, not silently dropped.
  const rtRows = await fetchAll(() =>
    supabase
      .from("room_types")
      .select("id, external_room_type_id, is_active, floor_price, ceiling_price")
      .eq("hotel_id", hotelId)
      .order("id", { ascending: true }),
  );
  const roomTypeById = new Map<string, { ext: string; isActive: unknown; floorPrice: unknown; ceilingPrice: unknown }>();
  for (const r of rtRows) {
    if (!r.id || !r.external_room_type_id) continue;
    roomTypeById.set(String(r.id), {
      ext: String(r.external_room_type_id),
      isActive: r.is_active,
      floorPrice: r.floor_price,
      ceilingPrice: r.ceiling_price,
    });
  }

  // Ledger: last state per (room_type, stay_date)
  const ledgerRows = await fetchAll(() =>
    supabase
      .from("rate_updates")
      .select(
        "room_type_id, external_room_type_id, stay_date, price, status, attempts, error, pms_job_reference, external_rate_id, pushed_at",
      )
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );
  const nowMs = Date.now();
  const lastSent = new Map<string, number>();
  const lastFailed = new Map<string, FailedCell>();
  const priorRow = new Map<string, { status: unknown; price: unknown; attempts: unknown; error: unknown }>();
  // Tries a sent cell took at its price, so a job rejected later carries the count on.
  const sentAttempts = new Map<string, number>();
  // Cells an earlier run sent whose job may not have been confirmed yet.
  const recentlySent: Array<{ key: string; ref: string; pushedAt: number; result: CellPushResult }> = [];
  // Something in the window is on record as failing or held back, so an
  // incident may be open. Without it, and without a failure this run, the
  // incident tables are never read.
  let mayHaveOpen = false;
  const lookbackFrom = nowMs - RECONCILE_LOOKBACK_MS;
  for (const l of ledgerRows) {
    const key = `${l.stay_date}|${String(l.room_type_id)}`;
    priorRow.set(key, { status: l.status, price: l.price, attempts: l.attempts, error: l.error });
    if (l.status === "sent" && l.price != null) {
      lastSent.set(key, Number(l.price));
      sentAttempts.set(key, Number(l.attempts) || 1);
      const ref = l.pms_job_reference != null ? String(l.pms_job_reference) : "";
      const pushedAt = l.pushed_at != null ? Date.parse(String(l.pushed_at)) : NaN;
      // "accepted:" is a synchronous vendor's stand-in, not a job to look up.
      if (ref && !ref.startsWith("accepted:") && pushedAt >= lookbackFrom) {
        recentlySent.push({
          key,
          ref,
          pushedAt,
          result: {
            cell: {
              stayDate: String(l.stay_date),
              roomTypeId: String(l.room_type_id),
              externalRoomTypeId: String(l.external_room_type_id ?? ""),
              price: Number(l.price),
            },
            ok: true,
            jobReference: ref,
          },
        });
      }
    } else if (l.status === "failed" && l.price != null) {
      mayHaveOpen = true;
      lastFailed.set(key, {
        price: Number(l.price),
        attempts: Number(l.attempts) || 1,
        error: l.error != null ? String(l.error) : null,
        jobReference: l.pms_job_reference != null ? String(l.pms_job_reference) : null,
        externalRateId: l.external_rate_id != null ? String(l.external_rate_id) : null,
        pushedAtMs: l.pushed_at != null ? Date.parse(String(l.pushed_at)) : NaN,
      });
    } else if (l.status === "skipped" && isIncidentSkipReason(l.error)) {
      mayHaveOpen = true;
    }
  }

  // What this run did to each cell, and the failures it hit, for push-incidents.ts.
  const run: RunTrack = { cells: new Map(), failures: [] };

  // ── Which cells changed since the last successful push? ───────────────────
  const candidates: Array<RateCell & { computedAtMs: number; roomType: GuardrailRoomType }> = [];
  let skippedUnchanged = 0;
  for (const p of ppRows) {
    const roomTypeId = String(p.room_type_id);
    const rt = roomTypeById.get(roomTypeId);
    // No external mapping → can't target it, and the ledger's foreign key
    // could not hold a row for it either.
    if (!rt) {
      skippedUnchanged += 1;
      continue;
    }
    const price = p.price == null ? NaN : Number(p.price);
    const key = `${p.stay_date}|${roomTypeId}`;
    if (lastSent.get(key) === price) {
      skippedUnchanged += 1; // unchanged since last send
      run.cells.set(key, { stayDate: String(p.stay_date), roomTypeId, price, state: "landed" });
      continue;
    }
    candidates.push({
      stayDate: String(p.stay_date),
      roomTypeId,
      externalRoomTypeId: rt.ext,
      price,
      computedAtMs: p.computed_at != null ? Date.parse(String(p.computed_at)) : NaN,
      roomType: rt,
    });
  }

  // ── Guardrails: the last check before anything leaves ─────────────────────
  const nowIso = new Date().toISOString();
  const zeroBase = candidates.length > 0 ? await loadZeroBaseNights(supabase, hotelId, firstDate, lastDate) : new Set<string>();
  const freshAfterMs = Date.now() - pushMaxPriceAgeMs();
  let evaluatedAtMs = opts.evaluatedAt ? Date.parse(opts.evaluatedAt) : NaN;
  if (!(evaluatedAtMs >= freshAfterMs) && candidates.some((c) => !(c.computedAtMs >= freshAfterMs))) {
    const logged = await lastEvaluatedAtMs(supabase, hotelId);
    if (Number.isFinite(logged) && !(evaluatedAtMs >= logged)) evaluatedAtMs = logged;
  }

  const changed: RateCell[] = [];
  const guardrailRows: Record<string, unknown>[] = [];
  const guardrails: Partial<Record<GuardrailCode, number>> = {};
  let skippedGuardrail = 0;
  // Failed cells not sent this run: a critical cause is holding them, or they
  // used their tries at this price. Both wait a day unless the target moves.
  const sittingOut: Array<{ cell: RateCell; failed: FailedCell; verdict: "held" | "exhausted" }> = [];
  for (const c of candidates) {
    const key = `${c.stayDate}|${c.roomTypeId}`;
    const cell: RateCell = { stayDate: c.stayDate, roomTypeId: c.roomTypeId, externalRoomTypeId: c.externalRoomTypeId, price: c.price };
    const code = checkPushGuardrails({
      stayDate: c.stayDate,
      price: c.price,
      roomType: c.roomType,
      firstDate,
      lastDate,
      zeroBase: zeroBase.has(key),
      computedAtMs: c.computedAtMs,
      evaluatedAtMs,
      freshAfterMs,
    });
    if (code) {
      skippedGuardrail += 1;
      guardrails[code] = (guardrails[code] ?? 0) + 1;
      const failure = classifyPushFailure({ pms: adapter.pmsType, phase: "guardrail", message: code });
      run.cells.set(key, { ...cellRef(cell), state: "failing", failure });
      const row = skippedLedgerRow(hotelId, adapter.pmsType, c, code, priorRow.get(key), nowIso);
      if (row) {
        guardrailRows.push(row);
        run.failures.push(skipFailure(cell, code, failure, nowIso));
      }
      continue;
    }
    const failed = lastFailed.get(key);
    if (failed && failed.price === c.price) {
      const failure = ledgerFailure(adapter.pmsType, failed);
      const verdict = retryDecision({ failure, attempts: failed.attempts, lastAttemptAtMs: failed.pushedAtMs, nowMs });
      if (verdict !== "retry") {
        sittingOut.push({ cell, failed, verdict });
        run.cells.set(key, { ...cellRef(cell), state: "failing", failure });
        continue;
      }
    }
    changed.push(cell);
  }

  const summary = {
    pushed: true as const,
    cellsConsidered: ppRows.length,
    sent: 0,
    failed: 0,
    skippedUnchanged,
    skippedNoTarget: 0,
    skippedExhausted: sittingOut.filter((s) => s.verdict === "exhausted").length,
    skippedGuardrail,
    ...(skippedGuardrail > 0 ? { guardrails } : {}),
  };
  let skippedHeld = sittingOut.length - summary.skippedExhausted;

  // Held-back cells are recorded before anything is sent. A ledger that
  // cannot take these will not take the sends either.
  const guardrailWrite = await writeLedgerRows(supabase, guardrailRows);
  if (guardrailWrite) {
    logLedgerWriteFailed(hotelId, adapter.pmsType, "guardrail_skips", guardrailWrite, 0);
    return {
      ...summary,
      ...(skippedHeld > 0 ? { skippedHeld } : {}),
      ...(changed.length > 0 ? { deferred: changed.length } : {}),
      ledgerWriteFailed: { unrecorded: 0, error: guardrailWrite },
    };
  }

  if (changed.length === 0) {
    const earlier = earlierJobs(recentlySent, new Set(), (ref) => decidedJobs.has(decidedKey(hotelId, adapter.pmsType, ref)));
    const jobConfirmed =
      earlier.size > 0
        ? await reconcileJobOutcomes(supabase, hotelId, adapter, [], nowIso, earlier, opts.deadlineAt, { run, sentAttempts })
        : null;
    // No map was loaded this run, so the stale one is dropped by hotel.
    if (jobConfirmed?.dropTargets) {
      const { error } = await supabase
        .from("pms_connections")
        .update({ push_rate_targets: null })
        .eq("hotel_id", hotelId)
        .eq("pms_type", adapter.pmsType);
      if (error) logTargetsWriteFailed(hotelId, adapter.pmsType, "drop", error.message);
    }
    const incidents = await recordPushIncidents(supabase, {
      hotelId,
      pmsType: adapter.pmsType,
      nowMs,
      cells: run.cells,
      failures: run.failures,
      mayHaveOpen,
    });
    return {
      ...summary,
      ...(skippedHeld > 0 ? { skippedHeld } : {}),
      ...(jobConfirmed != null ? jobSummary(jobConfirmed) : {}),
      ...(incidents ? { incidents } : {}),
    };
  }

  // ── Resolve rate targets (cached on the connection) ───────────────────────
  let targets: RateTargetMap = {};
  const { data: conn } = await supabase
    .from("pms_connections")
    .select("id, push_rate_targets")
    .eq("hotel_id", hotelId)
    .eq("pms_type", adapter.pmsType)
    .maybeSingle();
  if (!opts.refreshTargets && conn?.push_rate_targets && typeof conn.push_rate_targets === "object") {
    targets = conn.push_rate_targets as RateTargetMap;
  }
  // Coverage, not age, is what tells us the cache is out of date: a room type
  // added in the PMS after the map was written is simply absent from it, and a
  // non-empty map would otherwise never be re-resolved.
  let usingCache = Object.keys(targets).length > 0;
  const uncovered = changed.some((c) => !targets[c.externalRoomTypeId]);
  if (!usingCache || uncovered) {
    // A room type with only derived rate plans can never be covered, so this
    // re-resolve then runs on every tick — a throwing catalog read must not take
    // down the cells the cached map still targets.
    let resolved: RateTargetMap = {};
    try {
      resolved = await adapter.resolveRateTargets({ today: firstDate });
    } catch (e) {
      if (!usingCache) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `${adapter.pmsType} rate target re-resolve failed for hotel ${hotelId}, keeping cached map: ${msg.slice(0, 300)}`,
      );
    }
    // An empty catalog read is a vendor hiccup far more often than a real
    // teardown — don't let it wipe a map that is still pushing rates.
    if (Object.keys(resolved).length > 0) {
      targets = resolved;
      usingCache = false;
      if (conn?.id) {
        // Not fatal: this run pushes with the map it just resolved, and the
        // next one resolves again.
        const { error } = await supabase.from("pms_connections").update({ push_rate_targets: targets }).eq("id", conn.id);
        if (error) logTargetsWriteFailed(hotelId, adapter.pmsType, "cache", error.message);
      }
    }
  }
  if (Object.keys(targets).length === 0) {
    return { pushed: false, reason: "no_rate_targets" };
  }

  // A cell sitting out whose room type now maps to a different rate than the
  // one that failed is a new question, so it goes out with the rest.
  let requeued = 0;
  for (const s of sittingOut) {
    const rateId = targets[s.cell.externalRoomTypeId];
    if (!rateId || !s.failed.externalRateId || rateId === s.failed.externalRateId) continue;
    changed.push(s.cell);
    requeued += 1;
    if (s.verdict === "exhausted") summary.skippedExhausted -= 1;
    else skippedHeld -= 1;
  }
  if (requeued > 0) {
    // Nearest nights first, as the published rows were read.
    changed.sort((a, b) =>
      a.stayDate < b.stayDate ? -1 : a.stayDate > b.stayDate ? 1 : a.roomTypeId < b.roomTypeId ? -1 : a.roomTypeId > b.roomTypeId ? 1 : 0,
    );
  }

  // Attach rate ids; separate cells with no target
  const withTarget: Array<RateCell & { externalRateId: string }> = [];
  const noTargetRows: Record<string, unknown>[] = [];
  let skippedNoTarget = 0;
  for (const c of changed) {
    const rateId = targets[c.externalRoomTypeId];
    const key = `${c.stayDate}|${c.roomTypeId}`;
    if (rateId) {
      withTarget.push({ ...c, externalRateId: rateId });
      // Until the PMS answers for it.
      run.cells.set(key, { ...cellRef(c), state: "waiting" });
      continue;
    }
    skippedNoTarget += 1;
    const failure = classifyPushFailure({
      pms: adapter.pmsType,
      phase: "guardrail",
      message: NO_RATE_TARGET_REASON,
      targetGap: adapter.missingTargetReason?.(c.externalRoomTypeId) ?? null,
    });
    run.cells.set(key, { ...cellRef(c), state: "failing", failure });
    const row = skippedLedgerRow(hotelId, adapter.pmsType, c, NO_RATE_TARGET_REASON, priorRow.get(key), nowIso);
    if (row) {
      noTargetRows.push(row);
      run.failures.push(skipFailure(c, NO_RATE_TARGET_REASON, failure, nowIso));
    }
  }
  summary.skippedNoTarget = skippedNoTarget;

  const noTargetWrite = await writeLedgerRows(supabase, noTargetRows);
  if (noTargetWrite) {
    logLedgerWriteFailed(hotelId, adapter.pmsType, "no_target_skips", noTargetWrite, 0);
    return {
      ...summary,
      ...(skippedHeld > 0 ? { skippedHeld } : {}),
      ...(withTarget.length > 0 ? { deferred: withTarget.length } : {}),
      ledgerWriteFailed: { unrecorded: 0, error: noTargetWrite },
    };
  }

  // ── Push, recording each batch as soon as the PMS answers it ──────────────
  // In batches, nearest nights first, so a large first push stops at the
  // caller's deadline instead of running past the end of its invocation.
  const results: CellPushResult[] = [];
  let deferred = 0;
  let sent = 0;
  let failed = 0;
  let staleTargets = false;
  let ledgerWriteFailed: { unrecorded: number; error: string } | undefined;
  for (let i = 0; i < withTarget.length; i += PUSH_BATCH_CELLS) {
    if (opts.deadlineAt != null && Date.now() > opts.deadlineAt) {
      deferred += withTarget.length - i;
      break;
    }
    const batch = withTarget.slice(i, i + PUSH_BATCH_CELLS);
    const answered = await adapter.pushCells(batch, { deadlineAt: opts.deadlineAt });
    const attempted = answered.filter((r) => !r.deferred);
    deferred += answered.length - attempted.length;
    sent += attempted.filter((r) => r.ok).length;
    failed += attempted.filter((r) => !r.ok).length;

    const batchAt = new Date().toISOString();
    const rows = attempted.map((r) => attemptLedgerRow(hotelId, adapter.pmsType, r, lastFailed, batchAt));
    const error = await writeLedgerRows(supabase, rows);
    if (error) {
      // These cells are in the PMS (or refused by it) with nothing on record.
      // Sending more would only widen that gap; the next tick re-sends them.
      const notAttempted = withTarget.length - (i + batch.length);
      deferred += notAttempted;
      ledgerWriteFailed = { unrecorded: rows.length, error };
      logLedgerWriteFailed(hotelId, adapter.pmsType, "batch", error, rows.length, notAttempted);
      break;
    }
    results.push(...attempted);
    attempted.forEach((r, n) => {
      const key = `${r.cell.stayDate}|${r.cell.roomTypeId}`;
      const tries = Number(rows[n].attempts);
      if (r.ok) {
        sentAttempts.set(key, tries);
        run.cells.set(key, {
          ...cellRef(r.cell),
          state: "landed",
          sent: { at: batchAt, phase: "send", jobReference: r.jobReference ?? null },
        });
        return;
      }
      const message = rows[n].error != null ? String(rows[n].error) : null;
      const failure = classifyPushFailure({
        pms: adapter.pmsType,
        phase: "send",
        httpStatus: r.httpStatus ?? null,
        message,
        attempt: tries,
      });
      if (failure.dropTargets) staleTargets = true;
      run.cells.set(key, { ...cellRef(r.cell), state: "failing", failure });
      run.failures.push({
        ...cellRef(r.cell),
        at: batchAt,
        phase: "send",
        outcome: "failed",
        httpStatus: r.httpStatus ?? null,
        message,
        jobReference: null,
        failure,
      });
    });
  }

  // "Accepted" is not "applied". patchRate queues a job, so a cell we just
  // marked sent may still be rejected downstream — and because the ledger
  // treats a sent row as the last known good price, a silent failure would
  // both misreport the rate as live AND suppress every future retry of it.
  // Reconcile the jobs we have references for; anything still running is left
  // alone for the next tick to ask about again. Only recorded cells: a
  // correction has nothing to correct for a cell with no row.
  // Cells re-sent just now carry this run's job, not the earlier one.
  const earlier = earlierJobs(
    recentlySent,
    new Set(results.map((r) => `${r.cell.stayDate}|${r.cell.roomTypeId}`)),
    (ref) => decidedJobs.has(decidedKey(hotelId, adapter.pmsType, ref)),
  );
  const jobConfirmed = await reconcileJobOutcomes(supabase, hotelId, adapter, results, nowIso, earlier, opts.deadlineAt, {
    run,
    sentAttempts,
  });

  // A refusal that can mean the cached rate ids are gone (the catalog was
  // rebuilt) drops the cache. Failed cells stay "changed" (only sends land in
  // the ledger's lastSent), so the next tick re-resolves and retries them
  // instead of hammering dead ids. An outage or a refused value says nothing
  // about the ids, and re-reading the catalog then only adds load.
  if ((staleTargets || jobConfirmed?.dropTargets) && usingCache && conn?.id) {
    const { error } = await supabase.from("pms_connections").update({ push_rate_targets: null }).eq("id", conn.id);
    // Left in place, the dead ids are tried again next tick and dropped then.
    if (error) logTargetsWriteFailed(hotelId, adapter.pmsType, "drop", error.message);
  }

  // A ledger that could not take a batch leaves cells whose state nobody
  // knows; the next run records what it finds.
  const incidents = ledgerWriteFailed
    ? null
    : await recordPushIncidents(supabase, {
        hotelId,
        pmsType: adapter.pmsType,
        nowMs,
        cells: run.cells,
        failures: run.failures,
        mayHaveOpen,
      });

  return {
    ...summary,
    sent,
    failed,
    ...(skippedHeld > 0 ? { skippedHeld } : {}),
    ...(jobConfirmed != null ? jobSummary(jobConfirmed) : {}),
    ...(deferred > 0 ? { deferred } : {}),
    ...(ledgerWriteFailed ? { ledgerWriteFailed } : {}),
    ...(incidents ? { incidents } : {}),
  };
}

/** A failed ledger row, as the retry decision reads it. */
type FailedCell = {
  price: number;
  attempts: number;
  error: string | null;
  jobReference: string | null;
  /** The rate it was sent to, so a re-resolved target that differs lets it go again. */
  externalRateId: string | null;
  pushedAtMs: number;
};

type RunTrack = { cells: Map<string, RunCell>; failures: RunFailure[] };

function cellRef(c: RateCell): { stayDate: string; roomTypeId: string; price: number } {
  return { stayDate: c.stayDate, roomTypeId: c.roomTypeId, price: c.price };
}

/** A failed row's cause. A real job reference means the vendor's job queue refused it. */
function ledgerFailure(pmsType: string, failed: FailedCell): PushFailure {
  const job = !!failed.jobReference && !failed.jobReference.startsWith("accepted:");
  return classifyPushFailure({
    pms: pmsType,
    phase: job ? "job" : "send",
    message: failed.error,
    attempt: failed.attempts,
  });
}

function skipFailure(c: RateCell, reason: string, failure: PushFailure, at: string): RunFailure {
  return {
    ...cellRef(c),
    at,
    phase: "guardrail",
    outcome: "skipped",
    httpStatus: null,
    message: reason,
    jobReference: null,
    failure,
  };
}

function jobSummary(j: { ok: number; rejected: number; unconfirmed: number }) {
  return {
    jobsConfirmed: j.ok,
    jobsRejected: j.rejected,
    ...(j.unconfirmed > 0 ? { jobsUnconfirmed: j.unconfirmed } : {}),
  };
}

/** Upserted in chunks; the first error's message, cut to 300 characters, or null. */
async function writeLedgerRows(supabase: SupabaseClient, rows: Record<string, unknown>[]): Promise<string | null> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from("rate_updates")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "hotel_id,room_type_id,stay_date" });
    if (error) return String(error.message ?? "rate_updates write failed").slice(0, 300);
  }
  return null;
}

/** A sent or failed cell's ledger row. */
function attemptLedgerRow(
  hotelId: string,
  pmsType: string,
  r: CellPushResult,
  lastFailed: Map<string, { price: number; attempts: number }>,
  pushedAt: string,
): Record<string, unknown> & { attempts: number; error: string | null } {
  const prior = lastFailed.get(`${r.cell.stayDate}|${r.cell.roomTypeId}`);
  return {
    hotel_id: hotelId,
    pms_type: pmsType,
    room_type_id: r.cell.roomTypeId,
    external_room_type_id: r.cell.externalRoomTypeId,
    stay_date: r.cell.stayDate,
    price: r.cell.price,
    external_rate_id: (r.cell as RateCell & { externalRateId?: string }).externalRateId ?? null,
    status: r.ok ? "sent" : "failed",
    pms_job_reference: r.jobReference ?? null,
    // Vendor text: cut, and only ever the vendor's own message about the call.
    error: r.ok ? null : (r.error ?? "push failed").slice(0, 300),
    // Tries at this price, this one included, so MAX_PUSH_ATTEMPTS can rest a
    // cell the PMS keeps refusing without giving up on a new number. A send
    // keeps the count too: its job can still come back rejected.
    attempts: prior && prior.price === r.cell.price ? prior.attempts + 1 : 1,
    pushed_at: pushedAt,
  };
}

/**
 * A held-back cell's ledger row, or null when the row already says exactly
 * this. `attempts` keeps saying whether MAYA ever sent to the night (see
 * push-guardrails.ts): 0 while it never has, 1 once a send or failed send
 * sits underneath.
 */
function skippedLedgerRow(
  hotelId: string,
  pmsType: string,
  c: RateCell,
  reason: string,
  prior: { status: unknown; price: unknown; attempts: unknown; error: unknown } | undefined,
  pushedAt: string,
): Record<string, unknown> | null {
  // numeric(10,2) not null: a price that is not a number is stored as 0 under
  // its invalid_price code.
  const price = Number.isFinite(c.price) ? Math.round(c.price * 100) / 100 : 0;
  const attempts = ledgerRowNeverSent(prior) ? 0 : 1;
  if (
    prior &&
    prior.status === "skipped" &&
    prior.error === reason &&
    Number(prior.price) === price &&
    Number(prior.attempts) === attempts
  ) {
    return null;
  }
  return {
    hotel_id: hotelId,
    pms_type: pmsType,
    room_type_id: c.roomTypeId,
    external_room_type_id: c.externalRoomTypeId,
    stay_date: c.stayDate,
    price,
    external_rate_id: null,
    status: "skipped",
    pms_job_reference: null,
    error: reason,
    attempts,
    pushed_at: pushedAt,
  };
}

/**
 * Nights whose PMS base rate is 0 (closed, or rates not loaded that far) and
 * that have no open manual price. Throws on a failed read: without it there
 * is no telling a closed night from an open one.
 */
async function loadZeroBaseNights(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<Set<string>> {
  const zero = new Set<string>();
  const calRows = await fetchAll(() =>
    supabase
      .from("base_rate_calendar")
      .select("stay_date, room_type_id, price")
      .eq("hotel_id", hotelId)
      .eq("price", 0)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );
  for (const r of calRows) {
    if (r.room_type_id && r.price != null && Number(r.price) === 0) zero.add(`${r.stay_date}|${r.room_type_id}`);
  }
  if (zero.size === 0) return zero;
  const manualRows = await fetchAll(() =>
    supabase
      .from("manual_price")
      .select("stay_date, room_type_id")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .is("cleared_at", null)
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true }),
  );
  for (const m of manualRows) zero.delete(`${m.stay_date}|${m.room_type_id}`);
  return zero;
}

/** The newest evaluation of the hotel on record, ms; NaN when there is none or it can't be read. */
async function lastEvaluatedAtMs(supabase: SupabaseClient, hotelId: string): Promise<number> {
  const { data, error } = await supabase
    .from("evaluation_run_log")
    .select("evaluated_at")
    .eq("hotel_id", hotelId)
    .order("evaluated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Fails closed: rows whose own timestamp is old are held back as stale.
    console.error(
      JSON.stringify({ fn: "pushRatesForHotel", hotelId, step: "last_evaluation", error: String(error.message).slice(0, 300) }),
    );
    return NaN;
  }
  return data?.evaluated_at ? Date.parse(String(data.evaluated_at)) : NaN;
}

function logLedgerWriteFailed(
  hotelId: string,
  pmsType: string,
  step: "guardrail_skips" | "no_target_skips" | "batch",
  error: string,
  unrecorded: number,
  notAttempted = 0,
): void {
  console.error(
    JSON.stringify({
      fn: "pushRatesForHotel",
      hotelId,
      pmsType,
      step,
      unrecorded,
      notAttempted,
      error,
      event: "rate_ledger_write_failed",
    }),
  );
}

function logTargetsWriteFailed(hotelId: string, pmsType: string, step: "cache" | "drop", error: string): void {
  console.error(
    JSON.stringify({
      fn: "pushRatesForHotel",
      hotelId,
      pmsType,
      step,
      error: error.slice(0, 300),
      event: "rate_targets_write_failed",
    }),
  );
}

/** Earlier runs' sent cells grouped by job, leaving out cells in `resent` and jobs already decided. */
function earlierJobs(
  recentlySent: Array<{ key: string; ref: string; pushedAt: number; result: CellPushResult }>,
  resent: Set<string>,
  decided: (ref: string) => boolean = () => false,
): Map<string, { pushedAt: number; cells: CellPushResult[] }> {
  const out = new Map<string, { pushedAt: number; cells: CellPushResult[] }>();
  for (const r of recentlySent) {
    if (resent.has(r.key) || decided(r.ref)) continue;
    const entry = out.get(r.ref) ?? { pushedAt: r.pushedAt, cells: [] };
    entry.cells.push(r.result);
    entry.pushedAt = Math.min(entry.pushedAt, r.pushedAt);
    out.set(r.ref, entry);
  }
  return out;
}

/**
 * Ask the vendor what became of the jobs this run submitted, and of the ones
 * earlier runs submitted in the last hour, and correct the ledger where
 * "accepted" turned out not to mean "applied".
 *
 * A rejected job is written back as failed WITH its reason, which matters for
 * more than reporting: the idempotency check treats a sent row as the last
 * price the PMS accepted, so leaving a failure recorded as sent would make the
 * next tick skip that cell as unchanged and the wrong rate would stand
 * indefinitely. Marking it failed puts the cell back in play. It keeps the
 * tries its send had used, so a rate plan that rejects every job rests after
 * MAX_PUSH_ATTEMPTS like one that refuses the send, instead of being re-sent
 * every tick forever.
 *
 * A job the vendor has still not reported on RECONCILE_UNCONFIRMED_AFTER_MS
 * after it went out is written back the same way, as JOB_UNCONFIRMED_MESSAGE.
 * Nothing says it applied, and a queue that quietly dropped it would
 * otherwise leave the cell looking live for good.
 *
 * Never throws. This is reconciliation after the fact — the prices are already
 * pushed, and a vendor hiccup here must not turn a good push into an error.
 */
async function reconcileJobOutcomes(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  results: CellPushResult[],
  nowIso: string,
  earlier: Map<string, { pushedAt: number; cells: CellPushResult[] }> = new Map(),
  deadlineAt?: number,
  track?: { run: RunTrack; sentAttempts: Map<string, number> },
): Promise<{ ok: number; rejected: number; unconfirmed: number; dropTargets: boolean } | null> {
  if (!adapter.fetchJobOutcomes) return null;

  const byJob = new Map<string, CellPushResult[]>();
  for (const r of results) {
    if (!r.ok || !r.jobReference) continue;
    const list = byJob.get(r.jobReference) ?? [];
    list.push(r);
    byJob.set(r.jobReference, list);
  }
  // Only this run's jobs are worth waiting for; earlier ones are asked once.
  const current = [...byJob.keys()];
  for (const [ref, { cells }] of earlier) {
    if (!byJob.has(ref)) byJob.set(ref, cells);
  }
  if (byJob.size === 0) return null;

  try {
    // Jobs settle in a few seconds (measured: ~4s on Cloudbeds), so wait
    // briefly rather than leaving every confirmation to the next tick. Only a
    // run that actually sent something pays this, and write-on-change means
    // most ticks send nothing at all. Anything still running after the last
    // look is left undecided and asked about again next time.
    const refs = [...byJob.keys()];
    let outcomes = await adapter.fetchJobOutcomes(refs);
    for (const attempt of [0, 1]) {
      const undecided = current.filter((r) => !outcomes[r]?.done);
      if (undecided.length === 0) break;
      // No sleeping past the invocation's end; the next tick asks again.
      if (deadlineAt != null && Date.now() + 3500 > deadlineAt) break;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2500 : 3500));
      outcomes = { ...outcomes, ...(await adapter.fetchJobOutcomes(undecided)) };
    }
    let ok = 0;
    let rejected = 0;
    let unconfirmed = 0;
    const corrections: Record<string, unknown>[] = [];
    const correctedRefs: string[] = [];
    const failures: Array<{ cell: RateCell; failure: PushFailure; message: string; jobRef: string; outcome: "rejected" | "unconfirmed" }> = [];

    const correct = (jobRef: string, cells: CellPushResult[], message: string, outcome: "rejected" | "unconfirmed") => {
      correctedRefs.push(jobRef);
      for (const c of cells) {
        const attempts = track?.sentAttempts.get(`${c.cell.stayDate}|${c.cell.roomTypeId}`) ?? 1;
        corrections.push({
          hotel_id: hotelId,
          pms_type: adapter.pmsType,
          room_type_id: c.cell.roomTypeId,
          external_room_type_id: c.cell.externalRoomTypeId,
          stay_date: c.cell.stayDate,
          price: c.cell.price,
          status: "failed",
          pms_job_reference: jobRef,
          error: message,
          attempts,
          pushed_at: nowIso,
        });
        failures.push({
          cell: c.cell,
          failure: classifyPushFailure({ pms: adapter.pmsType, phase: "job", message, attempt: attempts }),
          message,
          jobRef,
          outcome,
        });
      }
    };

    for (const [jobRef, cells] of byJob) {
      const outcome = outcomes[jobRef];
      if (!outcome || !outcome.done) {
        // Still running, or not in the vendor's list this time: ask again next
        // tick, until it has gone unreported too long to count as applied.
        const sentAt = earlier.get(jobRef)?.pushedAt;
        if (sentAt != null && Date.now() - sentAt > RECONCILE_UNCONFIRMED_AFTER_MS) {
          unconfirmed += cells.length;
          correct(jobRef, cells, JOB_UNCONFIRMED_MESSAGE, "unconfirmed");
        }
        continue;
      }
      if (outcome.ok) {
        markDecided(hotelId, adapter.pmsType, jobRef);
        ok += cells.length;
        continue;
      }
      // A rejected job only counts as decided once its cells are stored as
      // failed. If that write fails, the ledger still says sent, and asking
      // again next tick is what gets the correction written.
      rejected += cells.length;
      correct(jobRef, cells, (outcome.message ?? "rate job rejected").slice(0, 300), "rejected");
    }

    let dropTargets = false;
    if (corrections.length > 0) {
      const { error: correctionError } = await supabase
        .from("rate_updates")
        .upsert(corrections, { onConflict: "hotel_id,room_type_id,stay_date" });
      if (correctionError) {
        console.error(
          JSON.stringify({
            fn: "reconcileJobOutcomes",
            hotelId,
            pmsType: adapter.pmsType,
            error: correctionError.message,
            event: "rate_job_correction_failed",
          }),
        );
        return { ok, rejected, unconfirmed, dropTargets: false };
      }
      for (const ref of correctedRefs) markDecided(hotelId, adapter.pmsType, ref);
      for (const f of failures) {
        if (f.failure.dropTargets) dropTargets = true;
        if (!track) continue;
        track.run.cells.set(`${f.cell.stayDate}|${f.cell.roomTypeId}`, {
          ...cellRef(f.cell),
          state: "failing",
          failure: f.failure,
        });
        track.run.failures.push({
          ...cellRef(f.cell),
          at: nowIso,
          phase: "job",
          outcome: f.outcome,
          httpStatus: null,
          message: f.message,
          jobReference: f.jobRef,
          failure: f.failure,
        });
      }
      console.error(
        JSON.stringify({
          fn: "reconcileJobOutcomes",
          hotelId,
          pmsType: adapter.pmsType,
          rejected,
          ...(unconfirmed > 0 ? { unconfirmed } : {}),
          event: rejected > 0 ? "rate_job_rejected" : "rate_job_unconfirmed",
        }),
      );
    }
    return { ok, rejected, unconfirmed, dropTargets };
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "reconcileJobOutcomes",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return null;
  }
}
