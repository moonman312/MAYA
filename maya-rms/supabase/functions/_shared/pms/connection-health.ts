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
import { raiseAlert } from "./alerting.ts";

export type PmsTypeName = "cloudbeds" | "mews" | "think";

/**
 * Phrases a vendor uses to say "this app is no longer installed here".
 *
 * Cloudbeds do NOT answer a revoked app with 401 or 403. They answer HTTP 200
 * carrying `success: false` and this message, which the client surfaces as a
 * 400-class CloudbedsHttpError — so the status check below never matched it, and
 * a property that uninstalled the app in their Marketplace went on reading
 * "connected" while every single call was refused. Observed live on a partner's
 * own property during certification, 2026-09-10.
 */
const REVOCATION_PHRASES = [
  "application is not available to be connected",
  "app is not connected",
  "invalid_grant",
];

/**
 * True when an error means "this grant is gone", not "the vendor is having a
 * moment".
 *
 * Status alone is not enough. Pass the message too wherever one is available —
 * a 5xx, a timeout or a 429 is an outage and must leave the status alone, but a
 * vendor telling us in words that the app is uninstalled is as authoritative as
 * a 401.
 */
export function isAuthRevocation(
  status: number | null | undefined,
  message?: string | null,
): boolean {
  if (status === 401 || status === 403) return true;
  if (!message) return false;
  const m = message.toLowerCase();
  return REVOCATION_PHRASES.some((p) => m.includes(p));
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

    // The one condition worth waking someone for: pricing has silently stopped
    // for this property and only a human reconnecting will start it again.
    await raiseAlert(supabase, {
      severity: "critical",
      key: `pms_disconnected:${pmsType}:${hotelId}`,
      title: `${pmsType} connection revoked`,
      detail: reason,
      hotelId,
    });

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
