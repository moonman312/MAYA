/**
 * The part of a scheduled tick after the PMS read: refresh the base rate
 * calendar, evaluate, push. Shared by the Cloudbeds and Think syncs so the
 * order and the dates cannot drift apart between them.
 *
 * One instant per hotel per tick. Its date at the property is the first night
 * of the calendar refresh, of the evaluation (passed as evalTs, so the engine
 * derives the same date from the same timezone) and of the push. Reading the
 * clock separately in each step let a tick that crossed the hotel's midnight
 * refresh one window, price the next and push a night with no fresh base.
 *
 * Nothing is priced or pushed on a failed PMS read. While reads fail, bookings
 * stop arriving, so a "pace is slow" rule could fire a decrease on data that
 * is only stale, and it would go out the moment the connection came back. The
 * next tick reads again and prices then. A read that ran out of budget before
 * covering its window is not a failure: the engine still runs on what arrived,
 * but nothing is pushed until a read covers the window.
 *
 * The refresh also adopts rates the hotel changed in the PMS on nights MAYA
 * had sent to (pms-edits.ts), at the tick's instant, so the evaluation right
 * after publishes them and the push does not write over them. When the
 * refresh did not read the PMS this tick (it runs hourly), the push reads it
 * again before sending a new price to a night it last sent to over the settle
 * window ago, and holds the nights whose rate there moved until the next tick
 * prices them. Not when the refresh's own read of the PMS failed this tick,
 * or found nothing to target: asking again straight away only doubles the
 * calls. The push log says how long the read took (readBeforeResendMs).
 * When the refresh did read the PMS but could not record the changes it
 * found there, the evaluation priced those nights without them, so the push
 * holds them this tick (holdCells) rather than write over them.
 *
 * The base rate refresh has the evaluation cut-off as its deadline: it does
 * not start without a minute to spare, and stops waiting on the PMS past it.
 * Unless the refresh read the PMS this tick, or was not due because a read
 * within the interval did (throttled), the push still sends the nights it has
 * sent to before, but not a night it never has: that first send writes over
 * the hotel's own rate, which must be one MAYA has just read. A refresh that
 * failed, ran out of time, found nothing to target, or could not tell when it
 * last ran and only checked for gaps (covered) holds them.
 *
 * Which nights the evaluation prices is the pricing cadence's call
 * (pricing-plan.ts): the nights whose inputs changed, the nights a run
 * changed a rule's state on, and a chunk of the daily pass, read from the database after the base
 * rate refresh (which can mark nights) and reported back once the engine has
 * priced them. A tick with nothing to price writes its heartbeat and prices
 * nothing. MAYA_PRICING_CADENCE=every_tick prices the whole window, as before;
 * so does a database without the cadence migration, at no more than 60 nights.
 *
 * A run that fails publishes nothing and clears nothing: the engine stops
 * before it publishes when a read it prices from fails (anything but a table,
 * column or function no migration has created yet), its nights stay marked
 * and the pass stays where it was, so the next tick prices them again, and
 * the push holds them meanwhile. Each failed run is counted in the database
 * (noteFailedRun: hotel_pricing_state.failed_runs, back to 0 when a run
 * that priced nights is recorded). Once this tick's run failed and either
 * PRICING_FAILURES_BEFORE_ALERT runs have failed in a row or no run of the
 * hotel has priced anything for PRICING_FAILING_ALERT_AFTER_MS (a tick with
 * nothing to price does not count), the alert channel is told
 * (alertPricingFailing), at most once per raiseAlert's window. The run that
 * prices nights after failed ones closes the story with one recovery line
 * (recoverPricingFailing). The database watchdog (pricing_watchdog,
 * 99_supabase_migration_pricing_watchdog_v1.sql) stands outside this
 * function and says nothing for a hotel while this alert is out and not
 * recovered, so the recovery line is what hands the hotel back to it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CadenceReport, EvaluateOptions } from "../engine/evaluate.ts";
import { isMissingColumnError } from "../engine/snapshots.ts";
import { hotelDayStartIso } from "../engine/timezone.ts";
import { type Alert, raiseAlert, raiseRecovery } from "./alerting.ts";
import { ensureBaseRateCalendar, type EnsureCalendarResult } from "./base-rate-calendar.ts";
import { pmsEditSettleMs } from "./pms-edits.ts";
import {
  CADENCE_MISSING,
  cadenceConfigFromEnv,
  loadPricingWork,
  noteFailedRun,
  planPricingRun,
  planWholeWindow,
  pricingCadence,
  recordPricingRun,
  unsettledNights,
  type CadenceConfig,
  type PricingCadence,
  type PricingPlan,
  type PricingWork,
} from "./pricing-plan.ts";
import { type HotelClock, lastNightOf, readHotelClock } from "./pricing-window.ts";
import { ALERT_BUDGET_MS } from "./push-incidents.ts";
import { pushMaxPriceAgeMs } from "./push-guardrails.ts";
import { pushRatesForHotel, type PmsRatePushAdapter, type RatePushOptions, type RatePushSummary } from "./rate-push.ts";

/**
 * Every scheduled run reads the booking history booking speed compares with
 * from the hotel day's store, and saves what it had to read afresh
 * (HistoryLoad in engine/booking-speed-provider.ts): the popup and the next
 * ticks then read it instead of the whole history again.
 */
