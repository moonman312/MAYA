/**
 * Re-run the engine after a room-type change, once the response is out.
 *
 * Reclassifying a type or blocking rooms moves every occupancy denominator,
 * so published prices are stale until the next run. The run itself is minutes
 * of reads; making a checkbox wait on it would turn the review strip into a
 * loading spinner. So it goes through `after()`, and consecutive changes on
 * the same hotel coalesce: one run in flight, at most one queued behind it,
 * because the queued run already sees every change made while waiting.
 */

import { evaluateHotel } from "@/lib/engine";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

const running = new Map<string, { again: boolean }>();

/**
 * How far forward a re-price reaches. The full 365 is tens of minutes of
 * sequential reads on a busy hotel and this runs under the route's 300s cap,
 * which would kill it half way with the near dates rewritten and the far
 * ones not. Same knob the scheduled syncs use (MAYA_EVAL_HORIZON_DAYS,
 * default 45); the cron covers the far horizon on its next tick.
 */
export function repriceHorizonDays(): number {
  const raw = Number(process.env.MAYA_EVAL_HORIZON_DAYS ?? "45");
  return Math.max(1, Math.floor(raw) || 45);
}

export function scheduleReprice(admin: SupabaseClient, hotelId: string, source: string): void {
  after(() => repriceNow(admin, hotelId, source));
}

async function repriceNow(admin: SupabaseClient, hotelId: string, source: string): Promise<void> {
  const current = running.get(hotelId);
  if (current) {
    current.again = true;
    return;
  }
  const slot = { again: false };
  running.set(hotelId, slot);
  try {
    do {
      slot.again = false;
      try {
        await evaluateHotel(admin, hotelId, undefined, repriceHorizonDays());
      } catch (error) {
        console.error(
          JSON.stringify({
            fn: source,
            step: "evaluate",
            hotelId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } while (slot.again);
  } finally {
    running.delete(hotelId);
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
