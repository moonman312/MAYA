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
import {
  describeComparableSelection,
  type ComparableSelection,
} from "./comparable-dates.ts";

export const DEFAULT_WINDOW_DAYS = 7;

export interface SlimReservationRow {
  stay_date: string;
  booking_date?: string | null;
  booking_window_days?: number | null;
}

/** Days from booking to stay, from whichever field the row carries. */
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

export interface ComparablePickup {
  date: string;
  bookings: number;
  tier: number;
  reasons: string[];
}

export interface BookingSpeedObservation {
  target: string;
  asOf: string;
  daysOut: number;
  windowDays: number;
  recentBookings: number;
  expectedBookings: number;
  perComparable: ComparablePickup[];
  selection: ComparableSelection;
  classification: BookingSpeedClassification;
}

export interface ObserveBookingSpeedOptions {
  rows: SlimReservationRow[];
  target: string;
  asOf: string;
  selection: ComparableSelection;
  windowDays?: number;
}

/**
 * The full Layer 1 pipeline for one stay date: recent pickup, per-comparable
 * pickup over the matching booking-curve stretch, trimmed-mean expectation,
 * and the classified Booking Speed. The returned object is the audit
 * snapshot — persist it with the evaluation so explanations replay what was
 * actually known, not what is known later.
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
  }));

  const expectedBookings =
    Math.round(trimmedMean(perComparable.map((c) => c.bookings)) * 100) / 100;

  const classification = classifyBookingSpeed({
    recentBookings,
    expectedBookings,
    comparableCount: perComparable.length,
  });

  return {
    target: opts.target,
    asOf: opts.asOf,
    daysOut,
    windowDays,
    recentBookings,
    expectedBookings,
    perComparable,
    selection: opts.selection,
    classification,
  };
}

/* ── Explainability ──────────────────────────────────────────── */

/** Level 1: the classification sentence for this observation's window. */
export function describeObservation(obs: BookingSpeedObservation): string {
  return describeBookingSpeed(obs.classification, { windowDays: obs.windowDays });
}

/** Level 2: where the expectation came from, in plain words. */
export function describeExpectation(obs: BookingSpeedObservation): string {
  const n = obs.perComparable.length;
  const dates = n === 1 ? "1 similar past date" : `${n} similar past dates`;
  const lead =
    obs.expectedBookings < 1
      ? `Dates like this usually pick up almost no bookings ${obs.daysOut} days before arrival, based on ${dates}.`
      : `We expected about ${Math.round(obs.expectedBookings)} bookings, the typical pace across ${dates} at ${obs.daysOut} days before arrival.`;
  return `${lead} ${describeComparableSelection(obs.selection)}`;
}
