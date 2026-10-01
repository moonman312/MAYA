import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The floors and ceilings the owner removed on the review (audit A21).
 *
 * The review's remove puts a floor back to 1.00 or a ceiling back to
 * 99,999.99, the values an import reads as "never set", and stamps
 * room_types.floor_cleared_at or ceiling_cleared_at
 * (99_supabase_migration_room_type_limit_removals_v1.sql). An import never
 * fills a stamped limit again, from the rates (applyInitialGuardrails) or
 * from the answers (projectStrategyOntoRoomTypes when the import calls it).
 * The owner's own acts still set one.
 */
export type LimitRemovals = Map<string, { floor: boolean; ceiling: boolean }>;

export const LIMIT_REMOVALS_MIGRATION = "99_supabase_migration_room_type_limit_removals_v1.sql";

let loggedMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetLimitRemovalsLogOnce(): void {
  loggedMissing = false;
}

function isMissingColumn(err: { code?: string; message?: string }): boolean {
  const msg = String(err.message ?? "");
  return (
    /(floor|ceiling)_cleared_at/.test(msg) &&
    (err.code === "42703" || err.code === "PGRST204" || /does not exist|schema cache/i.test(msg))
  );
}

/**
 * Which of the hotel's room types have a floor or ceiling the owner removed.
 * Before the migration the columns are not there: then nobody has removed
 * anything MAYA could know of, and the map is empty (logged once). Any other
 * failed read is null: an import that cannot tell writes no limit this pass,
 * rather than fill one the owner may have removed.
 */
export async function loadLimitRemovals(supabase: SupabaseClient, hotelId: string): Promise<LimitRemovals | null> {
  const out: LimitRemovals = new Map();
  const { data, error } = await supabase
    .from("room_types")
    .select("id, floor_cleared_at, ceiling_cleared_at")
    .eq("hotel_id", hotelId);
  if (error) {
    if (!isMissingColumn(error)) {
      console.error(JSON.stringify({ fn: "loadLimitRemovals", hotelId, error: error.message }));
      return null;
    }
    if (!loggedMissing) {
      loggedMissing = true;
      console.warn(
        JSON.stringify({
          fn: "loadLimitRemovals",
          hotelId,
          schema: "pre-migration",
          message: `room_types.floor_cleared_at does not exist yet, so a floor or ceiling removed on the review can be filled again by an import. Run ${LIMIT_REMOVALS_MIGRATION}.`,
          migration: LIMIT_REMOVALS_MIGRATION,
        }),
      );
    }
    return out;
  }
  for (const r of (data ?? []) as Array<{ id: unknown; floor_cleared_at: unknown; ceiling_cleared_at: unknown }>) {
    const floor = r.floor_cleared_at != null;
    const ceiling = r.ceiling_cleared_at != null;
    if (floor || ceiling) out.set(String(r.id), { floor, ceiling });
  }
  return out;
}

/** The stamp a remove writes beside the limit it clears. */
export function removalStamp(kind: "floor" | "ceiling", at: Date = new Date()): Record<string, string> {
  return kind === "floor" ? { floor_cleared_at: at.toISOString() } : { ceiling_cleared_at: at.toISOString() };
}

/** Whether a write failed only because the stamp's column is not there yet. */
export function isMissingRemovalColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(err) && isMissingColumn(err as { code?: string; message?: string });
}
