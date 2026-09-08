/**
 * Keep pms_connections.status honest about revoked access.
 *
 * Cloudbeds tests "connecting and disconnecting" during certification, and a
 * user can revoke a connection from inside the Cloudbeds Marketplace at any
 * time. Until now MAYA only noticed that at token-REFRESH time, when the
 * vendor answers invalid_grant. A revoked session whose access token has not
 * expired yet keeps returning 401 on every data call, and nothing wrote that
 * down — so the PMS tab showed a green "Connected" pill next to a red health
 * badge and a log full of 401s, which is a screen that contradicts itself.
 *
 * A single 401/403 is treated as authoritative because that is what revocation
 * looks like from the outside; anything else (5xx, timeouts, 429) leaves the
 * status alone, since those are outages rather than a withdrawn grant.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type PmsTypeName = "cloudbeds" | "mews" | "think";

/** True when an error means "this grant is gone", not "the vendor is having a moment". */
export function isAuthRevocation(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * Record that a property's connection is no longer authorised. Idempotent, and
 * never throws: this runs inside failure handling, and a bookkeeping write that
 * fails must not replace the original error with its own.
 */
export async function markConnectionDisconnected(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: PmsTypeName,
  reason: string,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("pms_connections")
      .update({ status: "disconnected", updated_at: now })
      .eq("hotel_id", hotelId)
      .eq("pms_type", pmsType);
    if (error) throw new Error(error.message);

    console.log(
      JSON.stringify({
        fn: "markConnectionDisconnected",
        hotelId,
        pmsType,
        reason,
        event: "connection_revoked",
      }),
    );

    await supabase.rpc("platform_log_event", {
      p_event_type: "pms.disconnected",
      p_entity_type: "pms_connection",
      p_entity_id: hotelId,
      p_hotel_id: hotelId,
      p_detail: { pms_type: pmsType, reason },
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "markConnectionDisconnected",
        hotelId,
        pmsType,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
