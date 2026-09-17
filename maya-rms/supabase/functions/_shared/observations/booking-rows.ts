/**
 * Shared booking-row primitives used by both the expected-bookings pipeline
 * and its momentum fallback. Split out so the two can import each other's
 * types without a circular module dependency.
 */

import { daysBetween } from "./calendar.ts";

export const DEFAULT_WINDOW_DAYS = 7;

export interface SlimReservationRow {
  stay_date: string;
  booking_date?: string | null;
  booking_window_days?: number | null;
}

export function bookingWindowOf(row: SlimReservationRow): number | null {
  // Each night measures lead time against itself, so booking_date wins:
  // rows imported before the per-night backfill carry an arrival-relative
  // booking_window_days that is k days short for night k of a stay.
  if (row.booking_date) return daysBetween(row.booking_date, row.stay_date);
  if (typeof row.booking_window_days === "number") return row.booking_window_days;
  return null;
}

/**
 * Bookings for `stayDate` whose booking window falls in
 * [daysOut, daysOut + windowDays) — i.e. made during that stretch of the
 * booking curve.
 */
export function pickupInWindow(
  rows: SlimReservationRow[],
  stayDate: string,
  daysOut: number,
  windowDays: number,
): number {
  let count = 0;
  for (const row of rows) {
    if (row.stay_date !== stayDate) continue;
    const bw = bookingWindowOf(row);
    if (bw === null) continue;
    if (bw >= daysOut && bw < daysOut + windowDays) count++;
  }
  return count;
}

/** True when any row at all exists for `stayDate` — distinguishes "no data" from "data says zero". */
export function hasAnyRow(rows: SlimReservationRow[], stayDate: string): boolean {
  return rows.some((r) => r.stay_date === stayDate);
}

/* ── Grouped form ────────────────────────────────────────────────
 *
 * Every consumer of the rows only ever asks two things about a stay date:
 * whether it has any row at all, and how many rows sit at each booking
 * window. So the rows for a date collapse, losslessly for those questions,
 * to a row count plus a (window, count) list. A 500-room property keeps a
 * few hundred of these per date instead of every room-night, and the
 * database can build them with a GROUP BY.
 */

/** How many rows share one booking window (null = the row has no usable lead time). */
export interface WindowCount {
  bw: number | null;
  n: number;
}

/** One stay date's rows, grouped: `n` rows in total, split by booking window. */
export interface StayDateWindows {
  n: number;
  windows: WindowCount[];
}

/** Grouped rows keyed by stay date. A date with no rows has no entry. */
export type BookingWindowIndex = ReadonlyMap<string, StayDateWindows>;

/** Group slim rows by stay date and booking window. */
export function indexBookingRows(rows: SlimReservationRow[]): Map<string, StayDateWindows> {
  const counts = new Map<string, Map<number | null, number>>();
  for (const row of rows) {
    const bw = bookingWindowOf(row);
    let byWindow = counts.get(row.stay_date);
    if (!byWindow) {
      byWindow = new Map();
      counts.set(row.stay_date, byWindow);
    }
    byWindow.set(bw, (byWindow.get(bw) ?? 0) + 1);
  }
  const out = new Map<string, StayDateWindows>();
  for (const [stayDate, byWindow] of counts) {
    let n = 0;
    const windows: WindowCount[] = [];
    for (const [bw, count] of byWindow) {
      n += count;
      windows.push({ bw, n: count });
    }
    out.set(stayDate, { n, windows });
  }
  return out;
}

/** pickupInWindow over grouped rows: the same count, summed per window instead of per row. */
export function pickupInWindowIndexed(
  index: BookingWindowIndex,
  stayDate: string,
  daysOut: number,
  windowDays: number,
): number {
  const entry = index.get(stayDate);
  if (!entry) return 0;
  let count = 0;
  for (const w of entry.windows) {
    if (w.bw === null) continue;
    if (w.bw >= daysOut && w.bw < daysOut + windowDays) count += w.n;
  }
  return count;
}

/** hasAnyRow over grouped rows. */
export function hasAnyRowIndexed(index: BookingWindowIndex, stayDate: string): boolean {
  const entry = index.get(stayDate);
  return entry !== undefined && entry.n > 0;
}

/** Mean with the single min and max dropped once there are 5+ values. */
export function trimmedMean(values: number[]): number {
  if (values.length === 0) return 0;
  let vals = values;
  if (values.length >= 5) {
    const sorted = [...values].sort((a, b) => a - b);
    vals = sorted.slice(1, -1);
  }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