const KEEP_HISTORY: EvaluateOptions["history"] = { store: "write" };

/** Before the cadence migration, every tick prices the whole window, and never past this. */
export const PRE_CADENCE_HORIZON_DAYS = 60;

/**
 * Whether this process has seen a database without the cadence functions.
 * Until one call finds them, the base rate refresh and the push keep to
 * PRE_CADENCE_HORIZON_DAYS as well, so a deploy ahead of the migration reads
 * no more of the PMS than before.
 */
let cadenceMissingSeen = false;

/** Test hook. */
export function resetCadenceMissingSeen(): void {
  cadenceMissingSeen = false;
}

/**
 * How long a hotel may go without a pricing run that finished before a
 * failed run is worth a person's attention: three of the five-minute runs.
 * One failed read is put right by the next run and says nothing.
 */
export const PRICING_FAILING_ALERT_AFTER_MS = 15 * 60_000;
/** Failed runs in a row before the alert channel hears, whatever the clock says. */
export const PRICING_FAILURES_BEFORE_ALERT = 3;

export type TickSkip =
  | { skipped: "no_credentials" | "out_of_time" | "disabled" | "sync_failed" | "sync_incomplete" }
  | { error: string };

/** How this tick's PMS read went, as far as pricing is concerned. */
export type ReadOutcome = "ok" | "failed" | "incomplete";

/**
 * A sync result's outcome. `windowFullyCovered` false (the read's budget ran
 * out part way) is "incomplete"; a result without the field, such as a read
 * skipped while an import runs, is "ok".
 */
export function readOutcome(sync: { ok: boolean; windowFullyCovered?: boolean }): ReadOutcome {
  if (!sync.ok) return "failed";
  return sync.windowFullyCovered === false ? "incomplete" : "ok";
}

/** What the cadence chose for this tick, for the function's log line. */
export type TickCadence = {
  mode: PricingCadence | "pre_migration";
  nights: number;
  touched: number;
  momentum: number;
  chunk: number;
  passStarted: string | null;
  passNext: string | null;
  failedNights: number;
  /** Nights the run changed a rule's state on: priced again next tick. */
  again?: number;
  error?: string;
};

export type PricingTickResult<E> = {
  /** The hotel's date this tick priced from; null when it could not be read. */
  today: string | null;
  calendar: EnsureCalendarResult | TickSkip;
  evaluate: E | { error: string } | { skipped: true | "out_of_time" | "sync_failed" } | { idle: true };
  /** How the nights were chosen; absent when nothing was evaluated. */
  cadence?: TickCadence;
  /**
   * The daily pass has nights left (or a new pass is due and did not start):
   * the caller releases the hotel due again soon (PASS_WORK_RETRY_SECONDS).
   */
  passWorkLeft: boolean;
  push: RatePushSummary | TickSkip;
  /** Nights changed in the PMS after MAYA's send that this refresh adopted as manual prices. */
  pmsEditsAdopted?: number;
  /** Too little time was left to evaluate; the caller releases the hotel due again soon. */
  outOfTime: boolean;
  /** Pricing has been failing long enough to tell the alert channel, and whether it was told. */
  pricingAlert?: { sent: boolean; reason?: string };
  /** This tick's run priced nights after failed runs, and whether the channel got its recovery line. */
  pricingRecovery?: { sent: boolean; reason?: string };
  calendarMs: number;
  evalMs: number;
  pushMs: number;
};

