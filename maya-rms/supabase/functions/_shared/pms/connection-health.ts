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
export const REVOCATION_PHRASES = [
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
 * Count one read the PMS refused as bad credentials, and mark the connection
 * Error once `threshold` have come in a row (pms_note_auth_failure in
 * 99_supabase_migration_connection_outage_notice_v1.sql). A good read sets the
 * count back to 0: the trigger there resets it whenever last_sync_at moves.
 *
 * For a PMS whose credentials are keys rather than a grant. Nothing on the
 * vendor's side ever tells MAYA a key was revoked, so a string of refusals is
 * the only signal, and one refusal alone is not trusted with a status change.
 * Error rather than Disconnected, because the scheduler keeps retrying Error
 * connections and the first read that works puts it back to Connected.
 *
 * Never throws, for the same reason as markConnectionDisconnected.
 */
export async function noteAuthFailure(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: PmsTypeName,
  threshold: number,
  reason: string,
): Promise<{ failures: number; status: string } | null> {
  try {
    const { data, error } = await supabase.rpc("pms_note_auth_failure", {
      p_hotel_id: hotelId,
      p_pms_type: pmsType,
      p_threshold: threshold,
    });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { failures?: unknown; new_status?: unknown }
      | null
      | undefined;
    // No row: the connection is pending or disconnected, so nothing counts.
    if (!row) return null;
    const failures = Number(row.failures);
    const status = String(row.new_status);
    const markedError = status === "error" && failures === Math.max(1, threshold);
    console.log(
      JSON.stringify({
        fn: "noteAuthFailure",
        hotelId,
        pmsType,
        failures,
        status,
        reason: reason.slice(0, 300),
        event: markedError ? "marked_error" : "auth_refused",
      }),
    );
    if (markedError) {
      await supabase.rpc("platform_log_event", {
        p_event_type: "pms.auth_failing",
        p_entity_type: "pms_connection",
        p_entity_id: hotelId,
        p_hotel_id: hotelId,
        p_detail: { pms_type: pmsType, failures, reason: reason.slice(0, 300) },
      });
    }
    return { failures, status };
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "noteAuthFailure",
        hotelId,
        pmsType,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return null;
  }
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
    const { error, count } = await supabase
      .from("pms_connections")
      .update({ status: "disconnected", updated_at: now }, { count: "exact" })
      .eq("hotel_id", hotelId)
      .eq("pms_type", pmsType);
    if (error) throw new Error(error.message);

    // No row means no property: the Marketplace claim sweep deletes parked
    // hotels whose Cloudbeds app-state webhook still points here, and an
    // uninstall arriving for one of those must not page anyone about a
    // connection that does not exist.
    if (count === 0) {
      console.log(JSON.stringify({ fn: "markConnectionDisconnected", hotelId, pmsType, event: "no_connection" }));
      return;
    }

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
