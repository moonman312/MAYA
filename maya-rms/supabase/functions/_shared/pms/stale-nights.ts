/**
 * Delete stored reservation nights a fresh read no longer has.
 *
 * `keep` maps each external_reservation_id the caller speaks for to the stay
 * dates it just wrote under that id. Every other stored night under those ids
 * goes, an empty set meaning all of them. Callers decide which ids they can
 * vouch for; this only does the read-back and the deletes.
 *
 * One DELETE per reservation would be most of a run's round trips, spent on
 * rows that almost never exist, so the stored nights are read back, diffed,
 * and the leftovers deleted grouped by night: a date change costs one
 * statement instead of one per booking.
 *
 * Shared by the Cloudbeds live sync and the onboarding history import.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const IN_CHUNK = 200;
const READ_PAGE = 1000;

export async function deleteNightsOutside(
  supabase: SupabaseClient,
  hotelId: string,
  keep: Map<string, Set<string>>,
): Promise<{ deleted: number; error: { message: string } | null }> {
  const extIds = [...keep.keys()];
  const staleByDate = new Map<string, string[]>();
  for (let i = 0; i < extIds.length; i += IN_CHUNK) {
    const chunk = extIds.slice(i, i + IN_CHUNK);
    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await supabase
        .from("reservations")
        .select("external_reservation_id, stay_date")
        .eq("hotel_id", hotelId)
        .in("external_reservation_id", chunk)
        // OFFSET pages need a total order: without one, rows written between
        // two pages can shift a row past the boundary and it is never seen.
        // This is the reservations unique key's order.
        .order("external_reservation_id", { ascending: true })
        .order("stay_date", { ascending: true })
        .range(from, from + READ_PAGE - 1);
      if (error) return { deleted: 0, error };
      for (const row of data ?? []) {
        const extId = String(row.external_reservation_id);
        const stayDate = String(row.stay_date);
        if (keep.get(extId)?.has(stayDate)) continue;
        const ids = staleByDate.get(stayDate);
        if (ids) ids.push(extId);
        else staleByDate.set(stayDate, [extId]);
      }
      if ((data ?? []).length < READ_PAGE) break;
    }
  }

  let deleted = 0;
  for (const [stayDate, ids] of staleByDate) {
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const { error } = await supabase
        .from("reservations")
        .delete()
        .eq("hotel_id", hotelId)
        .eq("stay_date", stayDate)
        .in("external_reservation_id", chunk);
      if (error) return { deleted, error };
      deleted += chunk.length;
    }
  }
  return { deleted, error: null };
}