export async function runPricingTick<E>(
  supabase: SupabaseClient,
  hotelId: string,
  opts: {
    /** Nights to refresh, evaluate and push; the same number for all three. */
    horizonDays: number;
    /** Null when this tick has no working PMS credentials. */
    adapter: PmsRatePushAdapter | null;
    /** What the calendar and push report when there is no adapter. */
    noAdapter?: TickSkip;
    runEvaluate: boolean;
    pushEnabled: boolean;
    /** Past this, no evaluation (and so no refresh or push) starts. */
    evaluateBy: number;
    pushDeadlineAt: number;
    /** This tick's PMS read (readOutcome). Default "ok". */
    read?: ReadOutcome;
    /** How nights are chosen; MAYA_PRICING_CADENCE by default. */
    cadence?: PricingCadence;
    /** The cadence's sizes; from the environment by default. */
    cadenceConfig?: CadenceConfig;
    /**
     * Daily pass nights the invocation may still price, shared by its
     * hotels (MAYA_TICK_PASS_NIGHTS). This tick takes its chunk from it.
     */
    passBudget?: { remaining: number };
  },
  deps: {
    evaluate: EvaluateFn<E>;
    now?: () => number;
    /** Posts to the alert channel. raiseAlert unless a test swaps it. */
    alert?: typeof raiseAlert;
    /** Posts the recovery line. raiseRecovery unless a test swaps it. */
    recover?: typeof raiseRecovery;
  },
): Promise<PricingTickResult<E>> {
  const now = deps.now ?? Date.now;
  const noAdapter: TickSkip = opts.noAdapter ?? { skipped: "no_credentials" };
  const t0 = now();

  if (opts.read === "failed") {
    const skipped = { skipped: "sync_failed" as const };
    return {
      today: null,
      calendar: skipped,
      evaluate: skipped,
      push: skipped,
      passWorkLeft: false,
      outOfTime: false,
      calendarMs: 0,
      evalMs: 0,
      pushMs: 0,
    };
  }

  let clock: HotelClock | null = null;
  let clockError = "";
  try {
    clock = await readHotelClock(supabase, hotelId, new Date(t0).toISOString());
  } catch (e) {
    clockError = errorText(e, "hotel date unavailable");
  }

  // A database without the cadence functions prices as before, 60 nights at most.
  let horizonDays = cadenceMissingSeen ? Math.min(opts.horizonDays, PRE_CADENCE_HORIZON_DAYS) : opts.horizonDays;

  // A hotel already past the cut-off gets no evaluation, so a refresh would
  // only spend PMS calls and time the release needs.
  let calendar: PricingTickResult<E>["calendar"];
  if (t0 > opts.evaluateBy) {
    calendar = { skipped: "out_of_time" };
  } else if (!opts.adapter) {
    calendar = noAdapter;
  } else if (!clock) {
    calendar = { error: clockError };
  } else {
    // Before the engine, so this tick prices on the base it just read.
    calendar = await ensureBaseRateCalendar(supabase, hotelId, opts.adapter, {
      horizonDays,
      clock,
      deadlineAt: opts.evaluateBy,
    });
  }
  const tCalendar = now();

  const outOfTime = tCalendar > opts.evaluateBy;
  let evaluate: PricingTickResult<E>["evaluate"];
  let evaluatedAt: string | undefined;
  let cadence: TickCadence | undefined;
  let passWorkLeft = false;
  // The hotel's last run that finished, where the work list said (undefined: not read).
  let lastOkRunAt: string | null | undefined;
  // This tick's run was not recorded (pricing_run_done failed).
  let recordError: string | undefined;
  // This tick's run priced nights after a streak of failed runs (recoverPricingFailing).
  let endedStreak: PricedNights<E>["endedStreak"];
  // Nights the push may not take this tick's pricing as proof for (see RatePushOptions.notVouched).
  let notVouched: RatePushOptions["notVouched"];
  if (outOfTime) {
    evaluate = { skipped: "out_of_time" };
  } else if (opts.runEvaluate && !clock) {
    // Without a clock the engine reads the timezone itself, as it always has,
    // over the whole window; the push below does not run on that date.
    try {
      evaluate = await deps.evaluate(supabase, hotelId, undefined, horizonDays, { history: KEEP_HISTORY });
    } catch (e) {
      evaluate = { error: errorText(e, "evaluate failed") };
    }
  } else if (opts.runEvaluate && clock) {
    const priced = await priceNights(supabase, hotelId, clock, {
      horizonDays,
      cadence: opts.cadence ?? pricingCadence(),
      config: opts.cadenceConfig ?? cadenceConfigFromEnv(),
      timeLeftMs: opts.evaluateBy - tCalendar,
      passBudget: opts.passBudget,
      evaluate: deps.evaluate,
    });
    evaluate = priced.evaluate;
    evaluatedAt = priced.vouchedAt;
    cadence = priced.cadence;
    passWorkLeft = priced.passWorkLeft;
    notVouched = priced.notVouched;
    horizonDays = priced.horizonDays;
    lastOkRunAt = priced.lastOkRunAt;
    recordError = priced.recordError;
    endedStreak = priced.endedStreak;
  } else {
    evaluate = { skipped: true };
  }
  const tEval = now();

  // Internally no-ops unless the hotel is in LIVE mode.
  let push: PricingTickResult<E>["push"];
  if (!opts.pushEnabled) {
    push = { skipped: "disabled" };
  } else if (outOfTime) {
    push = { skipped: "out_of_time" };
  } else if (opts.read === "incomplete") {
    // Priced on part of the book; sent once a read covers all of it.
    push = { skipped: "sync_incomplete" };
  } else if (!opts.adapter) {
    push = noAdapter;
  } else if (!clock) {
    // Without the hotel's date there is no telling which nights were priced.
    push = { error: clockError };
  } else {
    const adapter = opts.adapter;
    const activeClock = clock;
    // What the push does about rates the hotel may have changed since the
    // last read: hold the nights this tick's own read found moved and could
    // not record, read again, or neither when the PMS has answered already.
    const changedInPms: Pick<RatePushOptions, "movedInPms" | "readBeforeResend"> = baseReadThisTick(calendar)
      ? calendar.holdCells.length > 0 ? { movedInPms: new Set(calendar.holdCells) } : {}
      : pmsAnsweredRead(calendar)
      ? {}
      : {
        readBeforeResend: {
          settleMs: pmsEditSettleMs(),
          read: async (span) => {
            const again = await ensureBaseRateCalendar(supabase, hotelId, adapter, {
              horizonDays,
              clock: activeClock,
              span,
              deadlineAt: opts.pushDeadlineAt,
            });
            return again.ok ? new Set(again.movedCells) : null;
          },
        },
      };
    try {
      push = await pushRatesForHotel(supabase, hotelId, adapter, {
        today: clock.today,
        // The window the engine prices, never past it.
        pushHorizonDays: horizonDays,
        deadlineAt: opts.pushDeadlineAt,
        // Vouches for the prices this tick's pricing left current: every
        // night of a whole-window evaluation, or, with the cadence, every
        // night whose changes have all been priced (notVouched says which are
        // not). A failed or skipped evaluation leaves the push to judge each
        // price's age.
        evaluatedAt,
        ...(notVouched ? { notVouched } : {}),
        holdNeverPushed: !baseReadRecently(calendar),
        ...changedInPms,
        // Sends this tick's read found never landed: filed, and sent again.
        ...(baseReadThisTick(calendar) && calendar.unlandedCells?.length ? { neverLanded: new Set(calendar.unlandedCells) } : {}),
      });
    } catch (e) {
      push = { error: errorText(e, "push failed") };
    }
  }
  const tPush = now();

  // After the push, so telling someone never takes time from sending, and
  // only while the alert's own timeout still fits before the release.
  const failure = pricingFailure(evaluate, recordError);
  const failedRuns = failure ? await noteFailedRun(supabase, hotelId, `${failure.step}: ${failure.error}`) : null;
  const pricingAlert = failure
    ? await alertPricingFailing(supabase, hotelId, failure, {
        lastOkRunAt,
        failedRuns,
        nowMs: t0,
        mayStart: now() + ALERT_BUDGET_MS <= opts.pushDeadlineAt,
        alert: deps.alert ?? raiseAlert,
      })
    : null;
  // The run that ends a streak of failed runs tells the channel so, if the
  // channel heard of the streak (raiseRecovery says nothing otherwise).
  const pricingRecovery = !failure && endedStreak
    ? await recoverPricingFailing(supabase, hotelId, endedStreak, {
        mayStart: now() + ALERT_BUDGET_MS <= opts.pushDeadlineAt,
        recover: deps.recover ?? raiseRecovery,
      })
    : null;

  return {
    today: clock?.today ?? null,
    calendar,
    evaluate,
    ...(cadence ? { cadence } : {}),
    passWorkLeft,
    push,
    ...("pmsEditsAdopted" in calendar ? { pmsEditsAdopted: calendar.pmsEditsAdopted } : {}),
    outOfTime,
    ...(pricingAlert ? { pricingAlert } : {}),
    ...(pricingRecovery ? { pricingRecovery } : {}),
    calendarMs: tCalendar - t0,
    evalMs: tEval - tCalendar,
    pushMs: tPush - tEval,
  };
}

