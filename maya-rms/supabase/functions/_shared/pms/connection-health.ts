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
 * A 401 or 403 is what revocation looks like from the outside; anything else
 * (5xx, timeouts, 429) leaves the status alone, since those are outages rather
 * than a withdrawn grant. One refusal is not trusted with a Cloudbeds
 * connection, though: its reads get a new token and a second try first, and
 * an error page that is not Cloudbeds' own is an outage whatever its status
 * (readRefusalOf). isAuthRevocation is the plain reading, for callers that
 * only classify a failure.
 *
 * An outage that goes on is not left alone either (noteReadFailure, decided
 * 2026-09-29, audit A12): while reads keep failing for any reason but a
 * refused login, pricing stays held, the alert channel hears after three
 * failed reads in a row or thirty minutes without a good one, and after
 * about an hour the connection reads Error, which starts the outage email
 * and the banner. The first good read puts the status back (the sync stamps
 * it), resets the count (release_pms_sync) and posts a recovery line
 * (noteReadRecovered).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { raiseAlert, raiseRecovery } from "./alerting.ts";

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
 * What a failed read says about the grant, for a PMS whose reads get a new
 * token and a second try before anything is concluded (Cloudbeds: client.ts
 * cloudbedsGet).
 *
 *   not_connected        the vendor said in words that the app is not
 *                        connected. No token changes that.
 *   fresh_token_refused  refused with 401 or 403 on a token minted after an
 *                        earlier refusal in the same run.
 *   refused              refused with 401 or 403 and no new token was to be
 *                        had (or the vendor handed the same one back). One of
 *                        these says little; several runs in a row say the
 *                        grant is gone (REFUSED_RUNS_BEFORE_DISCONNECT).
 *   null                 not about the grant: an outage, throttling, or an
 *                        error page that is not the vendor's own, whatever
 *                        its status. A firewall's 403 page is an outage.
 */
export type ReadRefusal = "not_connected" | "fresh_token_refused" | "refused" | null;

export function readRefusalOf(error: {
  status: number | null | undefined;
  message?: string | null;
  foreignBody?: boolean;
  freshTokenRefused?: boolean;
}): ReadRefusal {
  if (error.foreignBody === true) return null;
  const said = (error.message ?? "").toLowerCase();
  if (REVOCATION_PHRASES.some((p) => said.includes(p))) return "not_connected";
  if (error.status !== 401 && error.status !== 403) return null;
  return error.freshTokenRefused === true ? "fresh_token_refused" : "refused";
}

/**
 * Runs in a row that ended on a refused read before the connection is taken
 * as gone. Failed runs back off (release_pms_sync: 10, 20, 40 minutes), so
 * three of them are over an hour of refusals with not one good read between.
 */
export const REFUSED_RUNS_BEFORE_DISCONNECT = 3;

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

/* ── Reads that keep failing (A12) ──────────────────────────────────────── */

/** Failed reads in a row before the alert channel hears. */
export const READ_FAILURES_BEFORE_ALERT = 3;
/** Time without a good read before the alert channel hears, whatever the count. */
export const READ_FAILING_ALERT_AFTER_MS = 30 * 60_000;
/** Time without a good read before the connection reads Error (the outage email and the banner follow). */
export const READ_FAILING_ERROR_AFTER_MS = 60 * 60_000;

/** The alert key for a hotel's reads failing, one per PMS. */
export function readsFailingAlertKey(pmsType: PmsTypeName, hotelId: string): string {
  return `pms_reads_failing:${pmsType}:${hotelId}`;
}

export type ReadHealth = {
  /** Failed reads in a row, this one included. */
  failures: number;
  /** Minutes since the last good read; null when there has never been one. */
  minutesSinceGoodRead: number | null;
  /** The alert channel was told this tick (or told again, or would have been but for the dedupe). */
  alert: { sent: boolean; reason?: string } | null;
  /** This tick moved the connection to Error. */
  markedError: boolean;
};

/**
 * One failed read of a PMS, for any reason but a refused login (those are
 * noteAuthFailure's and markConnectionDisconnected's). Reads the connection
 * row as it stands before this run is released, so the count includes this
 * failure. Never throws.
 *
 *   - After READ_FAILURES_BEFORE_ALERT in a row, or READ_FAILING_ALERT_AFTER_MS
 *     without a good read (last_sync_at), a critical alert, deduped by
 *     raiseAlert to once per six hours.
 *   - After READ_FAILING_ERROR_AFTER_MS without a good read, or, when there
 *     has never been one, twice the failures the alert needs, the status
 *     goes to Error from Connected or Degraded (never from Pending or
 *     Disconnected: nothing is being read there). The trigger from
 *     99_supabase_migration_connection_outage_notice_v1.sql stamps
 *     down_since, and the outage email follows an hour later; the PMS tab
 *     shows the banner at once. A good read stamps Connected again.
 */
