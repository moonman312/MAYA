/**
 * What `reservations` already holds for a ThinkReservations reservation,
 * read back so a sync can compare it with what Think says now. The Think
 * version of cloudbeds/stored-rooms.ts.
 *
 * Rows are keyed `<reservationId>:<bookingId>`, one booking per room (and
 * the bare reservation id from an earlier keying). The sync used to vouch
 * only for the keys it had just written: a room taken off a reservation is
 * not in the fresh answer, so its key was never among them and its nights
 * stayed booked for good, and a cancellation deleted only the keys of the
 * rooms still listed on it. Read by reservation instead, every stored room
 * is seen.
 *
 * Only reservation ids of letters, digits, `-` and `_` are looked up, so the
 * id can sit in a PostgREST filter unquoted. The LIKE pattern is wider than
 * the rule (`_` matches any character), so rows are matched again here by
 * exact prefix. Nothing here deletes on its own say-so; a failed read is
 * returned and the caller stops.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Reservations asked about in one read. Two conditions each, so the URL stays a few kB. */
const RESERVATIONS_PER_READ = 25;
const READ_PAGE = 1000;
const DELETE_IN_CHUNK = 200;

/** A Think reservation id this module will put in a filter. */
export function isThinkLookupId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/** The reservation a stored row belongs to: the part before the first `:`, or the whole bare id. */
export function thinkReservationOf(rowKey: string): string {
  const at = rowKey.indexOf(":");
  return at < 0 ? rowKey : rowKey.slice(0, at);
}

/** Whether a stored row key is this reservation's: its bare id or `<id>:<bookingId>`. */
function belongsTo(rowKey: string, reservationId: string): boolean {
  return rowKey === reservationId || rowKey.startsWith(`${reservationId}:`);
}

/** Reservation id, then the row keys stored under it, then their nights. */
export type StoredThinkRows = Map<string, Map<string, Set<string>>>;

/**
 * Every stored row key of the given reservations, with its nights. A
 * reservation with nothing stored has no entry; one whose id is not a
 * lookup id is not read at all.
 */
export async function loadStoredThinkRows(
  supabase: SupabaseClient,
  hotelId: string,
  reservationIds: Iterable<string>,
): Promise<{ reservations: StoredThinkRows; error: { message: string } | null }> {
  const ids = [...new Set(reservationIds)].filter(isThinkLookupId);
  const reservations: StoredThinkRows = new Map();
  for (let i = 0; i < ids.length; i += RESERVATIONS_PER_READ) {
    const chunk = ids.slice(i, i + RESERVATIONS_PER_READ);
    const either = chunk
      .flatMap((id) => [`external_reservation_id.eq.${id}`, `external_reservation_id.like."${id}:*"`])
      .join(",");
    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await supabase
        .from("reservations")
        .select("external_reservation_id, stay_date")
        .eq("hotel_id", hotelId)
        .or(either)
        // OFFSET pages need a total order; this is the unique key's.
        .order("external_reservation_id", { ascending: true })
        .order("stay_date", { ascending: true })
        .range(from, from + READ_PAGE - 1);
      if (error) return { reservations, error: { message: `stored think rows read: ${error.message}` } };
      for (const row of data ?? []) {
        const rowKey = String(row.external_reservation_id);
        const owner = chunk.find((id) => belongsTo(rowKey, id));
        if (!owner) continue;
        let keys = reservations.get(owner);
        if (!keys) reservations.set(owner, (keys = new Map()));
        let nights = keys.get(rowKey);
        if (!nights) keys.set(rowKey, (nights = new Set()));
        nights.add(String(row.stay_date).slice(0, 10));
      }
      if ((data ?? []).length < READ_PAGE) break;
    }
  }
  return { reservations, error: null };
}

/**
 * The reservations with a night stored from `fromDate` through `toDate`,
 * and the row keys and nights each holds there. Only per-booking keys
 * (`<id>:<bookingId>`, the keying the sync writes) of a lookup id count: a
 * bare key is from an earlier keying, or a row no Think sync wrote.
 */
export async function loadStoredThinkReservationsBetween(
  supabase: SupabaseClient,
  hotelId: string,
  fromDate: string,
  toDate: string,
): Promise<{ reservations: StoredThinkRows; error: { message: string } | null }> {
  const reservations: StoredThinkRows = new Map();
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await supabase
      .from("reservations")
      .select("external_reservation_id, stay_date")
      .eq("hotel_id", hotelId)
      .gte("stay_date", fromDate)
      .lte("stay_date", toDate)
      .order("external_reservation_id", { ascending: true })
      .order("stay_date", { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) return { reservations, error: { message: `stored think reservations read: ${error.message}` } };
    for (const row of data ?? []) {
      const rowKey = String(row.external_reservation_id);
      if (!rowKey.includes(":")) continue;
      const owner = thinkReservationOf(rowKey);
      if (!isThinkLookupId(owner)) continue;
      let keys = reservations.get(owner);
      if (!keys) reservations.set(owner, (keys = new Map()));
      let nights = keys.get(rowKey);
      if (!nights) keys.set(rowKey, (nights = new Set()));
      nights.add(String(row.stay_date).slice(0, 10));
    }
    if ((data ?? []).length < READ_PAGE) break;
  }
  return { reservations, error: null };
}

/** Delete the nights stored under these row keys: all of them, or those on or after `fromDate`. */
export async function deleteThinkNights(
  supabase: SupabaseClient,
  hotelId: string,
  rowKeys: string[],
  fromDate: string | null = null,
): Promise<{ error: { message: string } | null }> {
  for (let i = 0; i < rowKeys.length; i += DELETE_IN_CHUNK) {
    let query = supabase.from("reservations").delete().eq("hotel_id", hotelId);
    if (fromDate) query = query.gte("stay_date", fromDate);
    const { error } = await query.in("external_reservation_id", rowKeys.slice(i, i + DELETE_IN_CHUNK));
    if (error) return { error };
  }
  return { error: null };
}