type EvaluateFn<E> = (
  supabase: SupabaseClient,
  hotelId: string,
  evalTs: string | undefined,
  horizonDays: number,
  opts?: EvaluateOptions,
) => Promise<E>;

type PricedNights<E> = {
  evaluate: PricingTickResult<E>["evaluate"];
  /** The instant the push may take as proof of a current price, if any. */
  vouchedAt?: string;
  cadence: TickCadence;
  passWorkLeft: boolean;
  notVouched?: RatePushOptions["notVouched"];
  /** The window actually priced (shorter before the cadence migration). */
  horizonDays: number;
  /** When a run of the hotel last finished, from the work list; undefined when that was not read. */
  lastOkRunAt?: string | null;
  /** The run (or an idle tick's heartbeat) could not be recorded. */
  recordError?: string;
  /**
   * This run priced nights and was recorded after `failedRuns` failed runs
   * in a row (the work list's count before it; the record set it to 0).
   */
  endedStreak?: { failedRuns: number; nights: number };
};

const emptyReport = (): CadenceReport => ({
  nights: [],
  failedNights: [],
  momentumNights: [],
  changedNights: [],
  engineMs: 0,
});

/**
 * Read the work list, plan, price, report. Never throws: an engine failure is
 * the tick's evaluate error and nothing is cleared, so the next tick prices
 * the same nights again; a report that fails to record leaves the marks for
 * the next tick too (priced twice, never missed).
 */
