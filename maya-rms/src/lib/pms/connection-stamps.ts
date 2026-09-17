/**
 * Two timestamps on pms_connections that tell the scheduled push something
 * happened outside it. Both writes are best effort: the act they follow (a
 * connect, going live) has already happened, and a database without the
 * columns from 99_supabase_migration_push_guardrails_v1.sql only logs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A person just stored a new grant for this connection. The push ends a hold
 * on a failure whose fix is a new grant (a missing rate permission, a refused
 * grant) once its last try is older than this, instead of after a day, so the
 * reconnect the change log asked for takes effect on the next tick.
 */
export async function markConnectionReauthorized(
  admin: SupabaseClient,
  hotelId: string,
  pmsType: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  try {
    const { error } = await admin
      .from("pms_connections")
      .update({ reauthorized_at: at })
      .eq("hotel_id", hotelId)
      .eq("pms_type", pmsType);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "markConnectionReauthorized",
        hotelId,
        pmsType,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      }),
    );
  }
}

/**
 * The hotel just went live. The base rate refresh is throttled to hourly, and
 * the first live push writes over every night MAYA has not sent to yet: a
 * rate the hotel changed in its PMS since the last read would be overwritten
 * with a price built on the old one. Clearing the stamp makes the next tick
 * read the PMS before it prices and pushes.
 */
export async function requestBaseRateRefresh(admin: SupabaseClient, hotelId: string): Promise<void> {
  try {
    const { error } = await admin.from("pms_connections").update({ base_rates_refreshed_at: null }).eq("hotel_id", hotelId);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "requestBaseRateRefresh",
        hotelId,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      }),
    );
  }
}
