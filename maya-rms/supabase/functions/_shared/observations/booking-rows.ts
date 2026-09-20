/**
 * Shared booking-row primitives used by both the expected-bookings pipeline
 * and its momentum fallback. Split out so the two can import each other's
 * types without a circular module dependency.
 *
 * THE UNIT IS A BOOKING, NOT A ROOM (Jake, 2026-09-20). Reservation rows are
 * one per room per night. A 20-room wedding reservation is twenty rows on
 * each of its nights and one booking: it counts once for booking speed, live
 * and in the history it is compared with, while occupancy keeps counting its
 * twenty rooms. The rows of one booking are found by bookingKeyOf, and the
 * booking is counted at its earliest booking date across its rooms on that
 * stay date, so rooms added to it later never read as new bookings. The
 * database does the same in booking_speed_windows
 * (99_supabase_migration_booking_speed_counts_bookings_v1.sql), with the
 * same rule in booking_key(); the two must never drift.
 *
 * Season detection still measures rooms: how full nights got against room
 * capacity (indexRoomRows, booking-pace.ts).
 */

import { daysBetween } from "./calendar.ts";

export const DEFAULT_WINDOW_DAYS = 7;

export interface SlimReservationRow {
  stay_date: string;
  booking_date?: string | null;
  booking_window_days?: number | null;
  /**
   * The PMS row id (reservations.external_reservation_id). Rows of one
   * booking share a key, see bookingKeyOf. Absent or null: the row is a
   * booking of its own.
   */
  external_reservation_id?: string | null;
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
 * The booking a reservation row belongs to, from its id alone. The only
 * copy of this rule in TypeScript; public.booking_key() is the only copy in
 * SQL, and the PGlite suite holds the two to each other.
 *
 * The shapes, verified against the parsers:
 * - Think: `<reservationId>:<bookingId>` (think/etl.ts externalIdAt), one
 *   row per booking (room) of the reservation. The part before the colon.
 * - Cloudbeds: `<reservationID>-<n>` for every room slot the parsers key
 *   (cloudbeds/etl.ts cloudbedsRoomRowIds), or a bare `<reservationID>` on
 *   rows written before rooms were keyed. A reservationID is digits with no
 *   hyphen, so the part before the one hyphen, when what follows it is a
 *   number.
 * - Mews: one reservation per row, ids are GUIDs (four hyphens, never a
 *   plain `-<n>` tail). Never grouped, as decided: a Mews reservation is one
 *   room.
 * Anything else, the seeded `cb-260920-0001234` style ids included, is its
 * own booking.
 */
export function bookingKeyOf(externalReservationId: string): string {
  const colon = externalReservationId.indexOf(":");
  if (colon !== -1) return externalReservationId.slice(0, colon);
  const room = /^([^-]+)-[0-9]+$/.exec(externalReservationId);
  return room ? room[1] : externalReservationId;
}

/**
 * A booking's window on a stay date is its earliest booking date across its
 * rooms that night, which is the longest known lead time. A room with no
 * lead time never hides one that has it.
 */
export function earliestBookingWindow(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * Bookings for `stayDate` whose booking window falls in
 * [daysOut, daysOut + windowDays) — i.e. made during that stretch of the
 * booking curve. A booking with several rooms counts once.
 */
export function pickupInWindow(
  rows: SlimReservationRow[],
  stayDate: string,
  daysOut: number,
  windowDays: number,
): number {
  return pickupInWindowIndexed(indexBookingRows(rows), stayDate, daysOut, windowDays);
}

/** True when any row at all exists for `stayDate` — distinguishes "no data" from "data says zero". */
export function hasAnyRow(rows: SlimReservationRow[], stayDate: string): boolean {
  return rows.some((r) => r.stay_date === stayDate);
}

/* ── Grouped form ────────────────────────────────────────────────
 *
 * Every consumer of the rows only ever asks two things about a stay date:
 * whether it has any row at all, and how many bookings sit at each booking
 * window. So the rows for a date collapse, losslessly for those questions,
 * to a booking count plus a (window, count) list. A 500-room property keeps
 * a few hundred of these per date instead of every room-night, and the
 * database can build them with a GROUP BY.
 */

/** How many bookings share one booking window (null = the booking has no usable lead time). */
export interface WindowCount {
  bw: number | null;
  n: number;
}

/** One stay date's bookings, grouped: `n` bookings in total, split by booking window. */
export interface StayDateWindows {
  n: number;
  windows: WindowCount[];
}

/** Grouped rows keyed by stay date. A date with no rows has no entry. */
export type BookingWindowIndex = ReadonlyMap<string, StayDateWindows>;

/**
 * Builds the grouped form a row at a time. One count per booking (unit
 * "bookings", the default: rows sharing a bookingKeyOf key on a stay date
 * are one booking at their earliest booking date) or one per row (unit
 * "rooms", the season model's fullness input).
 *
 * The rows of a stay date are held until the date is sealed, so a reader
 * that gets rows in stay-date order can seal each date as the next one
 * starts and hold one night at a time (booking-speed-provider.ts
 * loadWindowsByRows). build() seals whatever is still open. A date sealed
 * twice adds up, so never seal a date before all of its rows are in.
 */
export class StayDateWindowsBuilder {
  private readonly open = new Map<string, Map<string, number | null>>();
  private readonly counts = new Map<string, Map<number | null, number>>();
  private anonymous = 0;

  constructor(private readonly unit: "bookings" | "rooms" = "bookings") {}

  add(row: SlimReservationRow): void {
    const bw = bookingWindowOf(row);
    let byBooking = this.open.get(row.stay_date);
    if (!byBooking) {
      byBooking = new Map();
      this.open.set(row.stay_date, byBooking);
    }
    // A row without an id, or every row when counting rooms, is a booking of
    // its own, under a key no PMS id can spell (it has a space).
    const key =
      this.unit === "bookings" && row.external_reservation_id != null && row.external_reservation_id !== ""
        ? bookingKeyOf(row.external_reservation_id)
        : `row ${this.anonymous++}`;
    const prev = byBooking.get(key);
    byBooking.set(key, prev === undefined ? bw : earliestBookingWindow(prev, bw));
  }

  /** Fold a stay date's bookings into its counts and let go of them. */
  seal(stayDate: string): void {
    const byBooking = this.open.get(stayDate);
    if (!byBooking) return;
    this.open.delete(stayDate);
    let byWindow = this.counts.get(stayDate);
    if (!byWindow) {
      byWindow = new Map();
      this.counts.set(stayDate, byWindow);
    }
    for (const bw of byBooking.values()) byWindow.set(bw, (byWindow.get(bw) ?? 0) + 1);
  }

  /** The grouped form, dates in order (so no map ever depends on row order). */
  build(): Map<string, StayDateWindows> {
    for (const stayDate of [...this.open.keys()]) this.seal(stayDate);
    const out = new Map<string, StayDateWindows>();
    for (const stayDate of [...this.counts.keys()].sort()) {
      const byWindow = this.counts.get(stayDate)!;
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
}

/** Group slim rows by stay date and booking window, one count per booking. */
export function indexBookingRows(rows: SlimReservationRow[]): Map<string, StayDateWindows> {
  const builder = new StayDateWindowsBuilder("bookings");
  for (const row of rows) builder.add(row);
  return builder.build();
}

/**
 * Group slim rows by stay date and booking window, one count per row: how
 * full a night got and how early. Only the season model reads this
 * (booking-pace.ts dailyPaceSeriesFromIndex); nothing that prices a night on
 * its pace does.
 */
export function indexRoomRows(rows: SlimReservationRow[]): Map<string, StayDateWindows> {
  const builder = new StayDateWindowsBuilder("rooms");
  for (const row of rows) builder.add(row);
  return builder.build();
}

/** pickupInWindow over grouped rows: the same count, summed per window instead of per booking. */
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