async function priceNights<E>(
  supabase: SupabaseClient,
  hotelId: string,
  clock: HotelClock,
  args: {
    horizonDays: number;
    cadence: PricingCadence;
    config: CadenceConfig;
    timeLeftMs: number;
    passBudget?: { remaining: number };
    evaluate: EvaluateFn<E>;
  },
): Promise<PricedNights<E>> {
  let horizonDays = args.horizonDays;
  let lastNight = lastNightOf(clock.today, horizonDays);
  let work: PricingWork | typeof CADENCE_MISSING;
  let workError: string | undefined;
  try {
    work = await loadPricingWork(supabase, hotelId, clock.today, lastNight);
  } catch (e) {
    // The list can't be read this tick: price the whole window, as before,
    // and leave every mark for the next tick.
    work = CADENCE_MISSING;
    workError = errorText(e, "pricing work unavailable");
    console.error(JSON.stringify({ fn: "runPricingTick", hotelId, step: "pricing_work", error: workError }));
  }
  if (work === CADENCE_MISSING && !workError) {
    cadenceMissingSeen = true;
    horizonDays = Math.min(horizonDays, PRE_CADENCE_HORIZON_DAYS);
    lastNight = lastNightOf(clock.today, horizonDays);
  } else if (work !== CADENCE_MISSING) {
    cadenceMissingSeen = false;
  }

  // Before the migration, or with the list unreadable: the whole window, as before.
  if (work === CADENCE_MISSING) {
    const cadence: TickCadence = {
      mode: workError ? args.cadence : "pre_migration",
      nights: horizonDays,
      touched: 0,
      momentum: 0,
      chunk: horizonDays,
      passStarted: null,
      passNext: null,
      failedNights: 0,
      ...(workError ? { error: workError } : {}),
    };
    try {
      const evaluate = await args.evaluate(supabase, hotelId, clock.at, horizonDays, { history: KEEP_HISTORY });
      return { evaluate, vouchedAt: clock.at, cadence, passWorkLeft: false, horizonDays };
    } catch (e) {
      return { evaluate: { error: errorText(e, "evaluate failed") }, cadence, passWorkLeft: false, horizonDays };
    }
  }

  const budget = args.passBudget?.remaining ?? Number.POSITIVE_INFINITY;
  const plan: PricingPlan =
    args.cadence === "every_tick"
      ? planWholeWindow(work, clock.today, lastNight, horizonDays)
      : planPricingRun({
          work,
          today: clock.today,
          lastNight,
          horizonDays,
          config: args.config,
          passAllowed: args.timeLeftMs >= args.config.passMinTimeMs && budget > 0,
          passBudget: budget,
        });
  if (args.passBudget && args.cadence !== "every_tick") {
    args.passBudget.remaining = Math.max(0, args.passBudget.remaining - plan.counts.chunk);
  }
  const cadence: TickCadence = {
    mode: args.cadence,
    nights: plan.nights.length,
    touched: plan.counts.touched,
    momentum: plan.counts.momentum,
    chunk: plan.counts.chunk,
    passStarted: plan.pass?.start ? plan.pass.reason : null,
    passNext: plan.pass ? plan.pass.next : null,
    failedNights: 0,
  };
  const passWorkLeft = plan.passWorkLeft || plan.passDue !== null;
  const settled = work;
  const notVouchedAfter = (priced: boolean): RatePushOptions["notVouched"] => {
    const pricedNights = new Set(priced ? plan.nights : []);
    return {
      unpriced: new Set(settled.dirty.map((d) => d.stay_date).filter((d) => !pricedNights.has(d))),
      stale: unsettledNights({
        work: settled,
        plan,
        priced,
        nowMs: Date.parse(clock.at),
        maxAgeMs: pushMaxPriceAgeMs(),
        today: clock.today,
        lastNight,
        dayStartedMs: Date.parse(hotelDayStartIso(clock.today, clock.timeZone)),
        passMaxLagMs: args.config.passMaxLagMinutes * 60_000,
      }),
    };
  };

  // Nothing to price: a heartbeat, so the change log and the status page see
  // a tick that ran and found nothing to change.
  if (plan.nights.length === 0) {
    try {
      const recorded = await recordPricingRun(supabase, hotelId, {
        at: clock.at,
        first: clock.today,
        last: lastNight,
        nights: [],
        dirty: [],
        failed: plan.deferred,
        again: [],
        pass: null,
        momentum: [],
        msPerNight: null,
        idle: true,
        runId: crypto.randomUUID(),
      });
      if (recorded === CADENCE_MISSING) cadenceMissingSeen = true;
    } catch (e) {
      cadence.error = errorText(e, "pricing run not recorded");
      console.error(JSON.stringify({ fn: "runPricingTick", hotelId, step: "pricing_run_done", error: cadence.error }));
    }
    return {
      evaluate: { idle: true },
      vouchedAt: clock.at,
      cadence,
      passWorkLeft,
      notVouched: notVouchedAfter(true),
      horizonDays,
      lastOkRunAt: work.state?.last_ok_run_at ?? null,
      ...(cadence.error ? { recordError: cadence.error } : {}),
    };
  }

  const report = emptyReport();
  let evaluate: PricingTickResult<E>["evaluate"];
  try {
    evaluate = await args.evaluate(supabase, hotelId, clock.at, horizonDays, {
      // A whole-window plan prices the window the way it always has.
      ...(args.cadence === "every_tick" ? {} : { nights: plan.nights }),
      runKind: args.cadence === "every_tick" ? "window" : "nights",
      report,
      history: KEEP_HISTORY,
    });
  } catch (e) {
    // Nothing is cleared and the pass does not move: the next tick prices
    // the same nights again. The push judges prices by the last good run.
    return {
      evaluate: { error: errorText(e, "evaluate failed") },
      vouchedAt: work.state?.last_ok_run_at ?? undefined,
      cadence,
      passWorkLeft: true,
      notVouched: notVouchedAfter(false),
      horizonDays,
      lastOkRunAt: work.state?.last_ok_run_at ?? null,
    };
  }

  cadence.failedNights = report.failedNights.length;
  cadence.again = report.changedNights.length;
  const pricedNights = report.nights.length > 0 ? report.nights : plan.nights;
  const failedBefore = work.state?.failed_runs ?? 0;
  try {
    const recorded = await recordPricingRun(supabase, hotelId, {
      at: clock.at,
      first: clock.today,
      last: lastNight,
      nights: pricedNights,
      dirty: plan.dirtyRead,
      failed: [...new Set([...report.failedNights, ...plan.deferred])].sort(),
      again: report.changedNights,
      pass: plan.pass,
      momentum: report.momentumNights,
      msPerNight: pricedNights.length > 0 ? Math.round((report.engineMs / pricedNights.length) * 1000) / 1000 : null,
      idle: false,
    });
    if (recorded === CADENCE_MISSING) cadenceMissingSeen = true;
  } catch (e) {
    // Priced, not recorded: the marks stay and the next tick prices those
    // nights again.
    cadence.error = errorText(e, "pricing run not recorded");
    console.error(JSON.stringify({ fn: "runPricingTick", hotelId, step: "pricing_run_done", error: cadence.error }));
  }
  return {
    evaluate,
    vouchedAt: clock.at,
    cadence,
    passWorkLeft,
    notVouched: notVouchedAfter(true),
    horizonDays,
    lastOkRunAt: work.state?.last_ok_run_at ?? null,
    ...(cadence.error ? { recordError: cadence.error } : {}),
    // Recorded, so the database has set the count back to 0: the streak is over.
    ...(!cadence.error && failedBefore > 0 ? { endedStreak: { failedRuns: failedBefore, nights: pricedNights.length } } : {}),
  };
}

