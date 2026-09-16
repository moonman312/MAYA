import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPaidLiveHotel } from "@/lib/billing/entitlement";
import { listUnpaidMarketplaceHotels } from "@/lib/billing/pending-hotel";
import { kickImportWorker, promoteImportJob, queuePrePaymentImport } from "@/lib/pms/eager-import";

/**
 * A never-paid Marketplace property whose imported data the retention sweep
 * deleted (99_supabase_migration_never_paid_retention_v1.sql), and its way back.
 *
 * The sweep keeps the property, its members, rules and settings, and deletes
 * the booking history, the import jobs, the stored credential and the
 * connection row. It stamps hotels.data_purged_at before it deletes anything,
 * so a purge still part-way through reads as purged too. So a returning owner
 * finds a property with no connection at all: the dashboard and onboarding
 * show the ordinary reconnect prompt for that (marketplaceReconnectNeeded),
 * and the reconnect queues a fresh full import (queueImportAfterPurge). A
 * plain reconnect only syncs the recent window, which would leave the property
 * with no history for good.
 *
 * Until an import queued after the purge has completed, the scheduler leaves
 * the property alone (claim_pms_sync_batch in the same migration), so nothing
 * prices it off the recent window alone. An unpaid property is parked anyway.
 *
 * Every read here tolerates data_purged_at not existing yet. The column and
 * the sweep arrive in the same file, so without the column nothing was ever
 * purged and "not purged" is the true answer.
 */

function isMissingColumn(error: { code?: string; message?: string } | null, column: string): boolean {
  return Boolean(error && (error.code === "42703" || (error.message ?? "").includes(column)));
}

/** When the sweep started deleting this property's imported data, or null. */
export async function readDataPurgedAt(admin: SupabaseClient, hotelId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("hotels")
    .select("id, data_purged_at")
    .eq("id", hotelId)
    .maybeSingle();
  if (error) {
    if (isMissingColumn(error, "data_purged_at")) return null;
    throw new Error(`Could not read the property: ${error.message}`);
  }
  const value = (data as { data_purged_at?: string | null } | null)?.data_purged_at;
  return value ? String(value) : null;
}

export type ReconnectNeeded = {
  pmsType: string;
  /** The retention sweep deleted the booking history, so reconnecting brings it back. */
  historyRemoved: boolean;
};

/**
 * Whether a claimed Marketplace property has no PMS connection left, which is
 * what the retention sweep leaves behind. Null when it is not a Marketplace
 * property or still has a connection row (a disconnected row shows the prompt
 * the ordinary way). Service role: claims are not readable by members.
 */
export async function marketplaceReconnectNeeded(
  admin: SupabaseClient,
  hotelId: string,
): Promise<ReconnectNeeded | null> {
  const { data: claim, error: claimErr } = await admin
    .from("pms_marketplace_claims")
    .select("pms_type")
    .eq("hotel_id", hotelId)
    .not("claimed_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (claimErr) throw new Error(`Could not read Marketplace claims: ${claimErr.message}`);
  if (!claim) return null;
  const pmsType = String(claim.pms_type);

  const { data: conn, error: connErr } = await admin
    .from("pms_connections")
    .select("status")
    .eq("hotel_id", hotelId)
    .eq("pms_type", pmsType)
    .maybeSingle();
  if (connErr) throw new Error(`Could not read the PMS connection: ${connErr.message}`);
  if (conn) return null;

  return { pmsType, historyRemoved: (await readDataPurgedAt(admin, hotelId)) != null };
}

export type AfterPurgeResult =
  | { queued: true; jobId: string }
  | { queued: false; reason: string; jobId?: string };

/**
 * Called once a reconnect has stored the new credential and written the
 * connection row, and again when payment lands on a property that is already
 * live. Does nothing for a property that was never purged: a reconnect is not
 * a re-import.
 *
 * An unpaid property goes through the same pre-payment queue as a new claim,
 * and only when it is the one its owner is shown next on the subscribe screen:
 * a group reconnect covers every sibling, and the rest are queued as each comes
 * up (onboarding/page.tsx), never all at once. "Not now" and the one unpaid
 * import per owner still hold. A trial that ended unpaid is still is_active but
 * is not on that screen, so it waits for payment instead. A paid one adopts the
 * import the way payment does, and onboarding is pointed at it so the progress
 * screen follows the new job. The purge deleted every earlier job, so whatever
 * job exists now was queued after it.
 */
export async function queueImportAfterPurge(
  admin: SupabaseClient,
  hotelId: string,
  pmsType: string,
  requestedBy: string | null,
): Promise<AfterPurgeResult> {
  if (!(await readDataPurgedAt(admin, hotelId))) return { queued: false, reason: "not_purged" };

  const { data: hotel, error: hotelErr } = await admin
    .from("hotels")
    .select("id, is_active")
    .eq("id", hotelId)
    .maybeSingle();
  if (hotelErr) throw new Error(`Could not read the property: ${hotelErr.message}`);
  if (!hotel) return { queued: false, reason: "not_found" };

  // Payment can land before the reconnect. With no connection there is nothing
  // to read yet, and the reconnect calls this again.
  const { data: conn, error: connErr } = await admin
    .from("pms_connections")
    .select("status")
    .eq("hotel_id", hotelId)
    .eq("pms_type", pmsType)
    .maybeSingle();
  if (connErr) throw new Error(`Could not read the PMS connection: ${connErr.message}`);
  if (!conn || String(conn.status) === "disconnected") return { queued: false, reason: "no_connection" };

  // The queue runs one unpaid import per owner, keyed on requested_by, so a
  // reconnect that does not know who clicked files it under the owner who
  // claimed the property rather than under nobody.
  let owner = requestedBy;
  if (!owner) {
    const { data: claim } = await admin
      .from("pms_marketplace_claims")
      .select("claimed_by")
      .eq("hotel_id", hotelId)
      .not("claimed_at", "is", null)
      .limit(1)
      .maybeSingle();
    owner = claim?.claimed_by ? String(claim.claimed_by) : null;
  }

  if (!(await isPaidLiveHotel(admin, hotelId, hotel.is_active as boolean | null))) {
    if (!owner) return { queued: false, reason: "not_next" };
    const [next] = await listUnpaidMarketplaceHotels(admin, owner);
    if (next?.hotelId !== hotelId) return { queued: false, reason: "not_next" };
    const r = await queuePrePaymentImport(admin, hotelId, owner);
    return r.queued ? { queued: true, jobId: r.jobId } : { queued: false, reason: r.reason, jobId: r.jobId };
  }

  const promoted = await promoteImportJob(admin, hotelId, pmsType, owner);
  if (!promoted.ok) throw new Error(promoted.message);

  const { data: state, error: stateErr } = await admin
    .from("onboarding_states")
    .select("hotel_id")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (stateErr) throw new Error(`Could not read onboarding: ${stateErr.message}`);
  const { error: writeErr } = await admin.from("onboarding_states").upsert(
    state
      ? { hotel_id: hotelId, import_job_id: promoted.jobId }
      : { hotel_id: hotelId, path: "guided", import_job_id: promoted.jobId, connected_at: new Date().toISOString() },
    { onConflict: "hotel_id" },
  );
  if (writeErr) throw new Error(`Could not point onboarding at the import: ${writeErr.message}`);

  kickImportWorker();
  return promoted.action === "kept"
    ? { queued: false, reason: "kept", jobId: promoted.jobId }
    : { queued: true, jobId: promoted.jobId };
}