export async function noteReadFailure(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: PmsTypeName,
  error: string,
  opts: { nowMs?: number; alert?: typeof raiseAlert } = {},
): Promise<ReadHealth | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const alert = opts.alert ?? raiseAlert;
  try {
    const { data, error: readError } = await supabase
      .from("pms_connections")
      .select("status, sync_failures, last_sync_at")
      .eq("hotel_id", hotelId)
      .eq("pms_type", pmsType)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!data) return null;
    const row = data as { status?: unknown; sync_failures?: unknown; last_sync_at?: unknown };
    const status = String(row.status ?? "");
    // release_pms_sync counts this run once the tick is over; the count on
    // the row is the runs before it.
    const failures = (Number(row.sync_failures) || 0) + 1;
    const lastGoodMs = row.last_sync_at != null ? Date.parse(String(row.last_sync_at)) : NaN;
    const sinceGoodMs = Number.isFinite(lastGoodMs) ? nowMs - lastGoodMs : null;
    const minutesSinceGoodRead = sinceGoodMs == null ? null : Math.round(sinceGoodMs / 60_000);

    const alertDue = failures >= READ_FAILURES_BEFORE_ALERT || (sinceGoodMs != null && sinceGoodMs >= READ_FAILING_ALERT_AFTER_MS);
    const errorDue =
      sinceGoodMs != null ? sinceGoodMs >= READ_FAILING_ERROR_AFTER_MS : failures >= READ_FAILURES_BEFORE_ALERT * 2;
    const reason = error.slice(0, 300);

    let markedError = false;
    if (errorDue && (status === "connected" || status === "degraded")) {
      const { data: moved, error: moveError } = await supabase
        .from("pms_connections")
        .update({ status: "error", updated_at: new Date(nowMs).toISOString() })
        .eq("hotel_id", hotelId)
        .eq("pms_type", pmsType)
        .in("status", ["connected", "degraded"])
        .select("id");
      if (moveError) throw new Error(moveError.message);
      markedError = (moved ?? []).length > 0;
      if (markedError) {
        await supabase.rpc("platform_log_event", {
          p_event_type: "pms.reads_failing",
          p_entity_type: "pms_connection",
          p_entity_id: hotelId,
          p_hotel_id: hotelId,
          p_detail: { pms_type: pmsType, failures, minutes_since_good_read: minutesSinceGoodRead, reason },
        });
      }
    }

    let told: ReadHealth["alert"] = null;
    if (alertDue) {
      const since =
        minutesSinceGoodRead != null
          ? `No good read for ${minutesSinceGoodRead} minutes`
          : "No good read yet";
      told = await alert(supabase, {
        severity: "critical",
        key: readsFailingAlertKey(pmsType, hotelId),
        title: `${pmsType} reads keep failing`,
        detail:
          `${since}; ${failures} failed read${failures === 1 ? "" : "s"} in a row. ` +
          "Pricing is held for this hotel until a read works; it is tried again within 15 minutes. " +
          `${markedError ? "The connection now reads Error, so the owner is emailed in an hour. " : ""}` +
          `Error: ${reason}`,
        hotelId,
      });
    }

    console.error(
      JSON.stringify({
        fn: "noteReadFailure",
        hotelId,
        pmsType,
        failures,
        minutesSinceGoodRead,
        status: markedError ? "error" : status,
        ...(told ? { alert: told } : {}),
        ...(markedError ? { event: "marked_error" } : {}),
        error: reason,
      }),
    );
    return { failures, minutesSinceGoodRead, alert: told, markedError };
  } catch (e) {
    console.error(
      JSON.stringify({ fn: "noteReadFailure", hotelId, pmsType, error: e instanceof Error ? e.message : String(e) }),
    );
    return null;
  }
}

/**
 * A good read after failed ones. The sync has stamped the status Connected
 * and last_sync_at by now; release_pms_sync has not yet reset the count, so
 * sync_failures still says how many runs failed before this one. When any
 * did, the alert channel gets a recovery line, if it was told of the
 * failures (raiseRecovery says nothing otherwise). Never throws.
 */
export async function noteReadRecovered(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: PmsTypeName,
  opts: { recover?: typeof raiseRecovery } = {},
): Promise<{ failures: number; recovery: { sent: boolean; reason?: string } | null } | null> {
  const recover = opts.recover ?? raiseRecovery;
  try {
    const { data, error } = await supabase
      .from("pms_connections")
      .select("sync_failures")
      .eq("hotel_id", hotelId)
      .eq("pms_type", pmsType)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const failures = Number((data as { sync_failures?: unknown }).sync_failures) || 0;
    if (failures === 0) return { failures, recovery: null };
    const recovery = await recover(supabase, {
      key: readsFailingAlertKey(pmsType, hotelId),
      title: `${pmsType} reads are working again`,
      detail: `${failures} failed read${failures === 1 ? "" : "s"} in a row before this one. Pricing resumes with this read.`,
      hotelId,
    });
    console.log(JSON.stringify({ fn: "noteReadRecovered", hotelId, pmsType, failures, recovery }));
    return { failures, recovery };
  } catch (e) {
    console.error(
      JSON.stringify({ fn: "noteReadRecovered", hotelId, pmsType, error: e instanceof Error ? e.message : String(e) }),
    );
    return null;
  }
}

/**
 * What a scheduled sync does about read health after one hotel's read: a
 * failure that was not a refused login is counted (noteReadFailure); a good
 * read, whole or cut short, ends a streak (noteReadRecovered). A read the
 * tick skipped (an import holds the PMS) says nothing. Never throws.
 */
export async function readHealthAfterSync(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: PmsTypeName,
  sync: { ok: boolean; skipped?: unknown; error?: string; refusal?: ReadRefusal },
  opts: { nowMs?: number; alert?: typeof raiseAlert; recover?: typeof raiseRecovery } = {},
): Promise<
  | { outcome: "failed"; health: ReadHealth | null }
  | { outcome: "refused" }
  | { outcome: "recovered" | "ok"; failures: number; recovery: { sent: boolean; reason?: string } | null }
  | { outcome: "skipped" }
> {
  if (sync.skipped) return { outcome: "skipped" };
  if (!sync.ok) {
    if (sync.refusal) return { outcome: "refused" };
    return { outcome: "failed", health: await noteReadFailure(supabase, hotelId, pmsType, sync.error ?? "read failed", opts) };
  }
  const noted = await noteReadRecovered(supabase, hotelId, pmsType, { recover: opts.recover });
  if (!noted || noted.failures === 0) return { outcome: "ok", failures: 0, recovery: null };
  return { outcome: "recovered", failures: noted.failures, recovery: noted.recovery };
}