/**
 * The run that priced nights after failed ones tells the alert channel, once,
 * under the same key as alertPricingFailing, so the channel's story closes
 * and the database watchdog (pricing_watchdog) no longer counts the hotel as
 * covered by an open alert: a function that then stops ticking altogether is
 * a new outage, told by the watchdog. raiseRecovery says nothing when the
 * channel never heard of the streak. Never throws.
 */
export async function recoverPricingFailing(
  supabase: SupabaseClient,
  hotelId: string,
  streak: { failedRuns: number; nights: number },
  opts: { mayStart: boolean; recover: typeof raiseRecovery },
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const told = opts.mayStart
      ? await opts.recover(supabase, {
          key: `pricing-failing:${hotelId}`,
          title: "Pricing is running again",
          detail:
            `${streak.failedRuns} run${streak.failedRuns === 1 ? "" : "s"} in a row had failed. ` +
            `This run priced ${streak.nights} night${streak.nights === 1 ? "" : "s"} and was recorded.`,
          hotelId,
        })
      : { sent: false, reason: "out_of_time" };
    console.log(JSON.stringify({ fn: "runPricingTick", hotelId, step: "pricing_recovered", failedRuns: streak.failedRuns, nights: streak.nights, recovery: told }));
    return told;
  } catch (e) {
    console.error(JSON.stringify({ fn: "runPricingTick", hotelId, step: "pricing_recovered", error: errorText(e, "recovery failed") }));
    return { sent: false, reason: "send_failed" };
  }
}

