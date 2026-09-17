/**
 * Stay-date snapshot writer and retention.
 *
 * Derives sellable_units / booked_units / booked_revenue per (stay_date, room_type)
 * from the reservations table and room_types.total_rooms.
 *
 * Implementation Guide §3.5, §11 step 1.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomTypeRow, SnapshotRow } from "./types";

/* ── Schema tolerance ──────────────────────────────────────────────────────
 *
 * Code and SQL ship separately and nobody promises the order. Every read of
 * a column or table that arrived in a migration has to be able to notice it
 * is running against the old schema, say so once in the log, and carry on
 * the way it did before that migration. These helpers are how each caller
 * recognises that case; the caller decides what "carry on" means.
 */

/** The migration files a pre-migration run should name in its log line. */
export const MIGRATIONS = {
  manualPrice: "99_supabase_migration_manual_price_v1.sql",
  countsAsRoom: "99_supabase_migration_room_type_counts_as_room_v1.sql",
  outOfService: "99_supabase_migration_room_type_out_of_service_v1.sql",
} as const;

type PostgrestLike = { code?: string | null; message?: string | null } | null | undefined;

/** Preserves PostgREST's `code` so callers can tell a schema gap from an outage. */
export function postgrestError(error: { code?: string | null; message?: string | null }): Error {
  const err = new Error(error.message ?? "unknown error") as Error & { code?: string };
  if (error.code) err.code = String(error.code);
  return err;
}

function codeAndMessage(e: unknown): { code: string; message: string } {
  const like = (typeof e === "object" && e !== null ? e : {}) as PostgrestLike;
  return {
    code: String(like?.code ?? ""),
    message: String(like?.message ?? (e instanceof Error ? e.message : e ?? "")),
  };
}

/** `column x does not exist` — 42703 from a select or filter, PGRST204 from a write payload. */
export function isMissingColumnError(e: unknown): boolean {
  const { code, message } = codeAndMessage(e);
  return (
    code === "42703" ||
    code === "PGRST204" ||
    /column .* does not exist/i.test(message) ||
    /could not find the .* column/i.test(message)
  );
}

/**
 * A table no migration has created yet. Postgres itself says 42P01
 * (`relation x does not exist`), but PostgREST answers from its schema cache
 * first and reports an unknown table as PGRST205 (`Could not find the table
 * 'public.x' in the schema cache`) — that is the shape the client actually
 * sees on the current server, so both are recognised.
 */
export function isMissingRelationError(e: unknown): boolean {
  const { code, message } = codeAndMessage(e);
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /relation .* does not exist/i.test(message) ||
    /could not find the table/i.test(message)
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllRows(makeQuery: () => any, pageSize = 1000): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let from = 0;
  let guard = 0;
  for (;;) {
    // A backstop, not a stopping point: quietly returning the first million
    // rows would hand the caller a truncated set that looks complete.
    if (++guard > 1000) {
      throw new Error(`fetchAllRows read ${pageSize * 1000} rows and there are more; narrow the query.`);
    }
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw postgrestError(error);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** One open room_type_out_of_service row: `units` rooms unsellable on every night in the range. */
export type OutOfServiceRow = {
  room_type_id: string;
  start_date: string;
  end_date: string;
  units: number;
};

/**
 * Open out-of-service rows for the hotel that touch the horizon. A hotel
 * with none, or a database that has not run the migration yet, both come
 * back empty: pricing on the physical count is last week's behaviour, and
 * a missing table must never take the run down with it.
 *
 * Only the schema gap is tolerated. Any other failure (a timeout, an RLS
 * refusal) throws, same as loadActiveLadderEffects: quietly snapshotting the
 * physical count would read a renovated wing as empty rooms and push the
 * lower price as a successful run.
 */
export async function loadOutOfServiceRows(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<OutOfServiceRow[]> {
  try {
    const rows = await fetchAllRows(() =>
      supabase
        .from("room_type_out_of_service")
        .select("room_type_id, start_date, end_date, units")
        .eq("hotel_id", hotelId)
        .is("cleared_at", null)
        .lte("start_date", lastDate)
        .gte("end_date", firstDate)
        .order("id", { ascending: true }),
    );
    return rows
      .filter((r) => r.room_type_id && r.start_date && r.end_date)
      .map((r) => ({
        room_type_id: String(r.room_type_id),
        start_date: String(r.start_date),
        end_date: String(r.end_date),
        units: Math.max(0, Number(r.units ?? 0)),
      }));
  } catch (e) {
    if (!isMissingRelationError(e)) {
      throw new Error(
        `Failed to load rooms out of service: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.error(
      JSON.stringify({
        fn: "snapshotCurrentState",
        step: "room_type_out_of_service",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
        degradedToEmpty: true,
        schema: "pre-migration",
        message: `room_type_out_of_service does not exist yet; snapshotting the physical room count. Run ${MIGRATIONS.outOfService}.`,
        migration: MIGRATIONS.outOfService,
      }),
    );
    return [];
  }
}

/**
 * Sellable units for one (stay_date, room_type): the physical count minus
 * every open out-of-service row covering that night. Rows stack (two
 * renovations on the same wing add up) and the result never goes negative,
 * because computeOccupancy treats 0 as "nothing to sell" and skips the type.
 */
export function sellableUnitsFor(
  totalRooms: number,
  oosRows: OutOfServiceRow[],
  stayDate: string,
  roomTypeId: string,
): number {
  let out = 0;
  for (const r of oosRows) {
    if (r.room_type_id !== roomTypeId) continue;
    if (stayDate < r.start_date || stayDate > r.end_date) continue;
    out += r.units;
  }
  return Math.max(0, totalRooms - out);
}

/**
 * Insert one snapshot row per (stay_date, room_type) across the full horizon
 * for a single hotel. Uses a consistent snapshot_ts for the whole run.
 *
 * Callers pass only the room types that count as rooms; a court or meeting
 * room never gets a snapshot row, so it can never enter an occupancy
 * denominator. sellable_units is the SELLABLE count (see sellableUnitsFor),
 * which is why the metric built on it is called sellable occupancy.
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
  const sortedDates = [...stayDates].sort();
  const oosRows = await loadOutOfServiceRows(
    supabase,
    hotelId,
    sortedDates[0],
    sortedDates[sortedDates.length - 1],
  );

  // Aggregate booked_units and booked_revenue per (stay_date, room_type_id)
  // Paged, with a stable order. An unpaginated select silently stops at
  // PostgREST's 1000-row cap, which for a 50-room property at 60% occupancy
  // is reached about 33 days out — every stay date beyond that then
  // snapshots as zero booked, so occupancy reads 0 and pickup deltas go
  // negative. Discount ladders wrongly activate and increase ladders wrongly
  // deactivate for the whole far horizon.
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
  for (const row of agg ?? []) {
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
        sellable_units: sellableUnitsFor(rt.total_rooms, oosRows, sd, rt.id),
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
 */
/** §3.5 — default60d; pass max(pickup_window_days)+7 when known. */
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
