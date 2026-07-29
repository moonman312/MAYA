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
  hasAnyRow,
  pickupInWindow,
  round2,
  trimmedMean,
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
}

export interface ObserveBookingSpeedOptions {
  rows: SlimReservationRow[];
  target: string;
  asOf: string;
  selection: ComparableSelection;
  windowDays?: number;
  /** Same exclusion predicate passed to selectComparableDates — reused for momentum's neighbor search. */
  isExcluded?: (date: string) => boolean;
}

/**
 * The full Layer 1 pipeline for one stay date: recent pickup, comparable
 * pickup (or momentum fallback), and the classified Booking Speed. The
 * returned object is the audit snapshot — persist it with the evaluation so
 * explanations replay what was actually known, not what is known later.
 */
export function observeBookingSpeed(opts: ObserveBookingSpeedOptions): BookingSpeedObservation {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const daysOut = daysBetween(opts.asOf, opts.target);
  if (daysOut < 0) {
    throw new Error("booking speed target must not be in the past");
  }

  const byStayDate = new Map<string, SlimReservationRow[]>();
  for (const row of opts.rows) {
    const list = byStayDate.get(row.stay_date);
    if (list) list.push(row);
    else byStayDate.set(row.stay_date, [row]);
  }
  const rowsFor = (date: string) => byStayDate.get(date) ?? [];

  const recentBookings = pickupInWindow(rowsFor(opts.target), opts.target, daysOut, windowDays);

  const perComparable: ComparablePickup[] = opts.selection.comparables.map((c) => ({
    date: c.date,
    bookings: pickupInWindow(rowsFor(c.date), c.date, daysOut, windowDays),
    tier: c.tier,
    reasons: c.reasons,
    hasData: hasAnyRow(opts.rows, c.date),
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
    rows: opts.rows,
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
