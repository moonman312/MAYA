/**
 * The change log's read of each night's audit row before a run
 * (audit_rows_before, 99_supabase_migration_pickup_wait_v1.sql), kept out
 * of the route file so the route exports nothing but its handler.
 */

import { priorAuditRowFrom, type PriorAuditRow } from "@/lib/changelog-route-helpers";
import { MIGRATIONS, isMissingFunctionError } from "@/lib/engine/snapshots";
import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE = 1000;

let loggedPriorRowsMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetPriorRowsLogOnce(): void {
  loggedPriorRowsMissing = false;
}

/**
 * The night's audit row before `before`, per night asked for, keyed
 * `stay_date|room_type_id`. null when audit_rows_before does not exist yet:
 * the caller then goes by what the rows say themselves (a fire coming off),
 * as the log did before it, and this says so once. Any other failure is
 * thrown, like every other audit read.
 */
export async function priorRowsFor(
  supabase: SupabaseClient,
  hotelId: string,
  before: string,
  cells: { stay_date: string; room_type_id: string }[],
): Promise<Map<string, PriorAuditRow> | null> {
  const out = new Map<string, PriorAuditRow>();
  if (cells.length === 0) return out;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc("audit_rows_before", {
        p_hotel_id: hotelId,
        p_before: before,
        p_stay_dates: cells.map((c) => c.stay_date),
        p_room_type_ids: cells.map((c) => c.room_type_id),
      })
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (!isMissingFunctionError(error)) throw error;
      if (!loggedPriorRowsMissing) {
        loggedPriorRowsMissing = true;
        console.error(
          JSON.stringify({
            fn: "api/changelog",
            step: "audit_rows_before",
            hotelId,
            schema: "pre-migration",
            message: `audit_rows_before does not exist yet; a run that put a price back to base shows only when it took a raise off. Run ${MIGRATIONS.pickupWait}.`,
            migration: MIGRATIONS.pickupWait,
            error: error.message,
          }),
        );
      }
      return null;
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) out.set(`${String(r.stay_date).slice(0, 10)}|${r.room_type_id}`, priorAuditRowFrom(r));
    if (rows.length < PAGE) break;
  }
  return out;
}
