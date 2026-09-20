/**
 * Expected bookings — turning a comparable set into a Booking Speed call.
 *
 * For a target stay date T seen from as-of date A, the recent pickup is the
 * count of bookings for T made in the last `windowDays`. Each comparable
 * date is measured over the SAME stretch of its own booking curve (the same
 * days-until-arrival band), so a date 40 days out is compared with how its
 * peers were booking when THEY were 40 days out. The expectation is a
 * trimmed mean over the comparables, and often fractional — 0.4 expected
 * bookings is an honest statement about a quiet far-out date, not an error.
 *
 * Only comparables with actual reservation history behind them count —
 * a comparable date with zero ROWS is "we don't know", not "zero bookings",
 * and must not silently dilute the expectation as if it were real evidence.
 *
 * A real, day-of-week/season-matched comparable is better evidence than a
 * calendar-neighbor proxy, even when there are very few of them, so this
 * only reaches for the momentum fallback (momentum.ts — how nearby dates
 * are pacing right now versus a year ago) when NO usable comparable exists
 * at all; the classifier's own thin-history guard already keeps a call
 * built from just 1-4 real comparables appropriately conservative. Only
 * when even momentum has nothing to go on does this report
 * `insufficient_data` rather than guess.
 *
 * A rule that already adjusted a night passes `countFrom`: only bookings
 * made from that date on count, and the window shrinks to the days from it
 * to the as-of date. The comparables (and momentum) are then read over that
 * same shorter stretch of their booking curves, so the expectation stays a
 * fair one: a rule never re-counts the bookings it already acted on.
 *
 * Counts reflect currently known reservations from the slim import rows:
 * a canceled booking disappears rather than counting negative. Pure
 * functions; the caller supplies rows and dates.
 */

import { daysBetween } from "./calendar.ts";
import {
  classifyBookingSpeed,
  describeBookingSpeed,
  type BookingSpeedClassification,
} from "./booking-speed.ts";
import { describeComparableSelection, type ComparableSelection } from "./comparable-dates.ts";
import {
  DEFAULT_WINDOW_DAYS,
  hasAnyRowIndexed,
  indexBookingRows,
  pickupInWindowIndexed,
  round2,
  trimmedMean,
  type BookingWindowIndex,
  type SlimReservationRow,
} from "./booking-rows.ts";
import {
  MOMENTUM_ASSUMED_COMPARABLE_COUNT,
  describeMomentum,
  estimateMomentumFallback,
  type MomentumEstimate,
} from "./momentum.ts";

export { DEFAULT_WINDOW_DAYS, pickupInWindow, trimmedMean, type SlimReservationRow } from "./booking-rows.ts";

export type BookingSpeedMethod = "comparable" | "momentum" | "insufficient_data";

export interface ComparablePickup {
  date: string;
  bookings: number;
  tier: number;
  reasons: string[];
  /** False when this comparable has no reservation history at all — "we don't know", not "zero bookings". */
  hasData: boolean;
}

export interface BookingSpeedObservation {
  target: string;
  asOf: string;
  daysOut: number;
  windowDays: number;
  recentBookings: number;
  expectedBookings: number;
  /** How the expectation was derived — governs which Level 2 explanation applies. */
  method: BookingSpeedMethod;
  /** Every comparable the matcher found, including any with no data (for audit purposes — see hasData). */
  perComparable: ComparablePickup[];
  /** Present only when method === "momentum". */
  momentum?: MomentumEstimate;
  selection: ComparableSelection;
  classification: BookingSpeedClassification;
  /**
   * The room types counted, when a rule measures only some of the hotel's.
   * Absent for the hotel-wide observation (every room type that counts as a
   * room), which is also how every snapshot written before this field reads.
   */
  measuredRoomTypeIds?: string[];
  /**
   * Set only when `countFrom` cut the window short: the first booking date
   * counted. windowDays is then the shorter stretch actually measured, on
   * the target and on every comparable alike.
   */
  countedFrom?: string;
  /** The window the rule asked for, set together with countedFrom. */
  fullWindowDays?: number;
  /**
   * With countedFrom: whether the fire the count starts after was a raise or
   * a cut. A raise rule counts from the night's last raise and a cut rule
   * from its last cut, whichever rule made it (engine/pickup.ts
   * bookingSpeedAnchors). Stamped by the engine, not here.
   */
  countedAfter?: "raise" | "cut";
}

export interface ObserveBookingSpeedOptions {
  rows?: SlimReservationRow[];
  /**
   * The same history already grouped by stay date and booking window (see
   * indexBookingRows). Used instead of `rows` when given; the answer is the
   * same either way. It must cover every date this observation can consult:
   * the target, its comparables, and momentum's neighbors and their
   * year-ago dates.
   */
  index?: BookingWindowIndex;
  target: string;
  asOf: string;
  selection: ComparableSelection;
  windowDays?: number;
  /**
   * Count only bookings made on or after this date (YYYY-MM-DD). The window
   * becomes the days from it to asOf, never longer than windowDays, and must
   * keep at least one day (see windowDaysFrom). Null or older than the
   * window's first day: the whole window, exactly as without it.
   */
  countFrom?: string | null;
  /** Same exclusion predicate passed to selectComparableDates — reused for momentum's neighbor search. */
  isExcluded?: (date: string) => boolean;
}

