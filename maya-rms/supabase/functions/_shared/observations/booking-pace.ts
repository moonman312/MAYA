/**
 * Booking-pace milestones — how early a stay date fills up.
 *
 * Occupancy goes blind at the top: a date that sells out at a premium rate
 * and a date that sells out at a discount both read 100%, and a date that
 * races to 80% six weeks out looks identical, at arrival, to one that
 * crawled there in the final 48 hours. The booking curve tells them apart.
 * For each stay date this records the days-before-arrival at which
 * cumulative occupancy first reached each milestone (30/60/80/90 percent
 * and sellout), then composites those into a single pace score: the
 * earlier the milestones, the higher the score.
 *
 * Milestones use at-least semantics: a small property whose single next
 * booking jumps occupancy from 55% straight past 60% into 85% records BOTH
 * the 60 and 80 milestones at that booking's days-out. Nothing requires an
 * exact crossing, so thin inventories still register every threshold they
 * blow through.
 *
 * Like every season-detection input, this is deliberately price-free —
 * counts of bookings against capacity, never rates — so the signal cannot
 * be steered by MAYA's own pricing output. Pure functions, no clocks.
 */

import { bookingWindowOf, type SlimReservationRow } from "./booking-rows.ts";
import type { DailyDemand } from "./seasons.ts";

/** Occupancy fractions, ascending. Sellout is 1. */
export const PACE_OCCUPANCY_MILESTONES: readonly number[] = [0.3, 0.6, 0.8, 0.9, 1];

export interface OccupancyMilestone {
  /** Occupancy fraction (0.3 = 30 percent). */
  threshold: number;
  /** Days before arrival when occupancy first reached at least this fraction; null = never did. */
  daysOut: number | null;
}

function milestonesFromWindows(
  windowsDesc: number[],
  capacity: number,
  thresholds: readonly number[],
): OccupancyMilestone[] {
  const out: OccupancyMilestone[] = thresholds.map((t) => ({ threshold: t, daysOut: null }));
  let cumulative = 0;
  let next = 0;
  for (const bw of windowsDesc) {
    cumulative++;
    while (next < out.length && cumulative >= Math.ceil(out[next].threshold * capacity)) {
      out[next].daysOut = bw;
      next++;
    }
    if (next >= out.length) break;
  }
  return out;
}

function usableWindows(rows: SlimReservationRow[], stayDate: string): number[] {
  const windows: number[] = [];
  for (const row of rows) {
    if (row.stay_date !== stayDate) continue;
    const bw = bookingWindowOf(row);
    if (bw !== null && bw >= 0) windows.push(bw);
  }
  return windows.sort((a, b) => b - a);
}

/**
 * Days-before-arrival at which `stayDate` first reached each occupancy
 * milestone, from the slim reservation rows.
 */
export function occupancyMilestones(
  rows: SlimReservationRow[],
  stayDate: string,
  capacity: number,
  thresholds: readonly number[] = PACE_OCCUPANCY_MILESTONES,
): OccupancyMilestone[] {
  if (capacity <= 0) throw new Error("occupancyMilestones requires a positive capacity");
  return milestonesFromWindows(usableWindows(rows, stayDate), capacity, thresholds);
}

/**
 * Composite pace score: the milestone days-outs summed, unreached
 * milestones contributing nothing. Monotone in demand pressure — filling
 * earlier through more milestones always scores higher — and price-free.
 */
export function paceScore(milestones: OccupancyMilestone[]): number {
  return milestones.reduce((sum, m) => sum + (m.daysOut ?? 0), 0);
}

/**
 * Pace score per stay date across all rows — shaped as a DailyDemand
 * series so it feeds straight into detectSeasons's `pace` option. Only
 * pass FULLY OBSERVED stay dates (history), never still-booking future
 * dates, whose truncated curves would read as artificially slow.
 */
export function dailyPaceSeries(
  rows: SlimReservationRow[],
  capacity: number,
  thresholds: readonly number[] = PACE_OCCUPANCY_MILESTONES,
): DailyDemand[] {
  if (capacity <= 0) throw new Error("dailyPaceSeries requires a positive capacity");
  const byDate = new Map<string, number[]>();
  for (const row of rows) {
    const bw = bookingWindowOf(row);
    if (bw === null || bw < 0) continue;
    const list = byDate.get(row.stay_date);
    if (list) list.push(bw);
    else byDate.set(row.stay_date, [bw]);
  }
  const out: DailyDemand[] = [];
  for (const [stay_date, windows] of byDate) {
    windows.sort((a, b) => b - a);
    out.push({ stay_date, value: paceScore(milestonesFromWindows(windows, capacity, thresholds)) });
  }
  return out.sort((a, b) => a.stay_date.localeCompare(b.stay_date));
}

/* ── Explainability ──────────────────────────────────────────── */

function milestoneName(threshold: number): string {
  return threshold >= 1 ? "fully booked" : `${Math.round(threshold * 100)} percent booked`;
}

function daysOutPhrase(daysOut: number): string {
  if (daysOut === 0) return "on the day of arrival";
  if (daysOut === 1) return "1 day before arrival";
  return `${daysOut} days before arrival`;
}

/** Plain-words read of one date's booking curve — no math symbols. */
export function describeBookingPace(milestones: OccupancyMilestone[]): string {
  const neverClause = (threshold: number) =>
    threshold >= 1 ? "never fully booked" : `never reached ${Math.round(threshold * 100)} percent booked`;
  const reached = milestones.filter((m) => m.daysOut !== null);
  if (reached.length === 0) {
    return `This date ${neverClause(milestones[0]?.threshold ?? 0.3)}.`;
  }
  const parts = reached.map((m) => `${milestoneName(m.threshold)} ${daysOutPhrase(m.daysOut as number)}`);
  const listed =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  const firstMissed = milestones.find((m) => m.daysOut === null);
  const tail = firstMissed ? ` It ${neverClause(firstMissed.threshold)}.` : "";
  return `This date was ${listed}.${tail}`;
}
