/**
 * The change log's read of each night's audit row before a run, and of each
 * night's newest row (audit_rows_before,
 * 99_supabase_migration_pickup_wait_v1.sql), kept out of the route file so
 * the route exports nothing but its handler.
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

/** Later than any row: audit_rows_before then answers each night's newest row. */
const AFTER_EVERY_ROW = "9999-12-31T00:00:00Z";

/**
 * When each night's newest audit row was written (ms), keyed
 * `stay_date|room_type_id`: one row per night asked for, through
 * audit_rows_before with an instant after every row, under the caller's
 * session like every other audit read. The change log asks it for the
 * nights of the changes on a page, so a change speaks for the night's price
 * only when its run wrote that newest row, whatever the page shows
 * (changelog-send-lines.ts). Null when it can't be read: then no change
 * claims a send.
 */
export async function newestAuditAt(
  supabase: SupabaseClient,
  hotelId: string,
  cells: { stay_date: string; room_type_id: string }[],
): Promise<Map<string, number> | null> {
  const out = new Map<string, number>();
  if (cells.length === 0) return out;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc("audit_rows_before", {
        p_hotel_id: hotelId,
        p_before: AFTER_EVERY_ROW,
        p_stay_dates: cells.map((c) => c.stay_date),
        p_room_type_ids: cells.map((c) => c.room_type_id),
      })
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(JSON.stringify({ fn: "api/changelog", step: "newest_audit_rows", hotelId, error: String(error.message).slice(0, 300) }));
      return null;
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      const at = Date.parse(String(r.evaluated_at));
      if (Number.isFinite(at)) out.set(`${String(r.stay_date).slice(0, 10)}|${r.room_type_id}`, at);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}
