/**
 * Price the hotel again after a room-type change.
 *
 * Reclassifying a type or blocking rooms moves every occupancy denominator.
 * Database triggers record the change as work for the scheduled sync (a new
 * daily pass for a room type, the blocked nights for rooms out of service;
 * 99_supabase_migration_pricing_cadence_v1.sql), which prices it within one
 * tick, nearest nights first. This only asks that sync to run now, once the
 * response is out, rather than wait for its next tick. It used to run the
 * engine here over 60 nights, which the window of a year made impossible
 * inside a route, and which could run at the same moment as the scheduled
 * sync: the sync is now the only writer of a hotel's prices, besides a typed
 * price's own run.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import { nudgeHotelSync } from "@/lib/pms/sync-nudge";

export async function scheduleReprice(admin: SupabaseClient, hotelId: string, source: string): Promise<void> {
  try {
    await nudgeHotelSync(admin, hotelId);
  } catch (error) {
    // The scheduled tick picks the change up anyway.
    console.error(
      JSON.stringify({ fn: source, step: "nudge", hotelId, error: error instanceof Error ? error.message : String(error) }),
    );
  }
}

/** Postgres error code carried by supabase-js errors, when present. */
export function pgCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * True when the database has not had the room-classification migration yet:
 * the column (42703 in a filter or select, PGRST204 in a write payload) or
 * the out-of-service table (42P01 from Postgres, PGRST205 from PostgREST's
 * schema cache, which is what the client actually sees) is not there.
 */
export function isPreMigration(error: unknown): boolean {
  const code = pgCode(error);
  return code === "42703" || code === "PGRST204" || isMissingRelationError(error);
}

export const NEEDS_MIGRATION = "This needs a database update first.";
