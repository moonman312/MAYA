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
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureBaseRateCalendar, type EnsureCalendarResult } from "./base-rate-calendar.ts";
import { pmsEditSettleMs } from "./pms-edits.ts";
import { type HotelClock, readHotelClock } from "./pricing-window.ts";
import { pushRatesForHotel, type PmsRatePushAdapter, type RatePushOptions, type RatePushSummary } from "./rate-push.ts";

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

export type PricingTickResult<E> = {
  /** The hotel's date this tick priced from; null when it could not be read. */
  today: string | null;
  calendar: EnsureCalendarResult | TickSkip;
  evaluate: E | { error: string } | { skipped: true | "out_of_time" | "sync_failed" };
  push: RatePushSummary | TickSkip;
  /** Nights changed in the PMS after MAYA's send that this refresh adopted as manual prices. */
  pmsEditsAdopted?: number;
  /** Too little time was left to evaluate; the caller releases the hotel due again soon. */
  outOfTime: boolean;
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
  },
  deps: {
    evaluate: (supabase: SupabaseClient, hotelId: string, evalTs: string | undefined, horizonDays: number) => Promise<E>;
    now?: () => number;
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
      horizonDays: opts.horizonDays,
      clock,
      deadlineAt: opts.evaluateBy,
    });
  }
  const tCalendar = now();

  const outOfTime = tCalendar > opts.evaluateBy;
  let evaluate: PricingTickResult<E>["evaluate"];
  let evaluatedAt: string | undefined;
  if (outOfTime) {
    evaluate = { skipped: "out_of_time" };
  } else if (opts.runEvaluate) {
    try {
      // Without a clock the engine reads the timezone itself, as it always has;
      // the push below does not run on that date.
      evaluate = await deps.evaluate(supabase, hotelId, clock?.at, opts.horizonDays);
      evaluatedAt = clock?.at;
    } catch (e) {
      evaluate = { error: errorText(e, "evaluate failed") };
    }
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
          read: async () => {
            const again = await ensureBaseRateCalendar(supabase, hotelId, adapter, {
              horizonDays: opts.horizonDays,
              clock: activeClock,
              refreshIntervalMs: 0,
              deadlineAt: opts.pushDeadlineAt,
            });
            return again.ok ? new Set(again.movedCells) : null;
          },
        },
      };
    try {
      push = await pushRatesForHotel(supabase, hotelId, adapter, {
        today: clock.today,
        // Never a night this tick did not evaluate.
        pushHorizonDays: opts.horizonDays,
        deadlineAt: opts.pushDeadlineAt,
        // Vouches for every price this tick's evaluation re-derived. A failed
        // or skipped evaluation leaves the push to judge each price's age.
        evaluatedAt,
        holdNeverPushed: !baseReadRecently(calendar),
        ...changedInPms,
      });
    } catch (e) {
      push = { error: errorText(e, "push failed") };
    }
  }
  const tPush = now();

  return {
    today: clock?.today ?? null,
    calendar,
    evaluate,
    push,
    ...("pmsEditsAdopted" in calendar ? { pmsEditsAdopted: calendar.pmsEditsAdopted } : {}),
    outOfTime,
    calendarMs: tCalendar - t0,
    evalMs: tEval - tCalendar,
    pushMs: tPush - tEval,
  };
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
