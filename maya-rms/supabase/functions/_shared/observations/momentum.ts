/**
 * Momentum fallback for the expected-bookings pipeline.
 *
 * When a stay date has too few genuine comparable dates — a brand-new date
 * type, thin history, or a property still building up its track record —
 * jumping straight to an ever-wider historical search throws away a
 * simpler, often better signal first: how NEARBY dates on the calendar are
 * pacing right now, versus how they paced around this same time a year ago.
 * That ratio — booking momentum — gets applied to whatever single-instance
 * baseline exists for the target itself, or, failing that, to the
 * neighbors' own current pace.
 *
 * This deliberately trades precision for coverage. It is the fallback of
 * last resort before "we don't know," not a replacement for the real
 * comparable-date matcher — expected-bookings.ts only reaches for it when
 * selectComparableDates has already tried every relaxation tier and still
 * came up short.
 */

import { addDays, daysBetween, holidayContextForDate } from "./calendar.ts";
import { hasAnyRow, pickupInWindow, round2, trimmedMean, type SlimReservationRow } from "./booking-rows.ts";

export const MOMENTUM_RADIUS_DAYS = 10;
/**
 * 52 weeks, not 365 days: this keeps day-of-week aligned exactly
 * (52*7=364), which matters far more for a same-time-last-year pickup
 * comparison than hitting the exact solar-calendar anniversary. A fixed
 * 365-day offset silently compares a Saturday against a Friday every
 * single ordinary year (365 mod 7 = 1, not just across leap years), baking
 * a persistent weekend-vs-weekday bias into what's supposed to be a pace
 * comparison.
 */
export const MOMENTUM_YEAR_OFFSET_DAYS = 364;
/** Momentum needs at least this many neighbor dates with any real history behind them. */
export const MOMENTUM_MIN_NEIGHBORS = 2;
export const MOMENTUM_RATIO_FLOOR = 0.15;
export const MOMENTUM_RATIO_CEILING = 6;
/** Always below the classifier's full-range threshold, so its thin-history guard stays engaged. */
export const MOMENTUM_ASSUMED_COMPARABLE_COUNT = 1;
/** Below this many matched pairs (or this many neighbor-pace samples), describeMomentum adds an honest small-sample caveat. */
export const MOMENTUM_LOW_CONFIDENCE_SAMPLES = 3;

export type MomentumBaselineSource = "target_year_ago" | "neighbor_pace";

/** One neighbor pairing the momentum ratio is built from — kept so the read is falsifiable date by date. */
export interface MomentumPair {
  date: string;
  bookings: number;
  yearAgoDate: string;
  yearAgoBookings: number;
}

export interface MomentumEstimate {
  expectedBookings: number;
  /** Recent neighbor pace over year-ago neighbor pace, clamped. 1 = no evidence of change. */
  momentumRatio: number;
  neighborsUsed: number;
  /** How many neighbors actually had BOTH a current and a year-ago usable comparison — what momentumRatio is built from. */
  matchedPairs: number;
  /** The actual pairings behind momentumRatio, so an owner can challenge any date that was not normal. */
  pairs: MomentumPair[];
  naiveBaselineBookings: number;
  baselineSource: MomentumBaselineSource;
  /** The date the baseline came from when baselineSource is "target_year_ago"; null for neighbor_pace. */
  baselineDate: string | null;
}

export interface EstimateMomentumOptions {
  rows: SlimReservationRow[];
  target: string;
  asOf: string;
  windowDays: number;
  radiusDays?: number;
  isExcluded?: (date: string) => boolean;
}

/** Not a holiday and not caller-excluded — safe to use as a comparison point on either side of a momentum pairing. */
function isUsableComparisonDate(date: string, isExcluded: (d: string) => boolean): boolean {
  return !isExcluded(date) && holidayContextForDate(date) === null;
}

/**
 * Neighbor dates within `radiusDays` of the target: still upcoming (so their
 * live pace is measurable the same way as the target's), not holiday
 * context, not excluded, and not the target itself.
 */
function neighborDates(
  target: string,
  asOf: string,
  radiusDays: number,
  isExcluded: (d: string) => boolean,
): string[] {
  const out: string[] = [];
  for (let offset = -radiusDays; offset <= radiusDays; offset++) {
    if (offset === 0) continue;
    const d = addDays(target, offset);
    if (d < asOf) continue;
    if (!isUsableComparisonDate(d, isExcluded)) continue;
    out.push(d);
  }
  return out;
}

/**
 * Booking momentum estimate: how nearby dates are pacing right now versus a
 * year ago, applied to the best available single-instance baseline. Returns
 * null when there is nothing at all to reason from — not enough neighbor
 * dates with any history behind them (a brand-new property, or a date
 * deep in a sparsely-booked future with nothing nearby to lean on).
 */
