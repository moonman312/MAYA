/**
 * Room types into `room_types` without ever writing a guessed count over a
 * measured one.
 *
 * A PMS read either counts a type's rooms (a number, 0 included) or has no
 * count this run (null: the count call failed, or the PMS has no count at
 * all). Null keeps whatever is stored. Only a type with nothing stored takes
 * the hotel default, because the column needs something and the next run
 * with a real count replaces it.
 *
 * Keeping works by leaving total_rooms out of the payload: PostgREST's
 * column list comes from the keys, so an upsert without it updates the name
 * and leaves the count alone. The same trick keeps is_active out of every
 * sync.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type RoomTypeUpsertRow = {
  hotel_id: string;
  external_room_type_id: string;
  name: string;
  display_name: string | null;
  total_rooms: number | null;
};

export const ROOM_COUNT_ZERO_MIGRATION = "99_supabase_migration_room_count_zero_v1.sql";

type DbError = { code?: string; message: string };

/** The pre-migration CHECK (total_rooms > 0) refusing a counted 0. */
function isZeroCountRejected(error: DbError): boolean {
  return (
    (error.code === "23514" || /check constraint/i.test(error.message)) &&
    /total_rooms/i.test(error.message)
  );
}

type Resolved = { counted: RoomTypeUpsertRow[]; kept: Omit<RoomTypeUpsertRow, "total_rooms">[] };

function resolveCounts(
  rows: RoomTypeUpsertRow[],
  stored: ReadonlyMap<string, number>,
  defaultRooms: number,
  zeroAllowed: boolean,
): Resolved {
  const counted: RoomTypeUpsertRow[] = [];
  const kept: Omit<RoomTypeUpsertRow, "total_rooms">[] = [];
  for (const row of rows) {
    const n = row.total_rooms;
    if (n != null && Number.isFinite(n) && (n > 0 || (n === 0 && zeroAllowed))) {
      counted.push({ ...row, total_rooms: Math.floor(n) });
    } else if (stored.has(row.external_room_type_id)) {
      kept.push({
        hotel_id: row.hotel_id,
        external_room_type_id: row.external_room_type_id,
        name: row.name,
        display_name: row.display_name,
      });
    } else {
      counted.push({ ...row, total_rooms: Math.max(1, Math.floor(defaultRooms)) });
    }
  }
  return { counted, kept };
}

/**
 * Upserts `rows` (already deduped on hotel + external id) for one hotel.
 * Returns the error message on failure, null on success. A failed read of the
 * stored counts is a failure: carrying on blind would put the default back
 * over good numbers, which is the bug this exists to stop.
 */
export async function upsertRoomTypesKeepingCounts(
  supabase: SupabaseClient,
  hotelId: string,
  rows: RoomTypeUpsertRow[],
  defaultRooms: number,
): Promise<{ error: string | null }> {
  if (rows.length === 0) return { error: null };

  const { data: storedRows, error: readErr } = await supabase
    .from("room_types")
    .select("external_room_type_id, total_rooms")
    .eq("hotel_id", hotelId);
  if (readErr) return { error: readErr.message };
  const stored = new Map<string, number>();
  for (const r of (storedRows ?? []) as { external_room_type_id?: unknown; total_rooms?: unknown }[]) {
    const n = Number(r.total_rooms);
    if (r.external_room_type_id != null && r.total_rooms != null && Number.isFinite(n)) {
      stored.set(String(r.external_room_type_id), n);
    }
  }

  const write = async ({ counted, kept }: Resolved): Promise<DbError | null> => {
    for (const batch of [counted, kept]) {
      if (batch.length === 0) continue;
      const { error } = await supabase
        .from("room_types")
        .upsert(batch, { onConflict: "hotel_id,external_room_type_id" });
      if (error) return error as DbError;
    }
    return null;
  };

  let error = await write(resolveCounts(rows, stored, defaultRooms, true));
  if (error && isZeroCountRejected(error) && rows.some((r) => r.total_rooms === 0)) {
    // The column still says > 0. A type the PMS says has no rooms keeps its
    // stored number until the migration runs; one never stored takes the
    // default, as it did before counts existed.
    console.warn(JSON.stringify({
      fn: "upsertRoomTypesKeepingCounts",
      hotel: hotelId,
      warning: `room_types.total_rooms still refuses 0. Run ${ROOM_COUNT_ZERO_MIGRATION}; ` +
        "types with no rooms keep their stored count until then.",
      zeroTypes: rows.filter((r) => r.total_rooms === 0).map((r) => r.external_room_type_id),
    }));
    error = await write(resolveCounts(rows, stored, defaultRooms, false));
  }
  return { error: error ? error.message : null };
}
