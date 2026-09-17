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
 *     push at the same price, to the rate its room type maps to now, so we
 *     never spam unchanged rates. A sent cell whose target has moved (or that
 *     went to a package before targets were base rates only) goes out again.
 *   • Retries — every failure is classified (push-failure.ts). A cause that
 *     clears on its own is retried quietly each tick, up to MAX_PUSH_ATTEMPTS
 *     at one price, then once a day. A known critical cause is not sent again
 *     until the price or the cell's rate target changes, or a day has passed,
 *     or, for a grant problem, the connection was re-authorized since.
 *   • Incidents — failures are filed by cause and the owner hears about the
 *     ones that need a person (push-incidents.ts). A run with nothing failing
 *     and nothing on record as failing makes one small read for this. A room
 *     type the catalog lists without a base rate is filed like any other
 *     failure, even when no room type has one; only a catalog read that
 *     taught nothing (failed, or empty) stops the run quietly, and it leaves
 *     a room type an earlier read already filed as it was.
 *   • Target freshness — the cached room-type→rate map is re-resolved whenever a
 *     cell it doesn't cover shows up, or a sent cell went to a rate it doesn't
 *     name, and dropped after a push rejection, so a new room type or a
 *     rebuilt rate catalog heals on the next tick. The hourly base rate
 *     refresh writes the map it read over a cache that differs from it, and
 *     a re-resolve reads the same nights it does.
 *   • Window — [hotel today, hotel today + horizon - 1], the same nights the
 *     tick evaluated (pricing-window.ts).
 *   • Guardrails — every cell about to be sent is checked against its room
 *     type as it is now (active, floor, ceiling), the night's PMS base, the
 *     window and the price's age. A cell that fails is recorded as skipped
 *     with a reason code and never sent. Codes: push-guardrails.ts. A price
 *     only counts as vouched for by an evaluation that priced its night.
 *     A manual price is sent as the engine published it, under the floor or
 *     over the ceiling included; a price of 0 only to a PMS known to take it.
 *   • Manual prices — a published price older than the manual price on its
 *     night was priced before that manual price existed, and is not sent
 *     until an evaluation has priced the night again. On a night changed in
 *     the PMS (base-rate-calendar.ts) that old price is MAYA's, and sending
 *     it would write over the hotel's change.
 *   • Ledger — each batch is recorded as in progress before it goes out, and
 *     again as soon as the PMS answers it. A send the ledger does not know
 *     about would be read back by the base rate calendar as the hotel's own
 *     rate, so a batch whose first write fails is not sent, and one whose
 *     second write fails stops the run.
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
  SEND_IN_PROGRESS_MESSAGE,
  type TargetGap,
} from "./push-failure.ts";
import { markConnectionDisconnected } from "./connection-health.ts";
import { isMissingColumnError, isMissingRelationError } from "../engine/snapshots.ts";
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
   * Refused with 401 on credentials minted after an earlier 401 this run (a
   * different token than the one refused). The only 401 that takes the
   * connection offline (push-failure.ts).
   */
  freshCredentialsRefused?: boolean;
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
   * The PMS takes a nightly rate of 0 from this write. Only set once it has
   * been checked against the vendor: a 0 can mean a closed night, or reach
   * booking channels as a free room. Neither Cloudbeds' patchRate nor Think's
   * PUT /daily has been checked, so neither sets it, and a comp night's 0 is
   * held back as guardrail:zero_rate_unsupported.
   */
  acceptsZeroRate?: boolean;
  /**
   * Resolve external_room_type_id -> external rate id: the room type's BASE
   * rate, and only that. A room type with no base rate is left out of the map
   * rather than given some other plan, so its cells are recorded as skipped
   * instead of landing on a package. `today` and `lastNight` are the nights
   * the caller works on, for a vendor whose catalog read needs a date window:
   * the push and the base rate refresh pass the same ones, so they see the
   * same catalog. Past `deadlineAt` the read stops waiting out rate limits and
   * gives up.
   */
  resolveRateTargets(opts?: { today?: string; lastNight?: string; deadlineAt?: number }): Promise<RateTargetMap>;
  /**
   * Why the last catalog read left this room type out of the map, when the
   * adapter can tell: its only rates follow another plan, it has rates but
   * none is a base, or the catalog does not list it at all. Null when there
   * has been no read yet, or the last one failed or listed nothing: the push
   * then files the cell as a catalog it could not read, not as a missing
   * base rate. Optional; without it every gap reads as no base rate.
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
    opts?: { deadlineAt?: number },
  ): Promise<RateCalendarEntry[]>;

  /**
   * resolveRateTargets and fetchRateCalendar from one read, for a vendor whose
   * catalog and nightly rates come back together (Cloudbeds' getRatePlans).
   * Optional: without it the calendar makes the two calls.
   */
  readBaseRateCalendar?(
    startDate: string,
    endDate: string,
    opts?: { deadlineAt?: number },
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
   * evaluation succeeded; without it evaluation_run_log is read, and only if
   * some price's own row is too old to vouch for it. A logged run vouches
   * only for the nights it priced (first_stay_date..last_stay_date).
   */
  evaluatedAt?: string;
  /**
   * Hold back cells MAYA has never sent to. The tick sets it unless its base
   * rate read worked, or one within the refresh interval did: the first send
   * to a night writes over whatever the hotel has there, and that has to be
   * the rate the engine just priced on, not one read before the hotel changed
   * it. Held cells are not recorded; the next tick sends them.
   */
  holdNeverPushed?: boolean;
  /**
   * Read the PMS again before a new price goes to a night MAYA has sent to,
   * and say which nights' rates there moved since the evaluation priced them
   * (null when the read could not be made). The tick passes it unless its
   * base rate refresh read the PMS already: that refresh runs hourly, and a
   * rate the hotel changed in between would otherwise be written over before
   * it was ever seen. Those nights wait for the next evaluation; with null,
   * everything goes as it would have.
   */
  readBeforeResend?: () => Promise<Set<string> | null>;
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
      /**
       * Changed cells not attempted: the deadline passed, or a ledger write
       * failed first. A cell whose batch was already marked in progress keeps
       * that mark, and is sent next tick.
       */
      deferred?: number;
      /** Never-sent cells held back until a tick's base rate read succeeds (holdNeverPushed). */
      awaitingBaseRead?: number;
      /** Cells whose published price predates the manual price on their night, held until it is priced again. */
      awaitingEvaluation?: number;
      /** Cells whose rate the PMS had moved on since they were priced (readBeforeResend), held until priced again. */
      changedInPms?: number;
      /**
       * A rate_updates write failed and nothing more was sent this run.
       * `unrecorded` cells reached the PMS (or were refused by it) with only
       * their in-progress mark on record.
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
 * Past this age a job the vendor still lists as not finished is taken as not
 * applied: its cells are written back as failed and sent again. One missing
 * from the vendor's list is only logged, once per isolate (see
 * reconcileJobOutcomes).
 */
const RECONCILE_UNCONFIRMED_AFTER_MS = 45 * 60_000;
const loggedUnconfirmed = new Set<string>();
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
  // The rate each sent cell went to, so a cell whose target has since moved is sent again.
  const lastSentRateId = new Map<string, string>();
  const lastFailed = new Map<string, FailedCell>();
  const priorRow = new Map<string, { status: unknown; price: unknown; attempts: unknown; error: unknown }>();
  // Tries a sent cell took at its price, so a job rejected later carries the count on.
  const sentAttempts = new Map<string, number>();
  // Cells an earlier run sent whose job may not have been confirmed yet.
  const recentlySent: Array<{ key: string; ref: string; pushedAt: number; result: CellPushResult }> = [];
  // Something in the window is on record as failing or held back, so an
  // incident may be open. Without it, and without a failure this run, the
  // incident tables get one small read (push-incidents.ts).
  let mayHaveOpen = false;
  const lookbackFrom = nowMs - RECONCILE_LOOKBACK_MS;
  for (const l of ledgerRows) {
    const key = `${l.stay_date}|${String(l.room_type_id)}`;
    priorRow.set(key, { status: l.status, price: l.price, attempts: l.attempts, error: l.error });
    if (l.status === "sent" && l.price != null) {
      lastSent.set(key, Number(l.price));
      if (l.external_rate_id != null && l.external_rate_id !== "") lastSentRateId.set(key, String(l.external_rate_id));
      sentAttempts.set(key, Number(l.attempts) || 1);
      const ref = l.pms_job_reference != null ? String(l.pms_job_reference) : "";
      const pushedAt = l.pushed_at != null ? Date.parse(String(l.pushed_at)) : NaN;
      // "accepted:" is a vendor with no job to look up (Think's 202).
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
      const error = l.error != null ? String(l.error) : null;
      lastFailed.set(key, {
        price: Number(l.price),
        // An in-progress marker counts no try of its own (pendingLedgerRow).
        attempts: error === SEND_IN_PROGRESS_MESSAGE ? Number(l.attempts) || 0 : Number(l.attempts) || 1,
        error,
        jobReference: l.pms_job_reference != null ? String(l.pms_job_reference) : null,
        externalRateId: l.external_rate_id != null ? String(l.external_rate_id) : null,
        pushedAtMs: l.pushed_at != null ? Date.parse(String(l.pushed_at)) : NaN,
      });
    } else if (l.status === "skipped" && isIncidentSkipReason(l.error)) {
      mayHaveOpen = true;
    }
  }

  // The cached targets, and when the grant was last renewed by a person.
  const conn = await readConnection(supabase, hotelId, adapter.pmsType);
  const reauthorizedAtMs = conn?.reauthorized_at ? Date.parse(String(conn.reauthorized_at)) : NaN;

  // What this run did to each cell, and the failures it hit, for push-incidents.ts.
  const run: RunTrack = { cells: new Map(), failures: [] };

  // ── Which cells changed since the last successful push? ───────────────────
  type Candidate = RateCell & { computedAtMs: number; roomType: GuardrailRoomType };
  const candidates: Candidate[] = [];
  // Sent at this price already. Still looked at: its night can have closed in
  // the PMS, and its rate target can have moved since.
  const unchanged: Array<Candidate & { sentRateId: string | null }> = [];
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
    const cell: Candidate = {
      stayDate: String(p.stay_date),
      roomTypeId,
      externalRoomTypeId: rt.ext,
      price,
      computedAtMs: p.computed_at != null ? Date.parse(String(p.computed_at)) : NaN,
      roomType: rt,
    };
    if (lastSent.get(key) === price) {
      skippedUnchanged += 1; // unchanged since last send
      run.cells.set(key, { stayDate: cell.stayDate, roomTypeId, price, state: "landed" });
      unchanged.push({ ...cell, sentRateId: lastSentRateId.get(key) ?? null });
      continue;
    }
    candidates.push(cell);
  }

  // ── Guardrails: the last check before anything leaves ─────────────────────
  const nowIso = new Date().toISOString();
  const manualPrices =
    candidates.length > 0 || unchanged.length > 0
      ? await loadOpenManualPrices(supabase, hotelId, firstDate, lastDate)
      : new Map<string, OpenManualPrice>();
  const zeroBase =
    candidates.length > 0 || unchanged.length > 0
      ? await loadZeroBaseNights(supabase, hotelId, firstDate, lastDate, manualPrices)
      : new Set<string>();
  const freshAfterMs = Date.now() - pushMaxPriceAgeMs();
  const tickEvaluatedAtMs = opts.evaluatedAt ? Date.parse(opts.evaluatedAt) : NaN;
  // Evaluations on record that may vouch for a price, read once and only when needed.
  let coverage: EvaluationCoverage[] | null = null;
  const evaluatedAtFor = async (c: Candidate): Promise<number> => {
    // The tick's own evaluation covered the whole window.
    if (tickEvaluatedAtMs >= freshAfterMs || c.computedAtMs >= freshAfterMs) return tickEvaluatedAtMs;
    coverage ??= await loadEvaluationCoverage(supabase, hotelId, freshAfterMs);
    // Only a run that priced this night vouches for it: a manual price save
    // evaluates just the nights up to the one it changed.
    let best = tickEvaluatedAtMs;
    for (const e of coverage) {
      if (c.stayDate < e.firstStayDate || c.stayDate > e.lastStayDate) continue;
      if (!(best >= e.evaluatedAtMs)) best = e.evaluatedAtMs;
    }
    return best;
  };
  // Whether a price was priced before the manual price on its night was set:
  // neither its own row nor any evaluation that priced the night is as new.
  const pricedBeforeManual = async (c: Candidate, manual: OpenManualPrice): Promise<boolean> => {
    if (!(manual.setAtMs > Math.max(finiteOr(c.computedAtMs), finiteOr(tickEvaluatedAtMs)))) return false;
    coverage ??= await loadEvaluationCoverage(supabase, hotelId, freshAfterMs);
    return !coverage.some(
      (e) => e.evaluatedAtMs >= manual.setAtMs && c.stayDate >= e.firstStayDate && c.stayDate <= e.lastStayDate,
    );
  };

  const guardrailRows: Record<string, unknown>[] = [];
  // Retargeted cells a guardrail holds, found after the first write.
  const lateGuardrailRows: Record<string, unknown>[] = [];
  const guardrails: Partial<Record<GuardrailCode, number>> = {};
  let skippedGuardrail = 0;
  /** Held back with a code: recorded, never sent. True when the cell was held. */
  const holdBack = async (c: Candidate, rows: Record<string, unknown>[]): Promise<boolean> => {
    const key = `${c.stayDate}|${c.roomTypeId}`;
    const code = checkPushGuardrails({
      stayDate: c.stayDate,
      price: c.price,
      roomType: c.roomType,
      firstDate,
      lastDate,
      zeroBase: zeroBase.has(key),
      manualPrice: manualPrices.get(key)?.price ?? null,
      acceptsZeroRate: adapter.acceptsZeroRate === true,
      computedAtMs: c.computedAtMs,
      evaluatedAtMs: await evaluatedAtFor(c),
      freshAfterMs,
    });
    if (!code) return false;
    const cell = cellOf(c);
    skippedGuardrail += 1;
    guardrails[code] = (guardrails[code] ?? 0) + 1;
    const failure = classifyPushFailure({ pms: adapter.pmsType, phase: "guardrail", message: code });
    run.cells.set(key, { ...cellRef(cell), state: "failing", failure });
    const row = skippedLedgerRow(hotelId, adapter.pmsType, cell, code, priorRow.get(key), nowIso);
    if (row) rows.push(row);
    run.failures.push(skipFailure(cell, code, failure, nowIso, row == null));
    return true;
  };

  const changed: RateCell[] = [];
  // Failed cells not sent this run: a critical cause is holding them, or they
  // used their tries at this price. Both wait a day unless the target moves.
  const sittingOut: Array<{ cell: RateCell; failed: FailedCell; verdict: "held" | "exhausted" }> = [];
  // Never sent to, and this tick's base read did not happen: see holdNeverPushed.
  let awaitingBaseRead = 0;
  // Priced before the manual price on its night was set: see the header.
  let awaitingEvaluation = 0;
  for (const c of candidates) {
    const key = `${c.stayDate}|${c.roomTypeId}`;
    const cell = cellOf(c);
    if (await holdBack(c, guardrailRows)) continue;
    const manual = manualPrices.get(key);
    if (manual && (await pricedBeforeManual(c, manual))) {
      awaitingEvaluation += 1;
      run.cells.set(key, { ...cellRef(cell), state: "waiting" });
      continue;
    }
    const failed = lastFailed.get(key);
    if (failed && failed.price === c.price) {
      const failure = ledgerFailure(adapter.pmsType, failed);
      const verdict = retryDecision({ failure, attempts: failed.attempts, lastAttemptAtMs: failed.pushedAtMs, nowMs, reauthorizedAtMs });
      if (verdict !== "retry") {
        sittingOut.push({ cell, failed, verdict });
        run.cells.set(key, { ...cellRef(cell), state: "failing", failure });
        continue;
      }
    }
    if (opts.holdNeverPushed && ledgerRowNeverSent(priorRow.get(key))) {
      awaitingBaseRead += 1;
      run.cells.set(key, { ...cellRef(cell), state: "waiting" });
      continue;
    }
    changed.push(cell);
  }
  // A sent night the PMS now has at 0 with nobody's typed price on it: MAYA's
  // last rate is still there, and the engine no longer prices the night. Held
  // and filed like any zero-base cell, so admins see the night.
  const stillSent: typeof unchanged = [];
  for (const u of unchanged) {
    if (zeroBase.has(`${u.stayDate}|${u.roomTypeId}`) && (await holdBack(u, guardrailRows))) {
      skippedUnchanged -= 1;
      continue;
    }
    stillSent.push(u);
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
  let changedInPms = 0;
  const extras = () => ({
    ...(skippedHeld > 0 ? { skippedHeld } : {}),
    ...(awaitingBaseRead > 0 ? { awaitingBaseRead } : {}),
    ...(awaitingEvaluation > 0 ? { awaitingEvaluation } : {}),
    ...(changedInPms > 0 ? { changedInPms } : {}),
  });

  // Held-back cells are recorded before anything is sent. A ledger that
  // cannot take these will not take the sends either.
  const guardrailWrite = await writeLedgerRows(supabase, guardrailRows);
  if (guardrailWrite) {
    logLedgerWriteFailed(hotelId, adapter.pmsType, "guardrail_skips", guardrailWrite, 0);
    return {
      ...summary,
      ...extras(),
      ...(changed.length > 0 ? { deferred: changed.length } : {}),
      ledgerWriteFailed: { unrecorded: 0, error: guardrailWrite },
    };
  }

  // ── Resolve rate targets (cached on the connection) ───────────────────────
  let targets: RateTargetMap = {};
  if (!opts.refreshTargets && conn?.push_rate_targets && typeof conn.push_rate_targets === "object") {
    targets = conn.push_rate_targets as RateTargetMap;
  }
  // Coverage, not age, is what tells us the cache is out of date: a room type
  // added in the PMS after the map was written is simply absent from it, and a
  // non-empty map would otherwise never be re-resolved. A sent cell whose rate
  // is not the one the map names went to a target that has since moved (or to
  // a package, before targets were base rates only), and is checked too.
  let usingCache = Object.keys(targets).length > 0;
  const retarget = stillSent.filter((u) => u.sentRateId != null && targets[u.externalRoomTypeId] !== u.sentRateId);
  if (changed.length > 0 || retarget.length > 0) {
    const uncovered = changed.some((c) => !targets[c.externalRoomTypeId]);
    if (!usingCache || uncovered || retarget.length > 0) {
      // A room type with only derived rate plans can never be covered, so this
      // re-resolve then runs on every tick — a throwing catalog read must not take
      // down the cells the cached map still targets.
      let resolved: RateTargetMap = {};
      try {
        resolved = await adapter.resolveRateTargets({ today: firstDate, lastNight: lastDate, deadlineAt: opts.deadlineAt });
      } catch (e) {
        if (!usingCache && changed.length > 0) throw e;
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
  }

  // Why a room type has no target, as far as this tick's catalog reads can
  // tell. An adapter that can say, and says nothing, had no good read.
  const targetGap = (ext: string): TargetGap | null =>
    adapter.missingTargetReason ? (adapter.missingTargetReason(ext) ?? "catalog_unavailable") : null;
  if (Object.keys(targets).length === 0 && changed.length > 0) {
    // Nothing to send to. When the catalog listed these room types, that is
    // the finding (no base rate, only derived rates) and it is recorded and
    // filed below like any other cell without a target. When nothing was
    // learned, it is a hiccup and the next tick asks again.
    const learned = changed.some((c) => {
      const gap = targetGap(c.externalRoomTypeId);
      return gap != null && gap !== "catalog_unavailable";
    });
    if (!learned) return { pushed: false, reason: "no_rate_targets" };
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

  // A sent cell whose room type now maps to another rate goes out again at
  // the same price, to that rate. One whose room type has no target at all is
  // filed as such, once the catalog says why; MAYA's price stays where it
  // went, and the night stays counted as pushed.
  const retargetSkips: RateCell[] = [];
  for (const u of retarget) {
    const rateId = targets[u.externalRoomTypeId];
    if (rateId === u.sentRateId) continue;
    if (!rateId) {
      const gap = targetGap(u.externalRoomTypeId);
      if (gap == null || gap === "catalog_unavailable") continue;
      retargetSkips.push(cellOf(u));
    } else if (!(await holdBack(u, lateGuardrailRows))) {
      changed.push(cellOf(u));
      requeued += 1;
    }
    summary.skippedUnchanged -= 1;
  }
  if (requeued > 0) {
    // Nearest nights first, as the published rows were read.
    changed.sort((a, b) =>
      a.stayDate < b.stayDate ? -1 : a.stayDate > b.stayDate ? 1 : a.roomTypeId < b.roomTypeId ? -1 : a.roomTypeId > b.roomTypeId ? 1 : 0,
    );
  }
  summary.skippedGuardrail = skippedGuardrail;
  if (skippedGuardrail > 0) Object.assign(summary, { guardrails });

  // Attach rate ids; separate cells with no target
  let withTarget: Array<RateCell & { externalRateId: string }> = [];
  const noTargetRows: Record<string, unknown>[] = [];
  let skippedNoTarget = 0;
  for (const c of [...changed, ...retargetSkips]) {
    const rateId = targets[c.externalRoomTypeId];
    const key = `${c.stayDate}|${c.roomTypeId}`;
    if (rateId) {
      withTarget.push({ ...c, externalRateId: rateId });
      // Until the PMS answers for it.
      run.cells.set(key, { ...cellRef(c), state: "waiting" });
      continue;
    }
    skippedNoTarget += 1;
    const gap = targetGap(c.externalRoomTypeId);
    const prior = priorRow.get(key);
    if (gap === "catalog_unavailable" && prior?.status === "skipped" && prior.error === NO_RATE_TARGET_REASON) {
      // This tick's catalog read taught nothing, and an earlier one already
      // said why the room type has no target. That finding stands, and so
      // does its incident: filed as an outage, a missing base rate would show
      // the owner as fixed until the next good read, and nothing reopened it.
      run.cells.set(key, { ...cellRef(c), state: "waiting" });
      continue;
    }
    const failure = classifyPushFailure({
      pms: adapter.pmsType,
      phase: "guardrail",
      message: NO_RATE_TARGET_REASON,
      targetGap: gap,
    });
    run.cells.set(key, { ...cellRef(c), state: "failing", failure });
    const row = skippedLedgerRow(hotelId, adapter.pmsType, c, NO_RATE_TARGET_REASON, prior, nowIso);
    if (row) noTargetRows.push(row);
    run.failures.push(skipFailure(c, NO_RATE_TARGET_REASON, failure, nowIso, row == null));
  }
  summary.skippedNoTarget = skippedNoTarget;

  // Retargeted cells a guardrail held, with the cells that have no target.
  const noTargetWrite = await writeLedgerRows(supabase, [...lateGuardrailRows, ...noTargetRows]);
  if (noTargetWrite) {
    logLedgerWriteFailed(hotelId, adapter.pmsType, "no_target_skips", noTargetWrite, 0);
    return {
      ...summary,
      ...extras(),
      ...(withTarget.length > 0 ? { deferred: withTarget.length } : {}),
      ledgerWriteFailed: { unrecorded: 0, error: noTargetWrite },
    };
  }

  // A new price for a night MAYA has sent to writes over whatever the PMS has
  // there now, which may be a rate the hotel changed since the last read.
  if (opts.readBeforeResend && withTarget.some((c) => priorRow.get(`${c.stayDate}|${c.roomTypeId}`)?.status === "sent")) {
    const moved = await opts.readBeforeResend();
    if (moved && moved.size > 0) {
      withTarget = withTarget.filter((c) => {
        if (!moved.has(`${c.stayDate}|${c.roomTypeId}`)) return true;
        changedInPms += 1;
        return false;
      });
    }
  }

  // ── Push, recorded before it goes and again once the PMS answers ──────────
  // In batches, nearest nights first, so a large first push stops at the
  // caller's deadline instead of running past the end of its invocation.
  const results: CellPushResult[] = [];
  let deferred = 0;
  let sent = 0;
  let failed = 0;
  let staleTargets = false;
  let revoked: string | null = null;
  let ledgerWriteFailed: { unrecorded: number; error: string } | undefined;
  for (let i = 0; i < withTarget.length; i += PUSH_BATCH_CELLS) {
    if (opts.deadlineAt != null && Date.now() > opts.deadlineAt) {
      deferred += withTarget.length - i;
      break;
    }
    const batch = withTarget.slice(i, i + PUSH_BATCH_CELLS);
    // On record before it goes: a run that dies mid-send, or an outcome write
    // that fails, still leaves the night marked as sent to, so the base rate
    // calendar never reads MAYA's rate back as the hotel's own.
    const pendingAt = new Date().toISOString();
    const pendingError = await writeLedgerRows(
      supabase,
      batch.map((c) => pendingLedgerRow(hotelId, adapter.pmsType, c, lastFailed, pendingAt)),
    );
    if (pendingError) {
      deferred += withTarget.length - i;
      ledgerWriteFailed = { unrecorded: 0, error: pendingError };
      logLedgerWriteFailed(hotelId, adapter.pmsType, "pending", pendingError, 0, withTarget.length - i);
      break;
    }
    const answered = await adapter.pushCells(batch, { deadlineAt: opts.deadlineAt });
    // Not started (the deadline): left marked as in progress, and sent next tick.
    const attempted = answered.filter((r) => !r.deferred);
    deferred += answered.length - attempted.length;
    sent += attempted.filter((r) => r.ok).length;
    failed += attempted.filter((r) => !r.ok).length;

    const batchAt = new Date().toISOString();
    const rows = attempted.map((r) => attemptLedgerRow(hotelId, adapter.pmsType, r, lastFailed, batchAt));
    const error = await writeLedgerRows(supabase, rows);
    if (error) {
      // These cells are in the PMS (or refused by it) with only the
      // in-progress marker on record. Sending more would only widen that gap;
      // the next tick re-sends them.
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
        freshCredentialsRefused: r.freshCredentialsRefused === true,
      });
      if (failure.dropTargets) staleTargets = true;
      if (failure.cause === "auth_revoked" && adapter.pmsType !== "think" && revoked == null) {
        revoked = message ?? "rate write refused the grant";
      }
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

  // A grant the PMS says is gone (auth_revoked: its not-connected wording, or
  // new credentials refused again) is a disconnected connection: the PMS tab
  // says so, and connection health raises the alert the incident leaves to it.
  // Any other refusal of a write holds its cells and leaves the connection up,
  // reads and all.
  if (revoked != null) {
    await markConnectionDisconnected(supabase, hotelId, adapter.pmsType, `rate push: ${String(revoked).slice(0, 300)}`);
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
  const jobConfirmed =
    results.length > 0 || earlier.size > 0
      ? await reconcileJobOutcomes(supabase, hotelId, adapter, results, nowIso, earlier, opts.deadlineAt, {
          run,
          sentAttempts,
        })
      : null;

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
        deadlineAt: opts.deadlineAt,
      });

  return {
    ...summary,
    sent,
    failed,
    ...extras(),
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

/** Just the cell, without whatever the run carried alongside it. */
function cellOf(c: RateCell): RateCell {
  return { stayDate: c.stayDate, roomTypeId: c.roomTypeId, externalRoomTypeId: c.externalRoomTypeId, price: c.price };
}

/** The hotel's connection row for this PMS: cached targets and the last re-authorization, when the column exists. */
async function readConnection(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
): Promise<{ id?: unknown; push_rate_targets?: unknown; reauthorized_at?: unknown } | null> {
  const read = (columns: string) =>
    supabase.from("pms_connections").select(columns).eq("hotel_id", hotelId).eq("pms_type", pmsType).maybeSingle();
  let { data, error } = await read("id, push_rate_targets, reauthorized_at");
  // Before the push guardrails migration: no reconnect to end a hold early.
  if (error && isMissingColumnError(error)) ({ data, error } = await read("id, push_rate_targets"));
  return (data as { id?: unknown; push_rate_targets?: unknown; reauthorized_at?: unknown } | null) ?? null;
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

/** A held-back cell as a failure; `ongoing` when its ledger row already said this (see RunFailure). */
function skipFailure(c: RateCell, reason: string, failure: PushFailure, at: string, ongoing: boolean): RunFailure {
  return {
    ...cellRef(c),
    at,
    phase: "guardrail",
    outcome: "skipped",
    httpStatus: null,
    message: reason,
    jobReference: null,
    failure,
    ...(ongoing ? { ongoing: true } : {}),
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
    const error = await upsertLedger(supabase, rows.slice(i, i + CHUNK));
    if (error) return String(error.message ?? "rate_updates write failed").slice(0, 300);
  }
  return null;
}

/** Ledger columns the push guardrails migration adds; a write to a database without them leaves them out. */
const LEDGER_MIGRATED_COLUMNS = ["sent_price", "confirmed_at", "pms_edited_at"] as const;

/**
 * One rate_updates upsert. Every row in it carries the same columns: PostgREST
 * writes null into a column one row of a chunk leaves out and another has.
 * Before the push guardrails migration there is no sent_price, confirmed_at
 * or pms_edited_at, and the rows go again without them.
 */
export async function upsertLedger(
  supabase: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<{ message: string } | null> {
  const write = (chunk: Record<string, unknown>[]) =>
    supabase.from("rate_updates").upsert(chunk, { onConflict: "hotel_id,room_type_id,stay_date" });
  let { error } = await write(rows);
  if (error && isMissingColumnError(error) && rows.some((r) => LEDGER_MIGRATED_COLUMNS.some((col) => col in r))) {
    const withoutMigrated = rows.map((r) => {
      const copy = { ...r };
      for (const col of LEDGER_MIGRATED_COLUMNS) delete copy[col];
      return copy;
    });
    ({ error } = await write(withoutMigrated));
  }
  return error ? { message: String(error.message) } : null;
}

/**
 * A cell's row while its send is under way: failed, with the in-progress
 * message, so that if nothing overwrites it the next tick sends it again and
 * the base rate calendar treats the night as sent to meanwhile. Its tries are
 * the ones already on record at this price; the send's own outcome adds one.
 * Whether an earlier price is still in the PMS is not known until it answers,
 * so sent_price is cleared.
 */
function pendingLedgerRow(
  hotelId: string,
  pmsType: string,
  c: RateCell & { externalRateId: string },
  lastFailed: Map<string, { price: number; attempts: number }>,
  pushedAt: string,
): Record<string, unknown> {
  const prior = lastFailed.get(`${c.stayDate}|${c.roomTypeId}`);
  return {
    hotel_id: hotelId,
    pms_type: pmsType,
    room_type_id: c.roomTypeId,
    external_room_type_id: c.externalRoomTypeId,
    stay_date: c.stayDate,
    price: c.price,
    external_rate_id: c.externalRateId,
    status: "failed",
    pms_job_reference: null,
    error: SEND_IN_PROGRESS_MESSAGE,
    attempts: prior && prior.price === c.price ? prior.attempts : 0,
    pushed_at: pushedAt,
    sent_price: null,
    confirmed_at: null,
    pms_edited_at: null,
  };
}

/**
 * A sent or failed cell's ledger row. sent_price is the price a send put in
 * the PMS, and null after a refusal: nothing on record says what is there.
 */
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
    sent_price: r.ok ? r.cell.price : null,
    // A new send is settled only once its job is confirmed (reconcileJobOutcomes).
    confirmed_at: null,
    pms_edited_at: null,
  };
}

/**
 * A held-back cell's ledger row, or null when the row already says exactly
 * this. `attempts` keeps saying whether MAYA ever sent to the night (see
 * push-guardrails.ts): 0 while it never has, 1 once a send or failed send
 * sits underneath. The job reference, rate id and sent_price of the row
 * underneath are left as they were, not blanked: they are what shows a send
 * happened, and what it left in the PMS.
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
    status: "skipped",
    error: reason,
    attempts,
    pushed_at: pushedAt,
  };
}

/** An open manual price on a night of the window. */
type OpenManualPrice = { price: number; setAtMs: number };

/**
 * The window's open manual prices, by `stay_date|room_type_id`. Throws on a
 * failed read: a manual price decides what a night may be sent at. A
 * database without the table has none.
 */
async function loadOpenManualPrices(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<Map<string, OpenManualPrice>> {
  const out = new Map<string, OpenManualPrice>();
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    rows = await fetchAll(() =>
      supabase
        .from("manual_price")
        .select("stay_date, room_type_id, price, set_at")
        .eq("hotel_id", hotelId)
        .gte("stay_date", firstDate)
        .lte("stay_date", lastDate)
        .is("cleared_at", null)
        .order("stay_date", { ascending: true })
        .order("room_type_id", { ascending: true }),
    );
  } catch (e) {
    if (isMissingRelationError(e)) return out;
    throw e;
  }
  for (const m of rows) {
    if (!m.room_type_id) continue;
    out.set(`${m.stay_date}|${m.room_type_id}`, {
      price: m.price != null ? Number(m.price) : NaN,
      setAtMs: m.set_at != null ? Date.parse(String(m.set_at)) : NaN,
    });
  }
  return out;
}

/** A timestamp, or -Infinity when there is none: missing evidence is never newer than anything. */
function finiteOr(ms: number): number {
  return Number.isFinite(ms) ? ms : -Infinity;
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
  manualPrices: Map<string, OpenManualPrice>,
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
  for (const key of manualPrices.keys()) zero.delete(key);
  return zero;
}

/** A logged evaluation that may vouch for prices: when it ran and the nights it priced. */
type EvaluationCoverage = { evaluatedAtMs: number; firstStayDate: string; lastStayDate: string };

/** Newest logged evaluations looked at. A few hours of ticks and manual saves. */
const EVALUATION_COVERAGE_ROWS = 50;

/**
 * The hotel's logged evaluations newer than `freshAfterMs`, with the nights
 * each priced. A row without its nights (written before they were logged)
 * vouches for none. Empty when none can be read: fails closed, so prices
 * whose own timestamp is old are held back as stale.
 */
async function loadEvaluationCoverage(
  supabase: SupabaseClient,
  hotelId: string,
  freshAfterMs: number,
): Promise<EvaluationCoverage[]> {
  const { data, error } = await supabase
    .from("evaluation_run_log")
    .select("evaluated_at, first_stay_date, last_stay_date")
    .eq("hotel_id", hotelId)
    .gte("evaluated_at", new Date(freshAfterMs).toISOString())
    .order("evaluated_at", { ascending: false })
    .range(0, EVALUATION_COVERAGE_ROWS - 1);
  if (error) {
    console.error(
      JSON.stringify({ fn: "pushRatesForHotel", hotelId, step: "last_evaluation", error: String(error.message).slice(0, 300) }),
    );
    return [];
  }
  const out: EvaluationCoverage[] = [];
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const evaluatedAtMs = r.evaluated_at != null ? Date.parse(String(r.evaluated_at)) : NaN;
    if (!Number.isFinite(evaluatedAtMs) || r.first_stay_date == null || r.last_stay_date == null) continue;
    out.push({
      evaluatedAtMs,
      firstStayDate: String(r.first_stay_date).slice(0, 10),
      lastStayDate: String(r.last_stay_date).slice(0, 10),
    });
  }
  return out;
}

function logLedgerWriteFailed(
  hotelId: string,
  pmsType: string,
  step: "guardrail_skips" | "no_target_skips" | "pending" | "batch",
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

/**
 * Stamps confirmed_at on the sent rows of jobs the vendor reported as
 * applied. A send is settled once stamped, here or by the base rate refresh
 * finding its price in the PMS (pms-edits.ts), and only a settled send lets
 * the refresh take a different rate in the PMS as the hotel's own change.
 * True when written, or when there is no column to write to yet; false
 * leaves the jobs undecided so the next tick asks again.
 */
async function stampConfirmed(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  refs: string[],
  at: string,
): Promise<boolean> {
  for (let i = 0; i < refs.length; i += 100) {
    const { error } = await supabase
      .from("rate_updates")
      .update({ confirmed_at: at })
      .eq("hotel_id", hotelId)
      .eq("pms_type", pmsType)
      .eq("status", "sent")
      .in("pms_job_reference", refs.slice(i, i + 100))
      .is("confirmed_at", null);
    if (!error) continue;
    if (isMissingColumnError(error)) return true;
    console.error(
      JSON.stringify({
        fn: "reconcileJobOutcomes",
        hotelId,
        pmsType,
        jobs: refs.length,
        error: String(error.message).slice(0, 300),
        event: "rate_job_confirm_stamp_failed",
      }),
    );
    return false;
  }
  return true;
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
 * A job the vendor still lists as unfinished RECONCILE_UNCONFIRMED_AFTER_MS
 * after it went out is written back the same way, as JOB_UNCONFIRMED_MESSAGE:
 * jobs settle in seconds, and a stuck one would otherwise leave the cell
 * looking live for good. A job missing from the list is not: a new isolate
 * has forgotten which jobs it already saw confirmed, and a confirmed job
 * drops off the vendor's recent list, so absence proves nothing. That one is
 * logged and left as sent, as before.
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
    const confirmedRefs: string[] = [];
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
          // The job never applied, and what was in the PMS before it is not on record.
          sent_price: null,
          confirmed_at: null,
          pms_edited_at: null,
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
        // tick, for up to RECONCILE_LOOKBACK_MS after it was sent.
        const sentAt = earlier.get(jobRef)?.pushedAt;
        if (sentAt == null || Date.now() - sentAt <= RECONCILE_UNCONFIRMED_AFTER_MS) continue;
        if (outcome) {
          unconfirmed += cells.length;
          correct(jobRef, cells, JOB_UNCONFIRMED_MESSAGE, "unconfirmed");
        } else if (!loggedUnconfirmed.has(jobRef)) {
          if (loggedUnconfirmed.size > 5000) loggedUnconfirmed.clear();
          loggedUnconfirmed.add(jobRef);
          console.error(
            JSON.stringify({
              fn: "reconcileJobOutcomes",
              hotelId,
              pmsType: adapter.pmsType,
              jobReference: jobRef,
              cells: cells.length,
              event: "rate_job_unconfirmed",
            }),
          );
        }
        continue;
      }
      if (outcome.ok) {
        confirmedRefs.push(jobRef);
        ok += cells.length;
        continue;
      }
      // A rejected job only counts as decided once its cells are stored as
      // failed. If that write fails, the ledger still says sent, and asking
      // again next tick is what gets the correction written.
      rejected += cells.length;
      correct(jobRef, cells, (outcome.message ?? "rate job rejected").slice(0, 300), "rejected");
    }

    // Decided once the ledger says so: a confirmed job whose rows could not be
    // stamped is asked about again next tick.
    if (confirmedRefs.length > 0 && (await stampConfirmed(supabase, hotelId, adapter.pmsType, confirmedRefs, nowIso))) {
      for (const ref of confirmedRefs) markDecided(hotelId, adapter.pmsType, ref);
    }

    let dropTargets = false;
    if (corrections.length > 0) {
      const correctionError = await upsertLedger(supabase, corrections);
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