export function estimateMomentumFallback(opts: EstimateMomentumOptions): MomentumEstimate | null {
  const radiusDays = opts.radiusDays ?? MOMENTUM_RADIUS_DAYS;
  const isExcluded = opts.isExcluded ?? (() => false);

  const neighbors = neighborDates(opts.target, opts.asOf, radiusDays, isExcluded);

  let neighborsUsed = 0;
  let matchedRecentTotal = 0;
  let matchedHistoricalTotal = 0;
  const pairs: MomentumPair[] = [];
  const neighborRecentPaces: number[] = [];

  for (const neighbor of neighbors) {
    if (!hasAnyRow(opts.rows, neighbor)) continue;

    const neighborDaysOut = daysBetween(opts.asOf, neighbor);
    const recent = pickupInWindow(opts.rows, neighbor, neighborDaysOut, opts.windowDays);
    neighborsUsed++;
    neighborRecentPaces.push(recent);

    // Only pair a neighbor into the ratio when its year-ago counterpart is
    // itself a usable comparison point — otherwise recentTotal ends up
    // summing a different (larger) population of dates than
    // historicalTotal, which silently inflates or deflates the ratio
    // toward whichever side happens to have more data behind it.
    const priorAsOf = addDays(opts.asOf, -MOMENTUM_YEAR_OFFSET_DAYS);
    const priorNeighbor = addDays(neighbor, -MOMENTUM_YEAR_OFFSET_DAYS);
    const priorDaysOut = daysBetween(priorAsOf, priorNeighbor);
    if (
      priorDaysOut >= 0 &&
      hasAnyRow(opts.rows, priorNeighbor) &&
      isUsableComparisonDate(priorNeighbor, isExcluded)
    ) {
      const historical = pickupInWindow(opts.rows, priorNeighbor, priorDaysOut, opts.windowDays);
      matchedRecentTotal += recent;
      matchedHistoricalTotal += historical;
      pairs.push({
        date: neighbor,
        bookings: recent,
        yearAgoDate: priorNeighbor,
        yearAgoBookings: historical,
      });
    }
  }

  if (neighborsUsed < MOMENTUM_MIN_NEIGHBORS) return null;

  // No matched pair anywhere nearby means no evidence of a pace change
  // either way — neutral, not a runaway ratio from mismatched populations.
  const momentumRatio =
    pairs.length > 0 && matchedHistoricalTotal > 0
      ? Math.min(MOMENTUM_RATIO_CEILING, Math.max(MOMENTUM_RATIO_FLOOR, matchedRecentTotal / matchedHistoricalTotal))
      : 1;

  const priorAsOf = addDays(opts.asOf, -MOMENTUM_YEAR_OFFSET_DAYS);
  const priorTarget = addDays(opts.target, -MOMENTUM_YEAR_OFFSET_DAYS);
  const priorTargetDaysOut = daysBetween(priorAsOf, priorTarget);

  let naiveBaselineBookings: number;
  let baselineSource: MomentumBaselineSource;
  let baselineDate: string | null;
  if (
    priorTargetDaysOut >= 0 &&
    hasAnyRow(opts.rows, priorTarget) &&
    isUsableComparisonDate(priorTarget, isExcluded)
  ) {
    naiveBaselineBookings = pickupInWindow(opts.rows, priorTarget, priorTargetDaysOut, opts.windowDays);
    baselineSource = "target_year_ago";
    baselineDate = priorTarget;
  } else {
    naiveBaselineBookings = trimmedMean(neighborRecentPaces);
    baselineSource = "neighbor_pace";
    baselineDate = null;
  }

  return {
    expectedBookings: round2(Math.max(0, naiveBaselineBookings * momentumRatio)),
    momentumRatio: round2(momentumRatio),
    neighborsUsed,
    matchedPairs: pairs.length,
    pairs,
    naiveBaselineBookings: round2(naiveBaselineBookings),
    baselineSource,
    baselineDate,
  };
}

/** Level 1/2 explanation for a momentum-derived expectation — plain words only. */
export function describeMomentum(est: MomentumEstimate): string {
  const lead =
    "We did not have enough matching history for this exact date, so we looked at booking momentum from neighboring dates instead.";
  const pace =
    est.matchedPairs === 0
      ? "We do not have a year-ago comparison for any of those nearby dates, so we cannot say whether the pace has changed."
      : est.momentumRatio > 1.05
        ? "Nearby dates are booking faster than they were around this time last year."
        : est.momentumRatio < 0.95
          ? "Nearby dates are booking slower than they were around this time last year."
          : "Nearby dates are booking at about the same pace as a year ago.";
  const baseline =
    est.baselineSource === "target_year_ago"
      ? "We started from what this date itself did a year ago and adjusted for that trend."
      : "We do not have a year-ago baseline for this exact date either, so we used the current pace of nearby dates as our best estimate.";
  const sampleSize = est.baselineSource === "target_year_ago" ? est.matchedPairs : est.neighborsUsed;
  const caveat =
    sampleSize > 0 && sampleSize < MOMENTUM_LOW_CONFIDENCE_SAMPLES
      ? " This is based on very little data, so treat it as a rough guide rather than a firm number."
      : "";
  return `${lead} ${pace} ${baseline}${caveat}`;
}
