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
import { hasAnyRow, pickupInWindow, round2, type SlimReservationRow } from "./booking-rows.ts";

export const MOMENTUM_RADIUS_DAYS = 10;
/**
 * Approximate — a fixed 365-day offset drifts by a day across leap years.
 * Fine for a fallback that is already trading precision for coverage.
 */
export const MOMENTUM_YEAR_OFFSET_DAYS = 365;
/** Momentum needs at least this many neighbor dates with any real history behind them. */
export const MOMENTUM_MIN_NEIGHBORS = 2;
export const MOMENTUM_RATIO_FLOOR = 0.15;
export const MOMENTUM_RATIO_CEILING = 6;
/** Always below the classifier's full-range threshold, so its thin-history guard stays engaged. */
export const MOMENTUM_ASSUMED_COMPARABLE_COUNT = 1;

export type MomentumBaselineSource = "target_year_ago" | "neighbor_pace";

export interface MomentumEstimate {
  expectedBookings: number;
  /** Recent neighbor pace over year-ago neighbor pace, clamped. 1 = no evidence of change. */
  momentumRatio: number;
  neighborsUsed: number;
  naiveBaselineBookings: number;
  baselineSource: MomentumBaselineSource;
}

export interface EstimateMomentumOptions {
  rows: SlimReservationRow[];
  target: string;
  asOf: string;
  windowDays: number;
  radiusDays?: number;
  isExcluded?: (date: string) => boolean;
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
    if (isExcluded(d)) continue;
    if (holidayContextForDate(d) !== null) continue;
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

  let recentTotal = 0;
  let historicalTotal = 0;
  let neighborsUsed = 0;
  const neighborRecentPaces: number[] = [];

  for (const neighbor of neighbors) {
    if (!hasAnyRow(opts.rows, neighbor)) continue;

    const neighborDaysOut = daysBetween(opts.asOf, neighbor);
    const recent = pickupInWindow(opts.rows, neighbor, neighborDaysOut, opts.windowDays);
    neighborsUsed++;
    recentTotal += recent;
    neighborRecentPaces.push(recent);

    const priorAsOf = addDays(opts.asOf, -MOMENTUM_YEAR_OFFSET_DAYS);
    const priorNeighbor = addDays(neighbor, -MOMENTUM_YEAR_OFFSET_DAYS);
    const priorDaysOut = daysBetween(priorAsOf, priorNeighbor);
    if (priorDaysOut >= 0 && hasAnyRow(opts.rows, priorNeighbor)) {
      historicalTotal += pickupInWindow(opts.rows, priorNeighbor, priorDaysOut, opts.windowDays);
    }
  }

  if (neighborsUsed < MOMENTUM_MIN_NEIGHBORS) return null;

  // No year-ago baseline anywhere nearby means no evidence of a pace
  // change either way — neutral, not a runaway ratio from dividing by zero.
  const momentumRatio =
    historicalTotal > 0
      ? Math.min(MOMENTUM_RATIO_CEILING, Math.max(MOMENTUM_RATIO_FLOOR, recentTotal / historicalTotal))
      : 1;

  const priorAsOf = addDays(opts.asOf, -MOMENTUM_YEAR_OFFSET_DAYS);
  const priorTarget = addDays(opts.target, -MOMENTUM_YEAR_OFFSET_DAYS);
  const priorTargetDaysOut = daysBetween(priorAsOf, priorTarget);

  let naiveBaselineBookings: number;
  let baselineSource: MomentumBaselineSource;
  if (priorTargetDaysOut >= 0 && hasAnyRow(opts.rows, priorTarget)) {
    naiveBaselineBookings = pickupInWindow(opts.rows, priorTarget, priorTargetDaysOut, opts.windowDays);
    baselineSource = "target_year_ago";
  } else {
    naiveBaselineBookings =
      neighborRecentPaces.reduce((a, b) => a + b, 0) / neighborRecentPaces.length;
    baselineSource = "neighbor_pace";
  }

  return {
    expectedBookings: round2(Math.max(0, naiveBaselineBookings * momentumRatio)),
    momentumRatio: round2(momentumRatio),
    neighborsUsed,
    naiveBaselineBookings: round2(naiveBaselineBookings),
    baselineSource,
  };
}

/** Level 1/2 explanation for a momentum-derived expectation — plain words only. */
export function describeMomentum(est: MomentumEstimate): string {
  const lead =
    "We did not have enough matching history for this exact date, so we looked at booking momentum from neighboring dates instead.";
  const pace =
    est.momentumRatio > 1.05
      ? "Nearby dates are booking faster than they were around this time last year."
      : est.momentumRatio < 0.95
        ? "Nearby dates are booking slower than they were around this time last year."
        : "Nearby dates are booking at about the same pace as a year ago.";
  const baseline =
    est.baselineSource === "target_year_ago"
      ? "We started from what this date itself did a year ago and adjusted for that trend."
      : "We do not have a year-ago baseline for this exact date either, so we used the current pace of nearby dates as our best estimate.";
  return `${lead} ${pace} ${baseline}`;
}
