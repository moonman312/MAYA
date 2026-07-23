/**
 * Stay-date snapshot writer and retention — Implementation Guide §3.5, §11 step 1.
 * Deno-portable copy of src/lib/engine/snapshots.ts (import paths only differ).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomTypeRow, SnapshotRow } from "./types.ts";

/**
 * Fetch ALL rows for a query, paging past Supabase's "Max rows" API cap
 * (default 1000). `makeQuery` must return a fresh query builder with a STABLE
 * `.order(...)` applied (so page ranges don't overlap or skip rows); this
 * helper only appends `.range()`. Without this, bulk reads silently truncate
 * at 1000 rows — which capped the reservation reads at ~19 days.
 */
// deno-lint-ignore no-explicit-any
export async function fetchAllRows(makeQuery: () => any, pageSize = 1000): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const all: any[] = [];
  let from = 0;
  let guard = 0;
  for (;;) {
    if (++guard > 1000) break; // safety backstop (~1M rows)
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/**
 * Insert one snapshot row per (stay_date, room_type) across the full horizon
 * for a single hotel. Uses a consistent snapshot_ts for the whole run.
 */
export async function snapshotCurrentState(
  supabase: SupabaseClient,
  hotelId: string,
  snapshotTs: string,
  stayDates: string[],
  roomTypes: RoomTypeRow[],
): Promise<void> {
  if (stayDates.length === 0 || roomTypes.length === 0) return;

  // §15.8: same snapshot_ts must not duplicate rows on re-run.
  const { error: delErr } = await supabase
    .from("stay_date_snapshot")
    .delete()
    .eq("hotel_id", hotelId)
    .eq("snapshot_ts", snapshotTs);
  if (delErr) throw new Error(`Snapshot delete (idempotent) failed: ${delErr.message}`);

  const rtIds = roomTypes.map((rt) => rt.id);

  // Aggregate booked_units and booked_revenue per (stay_date, room_type_id).
  // Paginated (ordered by PK) so we never truncate at the 1000-row API cap.
  const agg = await fetchAllRows(() =>
    supabase
      .from("reservations")
      .select("stay_date, room_type_id, current_rate")
      .eq("hotel_id", hotelId)
      .in("stay_date", stayDates)
      .in("room_type_id", rtIds)
      .order("id", { ascending: true }),
  );

  const bookedMap = new Map<string, { units: number; revenue: number }>();
  for (const row of agg) {
    const key = `${row.stay_date}|${row.room_type_id}`;
    const entry = bookedMap.get(key) ?? { units: 0, revenue: 0 };
    entry.units += 1;
    entry.revenue += Number(row.current_rate ?? 0);
    bookedMap.set(key, entry);
  }

  const rows: SnapshotRow[] = [];
  for (const sd of stayDates) {
    for (const rt of roomTypes) {
      const key = `${sd}|${rt.id}`;
      const booked = bookedMap.get(key) ?? { units: 0, revenue: 0 };
      rows.push({
        hotel_id: hotelId,
        snapshot_ts: snapshotTs,
        stay_date: sd,
        room_type_id: rt.id,
        sellable_units: rt.total_rooms,
        booked_units: booked.units,
        booked_revenue: Math.round(booked.revenue * 100) / 100,
      });
    }
  }

  // Batch insert in chunks to avoid payload limits.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("stay_date_snapshot").insert(chunk);
    if (error) throw new Error(`Snapshot insert failed: ${error.message}`);
  }
}

export type SnapshotRowAt = {
  booked_units: number;
  booked_revenue: number;
  snapshot_ts: string;
};

/**
 * Find the nearest snapshot at or before the given timestamp for a set of
 * (hotel, stay_date, room_type) tuples.
 */
export async function findSnapshotAt(
  supabase: SupabaseClient,
  hotelId: string,
  stayDate: string,
  roomTypeIds: string[],
  atOrBefore: string,
): Promise<Map<string, SnapshotRowAt>> {
  const result = new Map<string, SnapshotRowAt>();

  for (const rtId of roomTypeIds) {
    const { data } = await supabase
      .from("stay_date_snapshot")
      .select("booked_units, booked_revenue, snapshot_ts")
      .eq("hotel_id", hotelId)
      .eq("stay_date", stayDate)
      .eq("room_type_id", rtId)
      .lte("snapshot_ts", atOrBefore)
      .order("snapshot_ts", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      result.set(rtId, {
        booked_units: Number(data.booked_units),
        booked_revenue: Number(data.booked_revenue),
        snapshot_ts: String(data.snapshot_ts),
      });
    }
  }

  return result;
}

/**
 * Purge snapshots older than the retention window (default 60 days).
 * §3.5 — default 60d; pass max(pickup_window_days)+7 when known.
 */
export async function purgeOldSnapshots(
  supabase: SupabaseClient,
  hotelId: string,
  retentionDays: number = 60,
): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const { error } = await supabase
    .from("stay_date_snapshot")
    .delete()
    .eq("hotel_id", hotelId)
    .lt("snapshot_ts", cutoff.toISOString());

  if (error) throw new Error(`Snapshot purge failed: ${error.message}`);
}