/** What went wrong with a tick's pricing: the engine stopped, or its run could not be recorded. */
type PricingFailure = { step: "evaluate" | "record"; error: string };

/**
 * What went wrong with this tick's pricing, if anything: the engine's error
 * (it published nothing), or the run that could not be recorded (its nights
 * stay marked and the pass does not move). Not a work list that could not be
 * read: the whole window was priced instead.
 */
function pricingFailure(evaluate: unknown, recordError: string | undefined): PricingFailure | null {
  const failed = typeof evaluate === "object" && evaluate !== null && "error" in evaluate ? evaluate.error : undefined;
  if (typeof failed === "string") return { step: "evaluate", error: failed };
  return recordError ? { step: "record", error: recordError } : null;
}

/**
 * Tell the alert channel that a hotel's pricing keeps failing: this tick's
 * run failed, and either PRICING_FAILURES_BEFORE_ALERT runs have failed in
 * a row (failedRuns, as the database counted them) or no run of the hotel
 * has priced anything for PRICING_FAILING_ALERT_AFTER_MS (or ever).
 *
 * The clock for a run that stopped is the newest run on the run log that
 * priced nights (run_kind window, nights or save, or a row from before the
 * kinds). Not the work list's last_ok_run_at: an idle tick's heartbeat moves
 * that too, and a hotel whose pass chunk fails on every tick that has pass
 * budget and idles on the ticks that have none (the budget is shared across
 * a fleet) would keep a fresh "ok" run for ever while no night is priced.
 * The idle heartbeat's own run-log row (run_kind idle) is left out for the
 * same reason. When the run log has no such row, or cannot be read, nobody
 * can say how long it has been and the alert goes out: a database that
 * answers nothing is the failure that lasts.
 *
 * The clock for a run that priced but could not be recorded is the work
 * list's last_ok_run_at (the record is what moves it): the run log has this
 * run's own heartbeat, which says nothing about the record. An idle tick's
 * record moves it too, so a record that fails only for runs with nights is
 * told late; a pricing_run_done that fails for every call stops the clock.
 *
 * Never throws. Returns null when it is too soon to say.
 */