/**
 * Days of a trailing `windowDays` window ending on `asOf` that fall on or
 * after `countFrom`: the whole window when countFrom is null or older than
 * the window's first day, fewer when it starts inside it, 0 when it is after
 * asOf. Bookings carry a date, not a time, so a whole day is the unit.
 */
export function windowDaysFrom(windowDays: number, asOf: string, countFrom?: string | null): number {
  if (!countFrom) return windowDays;
  return Math.max(0, Math.min(windowDays, daysBetween(countFrom, asOf) + 1));
}

/**
 * The full Layer 1 pipeline for one stay date: recent pickup, comparable
 * pickup (or momentum fallback), and the classified Booking Speed. The
 * returned object is the audit snapshot — persist it with the evaluation so
 * explanations replay what was actually known, not what is known later.
 */
export function observeBookingSpeed(opts: ObserveBookingSpeedOptions): BookingSpeedObservation {
  const fullWindowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const daysOut = daysBetween(opts.asOf, opts.target);
  if (daysOut < 0) {
    throw new Error("booking speed target must not be in the past");
  }
  // From here on the window is the stretch actually counted: bookings made
  // from countFrom on, on the target and on every date it is compared with.
  const windowDays = windowDaysFrom(fullWindowDays, opts.asOf, opts.countFrom);
  if (windowDays < 1) {
    throw new Error("booking speed countFrom must leave at least one day to count");
  }
  const cut = windowDays < fullWindowDays ? { countedFrom: opts.countFrom!, fullWindowDays } : {};

  const index = opts.index ?? indexBookingRows(opts.rows ?? []);

  const recentBookings = pickupInWindowIndexed(index, opts.target, daysOut, windowDays);

  const perComparable: ComparablePickup[] = opts.selection.comparables.map((c) => ({
    date: c.date,
    bookings: pickupInWindowIndexed(index, c.date, daysOut, windowDays),
    tier: c.tier,
    reasons: c.reasons,
    hasData: hasAnyRowIndexed(index, c.date),
  }));
  const usableComparables = perComparable.filter((c) => c.hasData);

  const base = {
    target: opts.target,
    asOf: opts.asOf,
    daysOut,
    windowDays,
    recentBookings,
    perComparable,
    selection: opts.selection,
    ...cut,
  };

  if (usableComparables.length > 0) {
    const expectedBookings = round2(trimmedMean(usableComparables.map((c) => c.bookings)));
    return {
      ...base,
      expectedBookings,
      method: "comparable",
      classification: classifyBookingSpeed({
        recentBookings,
        expectedBookings,
        comparableCount: usableComparables.length,
      }),
    };
  }

  const momentum = estimateMomentumFallback({
    index,
    target: opts.target,
    asOf: opts.asOf,
    windowDays,
    isExcluded: opts.isExcluded,
  });

  if (momentum) {
    return {
      ...base,
      expectedBookings: momentum.expectedBookings,
      method: "momentum",
      momentum,
      classification: classifyBookingSpeed({
        recentBookings,
        expectedBookings: momentum.expectedBookings,
        comparableCount: MOMENTUM_ASSUMED_COMPARABLE_COUNT,
      }),
    };
  }

  // Truly nothing to go on: stay honest rather than guess.
  return {
    ...base,
    expectedBookings: 0,
    method: "insufficient_data",
    classification: classifyBookingSpeed({ recentBookings, expectedBookings: 0, comparableCount: 0 }),
  };
}

/* ── Explainability ──────────────────────────────────────────── */

/** Level 1: the classification sentence for this observation's window. */
export function describeObservation(obs: BookingSpeedObservation): string {
  if (obs.method === "insufficient_data") {
    const seen =
      obs.recentBookings === 0
        ? "has not received any bookings"
        : obs.recentBookings === 1
          ? "has received 1 booking"
          : `has received ${obs.recentBookings} bookings`;
    return `This stay date ${seen} in the last ${obs.windowDays} days. We do not have enough history yet to say whether that pace is unusual.`;
  }
  return describeBookingSpeed(obs.classification, { windowDays: obs.windowDays });
}

/** Level 2: where the expectation came from, in plain words. */
export function describeExpectation(obs: BookingSpeedObservation): string {
  if (obs.method === "momentum" && obs.momentum) {
    return describeMomentum(obs.momentum);
  }
  if (obs.method === "insufficient_data") {
    return "We do not have enough booking history yet for this date or its neighbors, so we are not calling out its pace as unusual either way.";
  }
  const n = obs.perComparable.filter((c) => c.hasData).length;
  const dates = n === 1 ? "1 similar past date" : `${n} similar past dates`;
  const lead =
    obs.expectedBookings < 1
      ? `Dates like this usually pick up almost no bookings ${obs.daysOut} days before arrival, based on ${dates}.`
      : `We expected about ${Math.round(obs.expectedBookings)} bookings, the typical pace across ${dates} at ${obs.daysOut} days before arrival.`;
  return `${lead} ${describeComparableSelection(obs.selection)}`;
}
