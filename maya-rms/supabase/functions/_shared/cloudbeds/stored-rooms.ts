/**
 * What `reservations` already holds for a Cloudbeds booking, read back so a
 * sync can compare it with what Cloudbeds says now.
 *
 * The sync used to vouch only for the row ids it had just written. A room
 * taken off a booking is not in the fresh answer, so its id was never among
 * them and its nights stayed booked for good; a cancellation deleted the ids
 * it could work out from the rooms still listed, which left the same rooms
 * behind. Read by booking instead, every stored room is seen, whatever id it
 * is under.
 *
 * Which rows are a booking's: the row whose id is the booking's own (rows
 * from before rooms were keyed), and every `<reservationID>-<n>`. That is
 * bookingKeyOf's rule (observations/booking-rows.ts), the one the engine
 * counts bookings by, and it is as narrow here as there: only an all-digit
 * reservation id has rooms looked up. An id of any other shape is not
 * Cloudbeds', and nothing stored is ever matched to it by prefix.
 *
 * Nothing here deletes on its own say-so. The callers decide what a read
 * vouches for; a failed read here is returned, and the caller stops.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { bookingKeyOf } from "../observations/booking-rows.ts";

/** Bookings asked about in one read. Two conditions each, so the URL stays a few kB. */
const BOOKINGS_PER_READ = 25;
const READ_PAGE = 1000;
const DELETE_IN_CHUNK = 200;

export type StoredRoom = {
  /** The subReservationID the rows' payload carries, null when they carry none (history rows keep no payload). */
  sub: string | null;
  /** When the first of its rows reached MAYA. */
  createdAt: string | null;
  nights: Set<string>;
};

/** Booking id, then row id (external_reservation_id), then what is stored under it. */
export type StoredBookings = Map<string, Map<string, StoredRoom>>;

/** An id Cloudbeds gives a reservation: digits only. */
export function isCloudbedsBookingId(id: string): boolean {
  return /^[0-9]+$/.test(id);
}

/** A row id the Cloudbeds sync writes or once wrote: the booking's own id, or `<reservationID>-<n>`. */
export function isCloudbedsRowId(id: string): boolean {
  return /^[0-9]+(-[0-9]+)?$/.test(id);
}

function subOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const sub = (payload as Record<string, unknown>).subReservationID;
  if (typeof sub === "string" && sub) return sub;
  if (typeof sub === "number" && Number.isFinite(sub)) return String(sub);
  return null;
}

/**
 * Every stored room of the given bookings. A booking with nothing stored has
 * no entry; one whose id is not Cloudbeds' is not looked up at all.
 */
export async function loadStoredRooms(
  supabase: SupabaseClient,
  hotelId: string,
  bookingIds: Iterable<string>,
): Promise<{ bookings: StoredBookings; error: { message: string } | null }> {
  const ids = [...new Set(bookingIds)].filter(isCloudbedsBookingId);
  const bookings: StoredBookings = new Map();
  for (let i = 0; i < ids.length; i += BOOKINGS_PER_READ) {
    const chunk = ids.slice(i, i + BOOKINGS_PER_READ);
    const wanted = new Set(chunk);
    const either = chunk
      .flatMap((id) => [`external_reservation_id.eq.${id}`, `external_reservation_id.like.${id}-*`])
      .join(",");
    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await supabase
        .from("reservations")
        .select("external_reservation_id, stay_date, created_at, raw_payload")
        .eq("hotel_id", hotelId)
        .or(either)
        // OFFSET pages need a total order; this is the unique key's.
        .order("external_reservation_id", { ascending: true })
        .order("stay_date", { ascending: true })
        .range(from, from + READ_PAGE - 1);
      if (error) return { bookings, error: { message: `stored rooms read: ${error.message}` } };
      for (const row of data ?? []) {
        const rowId = String(row.external_reservation_id);
        // The pattern is wider than the rule (`555-` also begins `555-2-1`).
        const booking = bookingKeyOf(rowId);
        if (!wanted.has(booking)) continue;
        let rooms = bookings.get(booking);
        if (!rooms) bookings.set(booking, (rooms = new Map()));
        let room = rooms.get(rowId);
        if (!room) rooms.set(rowId, (room = { sub: null, createdAt: null, nights: new Set() }));
        room.nights.add(String(row.stay_date).slice(0, 10));
        room.sub ??= subOf(row.raw_payload);
        const created = row.created_at != null ? String(row.created_at) : null;
        if (created && (!room.createdAt || Date.parse(created) < Date.parse(room.createdAt))) room.createdAt = created;
      }
      if ((data ?? []).length < READ_PAGE) break;
    }
  }
  return { bookings, error: null };
}

/**
 * The bookings with a night stored on or after `fromDate`, and the row ids
 * each is under. Only rows the Cloudbeds sync writes are looked at: a seeded
 * or imported row of any other shape is no booking of Cloudbeds' to miss.
 */
export async function loadStoredBookingsFrom(
  supabase: SupabaseClient,
  hotelId: string,
  fromDate: string,
): Promise<{ bookings: Map<string, Set<string>>; error: { message: string } | null }> {
  const bookings = new Map<string, Set<string>>();
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await supabase
      .from("reservations")
      .select("external_reservation_id, stay_date")
      .eq("hotel_id", hotelId)
      .gte("stay_date", fromDate)
      .order("external_reservation_id", { ascending: true })
      .order("stay_date", { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) return { bookings, error: { message: `stored bookings read: ${error.message}` } };
    for (const row of data ?? []) {
      const rowId = String(row.external_reservation_id);
      if (!isCloudbedsRowId(rowId)) continue;
      const booking = bookingKeyOf(rowId);
      const rowIds = bookings.get(booking);
      if (rowIds) rowIds.add(rowId);
      else bookings.set(booking, new Set([rowId]));
    }
    if ((data ?? []).length < READ_PAGE) break;
  }
  return { bookings, error: null };
}

/** Delete the nights on or after `fromDate` stored under these row ids. Nights before it stay. */
export async function deleteNightsFrom(
  supabase: SupabaseClient,
  hotelId: string,
  rowIds: string[],
  fromDate: string,
): Promise<{ error: { message: string } | null }> {
  for (let i = 0; i < rowIds.length; i += DELETE_IN_CHUNK) {
    const { error } = await supabase
      .from("reservations")
      .delete()
      .eq("hotel_id", hotelId)
      .gte("stay_date", fromDate)
      .in("external_reservation_id", rowIds.slice(i, i + DELETE_IN_CHUNK));
    if (error) return { error };
  }
  return { error: null };
}