export async function alertPricingFailing(
  supabase: SupabaseClient,
  hotelId: string,
  failure: PricingFailure,
  opts: {
    /** hotel_pricing_state.last_ok_run_at as the work list read it; undefined when not read. */
    lastOkRunAt: string | null | undefined;
    /** Failed runs in a row, this one included (noteFailedRun); null when the database could not count. */
    failedRuns?: number | null;
    nowMs: number;
    /** Whether the alert's timeout still fits in the tick. */
    mayStart: boolean;
    alert: typeof raiseAlert;
  },
): Promise<{ sent: boolean; reason?: string } | null> {
  try {
    const lastOk = failure.step === "evaluate" ? await lastPricedRunLogged(supabase, hotelId) : opts.lastOkRunAt ?? null;
    const lastOkMs = lastOk ? Date.parse(lastOk) : NaN;
    const inARow = (opts.failedRuns ?? 0) >= PRICING_FAILURES_BEFORE_ALERT;
    if (!inARow && Number.isFinite(lastOkMs) && opts.nowMs - lastOkMs < PRICING_FAILING_ALERT_AFTER_MS) return null;
    const streak = inARow ? `${opts.failedRuns} runs in a row have failed. ` : "";
    const since = Number.isFinite(lastOkMs)
      ? `No pricing run has priced anything since ${new Date(lastOkMs).toISOString()} (${Math.round((opts.nowMs - lastOkMs) / 60_000)} minutes).`
      : "No pricing run has priced anything for this hotel.";
    const what =
      failure.step === "evaluate"
        ? "The latest run stopped before it published anything, so no new price is published or sent until a run finishes."
        : "The latest run could not be recorded, so the nights it priced are priced again and the daily pass does not move on.";
    const alert: Alert = {
      severity: "critical",
      key: `pricing-failing:${hotelId}`,
      title: "Pricing keeps failing",
      detail: `${streak}${since} ${what} Error: ${failure.error}`,
      hotelId,
    };
    // Not sent when its timeout would run past the tick: the next tick tries.
    const told = opts.mayStart ? await opts.alert(supabase, alert) : { sent: false, reason: "out_of_time" };
    console.error(
      JSON.stringify({
        fn: "runPricingTick",
        hotelId,
        step: "pricing_failing",
        failed: failure.step,
        failedRuns: opts.failedRuns ?? null,
        lastOkRunAt: lastOk ?? null,
        error: failure.error,
        alert: told,
      }),
    );
    return told;
  } catch (e) {
    console.error(JSON.stringify({ fn: "runPricingTick", hotelId, step: "pricing_failing_alert", error: errorText(e, "alert failed") }));
    return { sent: false, reason: "send_failed" };
  }
}

/**
 * The newest run on the hotel's run log that priced nights, or null. Every
 * run that finishes writes its heartbeat there with its kind; an idle tick's
 * (run_kind idle) priced nothing and is left out. A row from before the
 * kinds (run_kind null) was a run over the whole window.
 */
async function lastPricedRunLogged(supabase: SupabaseClient, hotelId: string): Promise<string | null> {
  const newest = (withKinds: boolean) => {
    const q = supabase.from("evaluation_run_log").select("evaluated_at").eq("hotel_id", hotelId);
    return (withKinds ? q.or("run_kind.is.null,run_kind.neq.idle") : q).order("evaluated_at", { ascending: false }).limit(1).maybeSingle();
  };
  let { data, error } = await newest(true);
  // Before the cadence migration there is no kind, and no idle heartbeat either.
  if (error && isMissingColumnError(error)) ({ data, error } = await newest(false));
  if (error || !data?.evaluated_at) return null;
  return String(data.evaluated_at);
}

/** Whether the base under this tick was read from the PMS just now, or within the refresh interval. */
function baseReadRecently(calendar: EnsureCalendarResult | TickSkip): boolean {
  return baseReadThisTick(calendar) || ("reason" in calendar && calendar.reason === "throttled");
}

/** Whether this tick's refresh read the PMS. */
function baseReadThisTick(calendar: EnsureCalendarResult | TickSkip): calendar is Extract<EnsureCalendarResult, { ok: true }> {
  return "ok" in calendar && calendar.ok;
}

/**
 * Whether this tick's refresh asked the PMS for its rates and was refused, or
 * told there is nothing to target. Asking again within the tick only doubles
 * the calls, against the vendor's rate limit and the push's deadline.
 */
function pmsAnsweredRead(calendar: EnsureCalendarResult | TickSkip): boolean {
  if (!("reason" in calendar)) return false;
  return calendar.reason === "no_rate_targets" || ("step" in calendar && calendar.step === "pms_read");
}

/** A step's error for the log line and the response, which pg_net stores. Vendor text can be long. */
function errorText(e: unknown, fallback: string): string {
  return (e instanceof Error ? e.message : fallback).slice(0, 300);
}
