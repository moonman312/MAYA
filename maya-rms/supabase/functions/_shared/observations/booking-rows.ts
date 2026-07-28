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

function bookingWindowOf(row: SlimReservationRow): number | null {
  if (typeof row.booking_window_days === "number") return row.booking_window_days;
  if (row.booking_date) return daysBetween(row.booking_date, row.stay_date);
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
