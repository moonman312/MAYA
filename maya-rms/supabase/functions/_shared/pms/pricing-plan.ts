/**
 * Which nights one scheduled tick prices (Jake, 2026-09-17 and 2026-09-28).
 *
 *   * The daily pass: once a hotel day, on the first cycle after the date
 *     changes at the property, every night of the window (396 by default) is
 *     priced. Not at a fixed clock time: a tick compares the hotel's date with
 *     the date the last pass was for, so daylight-saving gaps and repeated
 *     hours, retries after a failed read, and a hotel connected mid-day all
 *     come to the same thing. The pass goes in chunks, nearest nights first,
 *     and remembers where it got to (hotel_pricing_state.pass_cursor), so a
 *     crash or a busy tick carries on from there.
 *   * Touched nights: every tick prices the nights whose inputs changed since
 *     they were last priced, which database triggers record
 *     (pricing_dirty_nights): bookings made, changed, moved or cancelled,
 *     typed prices, rooms out of service, base rates, answers to the
 *     three-changes alert. Edits that can move any night (rules, room types,
 *     closed periods, flags on past dates, the time zone) start a new pass.
 *   * Follow-ups: a night where a run changed a rule's state (a change made,
 *     taken off or restated, a ladder rule switched) is priced again next
 *     tick, until a run changes nothing there, since the next run can decide
 *     differently on it (CadenceReport.changedNights).
 *   * Momentum: a night whose Booking Speed reading leans on the nights
 *     around it (usesMomentum) is priced again when a booking lands within
 *     10 nights of it.
 *
 * Time alone never moves a price during the day (Jake, 2026-09-28): pickup
 * count windows and rule waits count whole hotel days, cut rules judge
 * complete days ending yesterday, raise rules count today so far, and
 * everything else reads the hotel's date. So the daily pass plus these
 * nights gives the prices pricing every night every tick would. The pricing
 * cadence tests hold the two side by side.
 *
 * MAYA_PRICING_CADENCE=every_tick prices the whole window every tick, as
 * before (the rollback switch; the marks are cleared by those runs).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mwsEnv } from "../mews/env.ts";
import { addCalendarDays } from "../engine/timezone.ts";

export type PricingCadence = "daily" | "every_tick";

/** How nights are chosen, from MAYA_PRICING_CADENCE: "daily" unless it says "every_tick". */
export function pricingCadence(raw: string | undefined = mwsEnv("MAYA_PRICING_CADENCE")): PricingCadence {
  return String(raw ?? "").trim().toLowerCase() === "every_tick" ? "every_tick" : "daily";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Math.floor(Number(String(raw ?? "").trim()));
  return raw !== undefined && String(raw).trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export type CadenceConfig = {
  /** Nights of the daily pass per tick (MAYA_PASS_CHUNK_NIGHTS): three chunks for 396 nights. */
  chunkNights: number;
  /** Most nights one run prices, touched and pass together (MAYA_RUN_MAX_NIGHTS). */
  runMaxNights: number;
  /** Daily pass nights across one invocation, all hotels together (MAYA_TICK_PASS_NIGHTS). */
  tickPassNights: number;
  /** No pass chunk starts with less than this before the evaluation cut-off (MAYA_PASS_MIN_TIME_MS). */
  passMinTimeMs: number;
  /** A pass this long behind the hotel's midnight counts as stuck for the push (MAYA_PASS_MAX_LAG_MINUTES). */
  passMaxLagMinutes: number;
};

export function cadenceConfigFromEnv(): CadenceConfig {
  return {
    chunkNights: positiveInt(mwsEnv("MAYA_PASS_CHUNK_NIGHTS"), 132),
    runMaxNights: positiveInt(mwsEnv("MAYA_RUN_MAX_NIGHTS"), 264),
    tickPassNights: positiveInt(mwsEnv("MAYA_TICK_PASS_NIGHTS"), 1500),
    passMinTimeMs: positiveInt(mwsEnv("MAYA_PASS_MIN_TIME_MS"), 60_000),
    passMaxLagMinutes: positiveInt(mwsEnv("MAYA_PASS_MAX_LAG_MINUTES"), 120),
  };
}

/** A hotel's daily pass, as hotel_pricing_state keeps it. */
export type PricingState = {
  pass_date: string | null;
  pass_cursor: string | null;
  pass_started_at: string | null;
  pass_completed_at: string | null;
  pass_reason: string | null;
  pass_horizon_days: number | null;
  pass_reprice_seq: number | null;
  full_reprice_seq: number | null;
  last_ok_run_at: string | null;
  momentum_nights: string[];
};

export type DirtyNight = { stay_date: string; mark_seq: number; first_marked_at: string; reasons: string[] };

/** What pricing_work returns for one hotel and window. */
export type PricingWork = {
  dirty: DirtyNight[];
  state: PricingState | null;
};

export type PassReason = "first_run" | "new_day" | "owner_edit" | "horizon";

/** The chunk of the daily pass a run takes, as pricing_run_done records it. */
export type PassStep = {
  date: string;
  /** A new pass starts with this run. */
  start: boolean;
  /** The cursor the run read (the chunk's first night). */
  from: string;
  /** Where the next chunk starts; null when this one reaches the last night. */
  next: string | null;
  horizon: number;
  reason: PassReason | null;
  /** full_reprice_seq as read: the owner edits this pass takes in. */
  repriceSeq: number | null;
};

export type PricingPlan = {
  /** Every night to price, sorted. */
  nights: string[];
  /** The marks read for nights in `nights`: cleared by pricing_run_done if not marked again. */
  dirtyRead: { stay_date: string; mark_seq: number }[];
  /** The pass chunk this run takes, if any. */
  pass: PassStep | null;
  /** Momentum nights left out by the run cap: marked again for the next tick. */
  deferred: string[];
  /** Whether the daily pass still has nights to price after this run. */
  passWorkLeft: boolean;
  /** A new pass is due and this run did not start it (no time, or over the invocation's budget). */
  passDue: PassReason | null;
  counts: { touched: number; momentum: number; chunk: number };
};

/** The number of whole days from `a` to `b` (YYYY-MM-DD). */
function daysApart(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Why a new pass starts this tick, or null to carry on the current one. */
export function passReason(state: PricingState | null, today: string, horizonDays: number): PassReason | null {
  if (!state || !state.pass_date) return "first_run";
  // Normally later; earlier after the time zone moved the hotel west.
  if (state.pass_date !== today) return "new_day";
  if ((state.full_reprice_seq ?? 0) > (state.pass_reprice_seq ?? 0)) return "owner_edit";
  if ((state.pass_horizon_days ?? 0) < horizonDays) return "horizon";
  return null;
}

/**
 * The nights one run prices, from the work list and the time and budget it
 * has. Pure: the tick reads the list (loadPricingWork), prices the plan's
 * nights, and reports back (recordPricingRun).
 *
 * Touched nights (marked, and the momentum nights near a booking) always
 * go first, nearest first, up to runMaxNights; the pass
 * chunk takes what room is left, and none when `passAllowed` is false or
 * `passBudget` is spent. A momentum night the cap leaves out is marked again
 * (deferred), since the booking that moved it is cleared with its own night.
 */
export function planPricingRun(input: {
  work: PricingWork;
  today: string;
  lastNight: string;
  horizonDays: number;
  config: Pick<CadenceConfig, "chunkNights" | "runMaxNights">;
  /** Time and the invocation's budget allow a pass chunk. */
  passAllowed: boolean;
  /** Pass nights this run may take (what is left of the invocation's budget). */
  passBudget: number;
}): PricingPlan {
  const { work, today, lastNight } = input;
  const inWindow = (d: string) => d >= today && d <= lastNight;

  const dirty = work.dirty.filter((d) => inWindow(d.stay_date));
  const dirtyNights = new Set(dirty.map((d) => d.stay_date));
  const bookingNights = new Set(dirty.filter((d) => d.reasons.includes("booking")).map((d) => d.stay_date));

  // A booking moves the reading of every momentum night within 10 nights of it.
  const momentumOf = new Map<string, string[]>();
  const momentum = new Set<string>();
  const momentumNights = (work.state?.momentum_nights ?? []).filter(inWindow);
  if (bookingNights.size > 0 && momentumNights.length > 0) {
    for (const m of momentumNights) {
      for (const b of bookingNights) {
        if (Math.abs(daysApart(b, m)) <= 10) {
          momentum.add(m);
          const list = momentumOf.get(b) ?? [];
          list.push(m);
          momentumOf.set(b, list);
        }
      }
    }
  }

  const touched = [...new Set([...dirtyNights, ...momentum])].sort();
  const cap = Math.max(1, input.config.runMaxNights);
  const taken = touched.slice(0, cap);
  const takenSet = new Set(taken);
  // Left out by the cap: marks stay for the next tick on their own, a
  // momentum night has no mark of its own. Its booking's night is
  // cleared if this run prices it, so the momentum night is marked again.
  const deferred = new Set<string>();
  for (const [b, list] of momentumOf) {
    if (!takenSet.has(b)) continue;
    for (const m of list) if (!takenSet.has(m)) deferred.add(m);
  }

  // The daily pass.
  const reason = passReason(work.state, today, input.horizonDays);
  const cursor = reason ? today : work.state?.pass_cursor ?? null;
  const passOpen = cursor !== null && cursor <= lastNight;
  let pass: PassStep | null = null;
  let passWorkLeft = passOpen;
  let chunkCount = 0;
  const room = Math.min(input.config.chunkNights, cap - taken.length, Math.max(0, Math.floor(input.passBudget)));
  if (passOpen && input.passAllowed && room > 0) {
    const from = cursor < today ? today : cursor;
    const chunkLast = [addCalendarDays(from, room - 1), lastNight].sort()[0];
    const next = chunkLast >= lastNight ? null : addCalendarDays(chunkLast, 1);
    pass = {
      date: today,
      start: reason !== null,
      from: reason !== null ? today : (work.state?.pass_cursor as string),
      next,
      horizon: input.horizonDays,
      reason,
      repriceSeq: reason !== null ? (work.state?.full_reprice_seq ?? null) : (work.state?.pass_reprice_seq ?? null),
    };
    for (let d = from; d <= chunkLast; d = addCalendarDays(d, 1)) {
      takenSet.add(d);
      chunkCount++;
    }
    passWorkLeft = next !== null;
  }

  const nights = [...takenSet].sort();
  return {
    nights,
    dirtyRead: dirty.filter((d) => takenSet.has(d.stay_date)).map((d) => ({ stay_date: d.stay_date, mark_seq: d.mark_seq })),
    pass,
    deferred: [...deferred].sort(),
    passWorkLeft,
    passDue: reason !== null && !(pass?.start ?? false) ? reason : null,
    counts: { touched: dirtyNights.size, momentum: momentum.size, chunk: chunkCount },
  };
}

/** Every night of the window, as MAYA_PRICING_CADENCE=every_tick prices it (and the pass it completes). */
export function planWholeWindow(work: PricingWork | null, today: string, lastNight: string, horizonDays: number): PricingPlan {
  const nights: string[] = [];
  for (let d = today; d <= lastNight; d = addCalendarDays(d, 1)) nights.push(d);
  const dirty = (work?.dirty ?? []).filter((d) => d.stay_date >= today && d.stay_date <= lastNight);
  const reason = work ? passReason(work.state, today, horizonDays) : null;
  return {
    nights,
    dirtyRead: dirty.map((d) => ({ stay_date: d.stay_date, mark_seq: d.mark_seq })),
    // The whole window is priced: today's pass is done, whatever it was.
    pass: work
      ? {
          date: today,
          start: true,
          from: today,
          next: null,
          horizon: horizonDays,
          reason: reason ?? "new_day",
          repriceSeq: work.state?.full_reprice_seq ?? null,
        }
      : null,
    deferred: [],
    passWorkLeft: false,
    passDue: null,
    counts: { touched: dirty.length, momentum: 0, chunk: nights.length },
  };
}

function isMissingFunction(error: { code?: string | null; message?: string | null }): boolean {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /could not find the function/i.test(String(error.message ?? ""))
  );
}

/** The cadence migration has not run: callers price the old way. */
export const CADENCE_MISSING = "missing" as const;

let loggedMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetPricingPlanLogOnce(): void {
  loggedMissing = false;
}

function logMissingOnce(fn: string, error: { message?: string | null }): void {
  if (loggedMissing) return;
  loggedMissing = true;
  console.error(
    JSON.stringify({
      fn,
      schema: "pre-migration",
      message:
        "The pricing cadence functions do not exist yet; every tick prices the whole window, capped at 60 nights, as before. Run 99_supabase_migration_pricing_cadence_v1.sql.",
      migration: "99_supabase_migration_pricing_cadence_v1.sql",
      error: error.message ?? "",
    }),
  );
}

function num(v: unknown): number | null {
  return v == null || v === "" ? null : Number(v);
}

/** One call: the hotel's marked nights in the window, and its pass (pricing_work). */
export async function loadPricingWork(
  supabase: SupabaseClient,
  hotelId: string,
  first: string,
  last: string,
): Promise<PricingWork | typeof CADENCE_MISSING> {
  const { data, error } = await supabase.rpc("pricing_work", {
    p_hotel_id: hotelId,
    p_first: first,
    p_last: last,
  });
  if (error) {
    if (isMissingFunction(error)) {
      logMissingOnce("loadPricingWork", error);
      return CADENCE_MISSING;
    }
    throw new Error(`Failed to read the pricing work list: ${error.message}`);
  }
  // pricing_work always answers an object; nothing at all is a database
  // that does not have it.
  if (data == null || typeof data !== "object") {
    logMissingOnce("loadPricingWork", { message: "pricing_work returned nothing" });
    return CADENCE_MISSING;
  }
  const body = data as Record<string, unknown>;
  const s = body.state as Record<string, unknown> | null | undefined;
  return {
    dirty: ((body.dirty ?? []) as Record<string, unknown>[]).map((d) => ({
      stay_date: String(d.stay_date).slice(0, 10),
      mark_seq: Number(d.mark_seq),
      first_marked_at: String(d.first_marked_at),
      reasons: Array.isArray(d.reasons) ? d.reasons.map(String) : [],
    })),
    state: s
      ? {
          pass_date: s.pass_date != null ? String(s.pass_date).slice(0, 10) : null,
          pass_cursor: s.pass_cursor != null ? String(s.pass_cursor).slice(0, 10) : null,
          pass_started_at: s.pass_started_at != null ? String(s.pass_started_at) : null,
          pass_completed_at: s.pass_completed_at != null ? String(s.pass_completed_at) : null,
          pass_reason: s.pass_reason != null ? String(s.pass_reason) : null,
          pass_horizon_days: num(s.pass_horizon_days),
          pass_reprice_seq: num(s.pass_reprice_seq),
          full_reprice_seq: num(s.full_reprice_seq),
          last_ok_run_at: s.last_ok_run_at != null ? String(s.last_ok_run_at) : null,
          momentum_nights: Array.isArray(s.momentum_nights) ? s.momentum_nights.map((d) => String(d).slice(0, 10)) : [],
        }
      : null,
  };
}

/** What a run reports to pricing_run_done. */
export type PricingRunRecord = {
  at: string;
  first: string;
  last: string;
  nights: string[];
  dirty: { stay_date: string; mark_seq: number }[];
  failed: string[];
  /** Nights whose engine state the run changed: priced again next tick (CadenceReport.changedNights). */
  again: string[];
  pass: PassStep | null;
  momentum: string[];
  msPerNight: number | null;
  idle: boolean;
  runId?: string;
};

/** One call, one transaction: clear what was priced, mark the follow-ups, move the pass on (pricing_run_done). */
export async function recordPricingRun(
  supabase: SupabaseClient,
  hotelId: string,
  run: PricingRunRecord,
): Promise<{ cleared: number; kept: number; passMoved: boolean | null } | typeof CADENCE_MISSING> {
  const { data, error } = await supabase.rpc("pricing_run_done", {
    p_hotel_id: hotelId,
    p_run: {
      at: run.at,
      first: run.first,
      last: run.last,
      nights: run.nights,
      dirty: run.dirty,
      failed: run.failed,
      again: run.again,
      pass: run.pass
        ? {
            date: run.pass.date,
            start: run.pass.start,
            from: run.pass.from,
            next: run.pass.next,
            horizon: run.pass.horizon,
            reason: run.pass.reason,
            reprice_seq: run.pass.repriceSeq,
          }
        : null,
      momentum: run.momentum,
      ms_per_night: run.msPerNight,
      idle: run.idle,
      run_id: run.runId ?? null,
    },
  });
  if (error) {
    if (isMissingFunction(error)) {
      logMissingOnce("recordPricingRun", error);
      return CADENCE_MISSING;
    }
    throw new Error(`Failed to record the pricing run: ${error.message}`);
  }
  if (data == null || typeof data !== "object") {
    logMissingOnce("recordPricingRun", { message: "pricing_run_done returned nothing" });
    return CADENCE_MISSING;
  }
  const body = data as Record<string, unknown>;
  return {
    cleared: Number(body.cleared ?? 0),
    kept: Number(body.kept ?? 0),
    passMoved: body.pass_moved == null ? null : Boolean(body.pass_moved),
  };
}

/**
 * Nights the push should not vouch for yet, after this tick: a change to them
 * has waited longer than `maxAgeMs` unpriced, or today's pass has not reached
 * them and the hotel's date changed longer ago than the pass may lag.
 * Everything else was priced on every change it had, so the prices published
 * for it are current however long ago they were computed.
 */
export function unsettledNights(input: {
  work: PricingWork;
  plan: PricingPlan;
  /** The run priced its nights (false: it failed, so none were). */
  priced: boolean;
  nowMs: number;
  maxAgeMs: number;
  today: string;
  lastNight: string;
  /** When the hotel's date changed (its midnight), ms. */
  dayStartedMs: number;
  passMaxLagMs: number;
}): Set<string> {
  const out = new Set<string>();
  const priced = input.priced ? new Set(input.plan.nights) : new Set<string>();
  for (const d of input.work.dirty) {
    if (priced.has(d.stay_date)) continue;
    if (input.nowMs - Date.parse(d.first_marked_at) > input.maxAgeMs) out.add(d.stay_date);
  }
  if (input.nowMs - input.dayStartedMs > input.passMaxLagMs) {
    // Where today's pass stands after this run.
    const state = input.work.state;
    const step = input.priced ? input.plan.pass : null;
    let cursor: string | null;
    if (step) cursor = step.next;
    else if (state?.pass_date === input.today) cursor = state.pass_cursor;
    else cursor = input.today;
    if (cursor !== null) {
      for (let d = cursor; d <= input.lastNight; d = addCalendarDays(d, 1)) if (!priced.has(d)) out.add(d);
    }
  }
  return out;
}
