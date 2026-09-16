import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus } from "@/lib/billing/entitlement";
import { kickImportWorker, promoteImportJob } from "@/lib/pms/eager-import";

/**
 * The second half of a Marketplace arrival: make the property live.
 *
 * The claim attaches an owner and starts the history import
 * (eager-import.ts), but the hotel stays parked (is_active false,
 * setup_pending_at set, connection 'pending'), which is exactly the shape
 * Flow B's checkout leaves behind, so the same subscribe screen and the same
 * Stripe session attach a subscription to it with no special casing anywhere
 * in billing. Parked is what keeps the scheduled syncs, rate pushes and the
 * engine off it.
 *
 * This runs when that subscription becomes entitled: from the Stripe webhook
 * first, and from the checkout return route in case the browser beats the
 * webhook. It is safe to call from both — the flip to is_active is a
 * compare-and-set, so the second arrival finds the work done and leaves.
 *
 * Payment adopts the import the claim started rather than queueing another:
 * uq_import_jobs_one_active_per_hotel would refuse a second one while the
 * first is running, and one that already finished would otherwise be pulled
 * again from scratch.
 */

export type ActivationResult =
  | { activated: true; hotelId: string; importJobId: string | null }
  | {
      activated: false;
      reason: "not_found" | "already_active" | "not_marketplace" | "failed";
      message?: string;
    };

export type MarketplaceClaimRow = {
  token: string;
  hotel_id: string;
  pms_type: string;
  property_name: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
};

/** The redeemed claim that marks a hotel as a Marketplace arrival, if it is one. */
export async function findMarketplaceClaimForHotel(
  admin: SupabaseClient,
  hotelId: string,
): Promise<MarketplaceClaimRow | null> {
  const { data } = await admin
    .from("pms_marketplace_claims")
    .select("token, hotel_id, pms_type, property_name, claimed_by, claimed_at")
    .eq("hotel_id", hotelId)
    .not("claimed_at", "is", null)
    .limit(1)
    .maybeSingle();
  return (data as MarketplaceClaimRow | null) ?? null;
}

/**
 * A subscription exists AND is live. Deliberately not isHotelEntitled: that
 * one answers "may MAYA keep working for this hotel" and says yes to a hotel
 * with no subscription at all — right for the sandbox and for every install
 * without Stripe keys, and exactly wrong as a paywall.
 */
export async function hasEntitledSubscription(
  admin: SupabaseClient,
  hotelId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("hotel_subscriptions")
    .select("status")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  return isEntitledStatus(data?.status == null ? null : String(data.status));
}

/**
 * Free days a Marketplace signup gets before its first charge. Read per call,
 * not at module load, so a long-lived instance follows the environment. 0 or
 * unset means no trial; a code that grants its own trial replaces this rather
 * than stacking on it (checkout resolves that).
 */
export function marketplaceTrialDays(): number {
  const n = Number(process.env.MAYA_MARKETPLACE_TRIAL_DAYS ?? "0");
  return Number.isInteger(n) && n > 0 ? Math.min(n, 365) : 0;
}

export async function activateMarketplaceHotelIfPending(
  admin: SupabaseClient,
  hotelId: string,
  opts: { requestedBy?: string | null; claim?: MarketplaceClaimRow | null } = {},
): Promise<ActivationResult> {
  // The redeem path hands over the claim it is in the middle of burning, whose
  // claimed_at is not on disk yet. Everyone else looks it up.
  const claim = opts.claim ?? (await findMarketplaceClaimForHotel(admin, hotelId));
  // A pending hotel with no redeemed claim is Flow B's placeholder: the PMS
  // connect adopts that one, and it must not be activated with nothing behind it.
  if (!claim) return { activated: false, reason: "not_marketplace" };

  const now = new Date().toISOString();

  // Compare-and-set. The webhook and the return route can both land here within
  // the same second; whichever flips the row does the rest, the other sees no
  // row come back and stops. Two callers each queueing an import would run the
  // same seven-year pull twice.
  const { data: flipped, error: activateErr } = await admin
    .from("hotels")
    .update({ is_active: true, setup_pending_at: null })
    .eq("id", hotelId)
    .eq("is_active", false)
    .select("id");
  if (activateErr) return { activated: false, reason: "failed", message: activateErr.message };
  const requestedBy = opts.requestedBy ?? claim.claimed_by ?? null;

  if (!flipped || flipped.length === 0) {
    const { data: hotel } = await admin.from("hotels").select("id").eq("id", hotelId).maybeSingle();
    if (!hotel) return { activated: false, reason: "not_found" };
    // The hotel never stopped being active, but its connection may be parked:
    // a lapsed customer who reconnected before paying again is held at pending
    // so the scheduler leaves them alone. Payment lands here, not on the flip
    // above, so release it or they stay unsynced until they reconnect by hand.
    // Only pending moves; disconnected means they uninstalled, and that stands.
    if (await hasEntitledSubscription(admin, hotelId)) {
      await admin
        .from("pms_connections")
        .update({ status: "connected", updated_at: now })
        .eq("hotel_id", hotelId)
        .eq("pms_type", claim.pms_type)
        .eq("status", "pending");
      // An arrival whose import could not be adopted went live pointing at no
      // job, and every later arrival lands here. Finish that step now.
      const adopted = await adoptImportIfMissing(admin, hotelId, claim.pms_type, requestedBy, now);
      if (!adopted.ok) return { activated: false, reason: "failed", message: adopted.message };
    }
    return { activated: false, reason: "already_active" };
  }

  await admin
    .from("pms_connections")
    .update({ status: "connected", last_tested_at: now, updated_at: now })
    .eq("hotel_id", hotelId)
    .eq("pms_type", claim.pms_type);

  const promoted = await promoteImportJob(admin, hotelId, claim.pms_type, requestedBy);
  if (!promoted.ok) {
    // Never written as a null job: the progress screen would wait forever and
    // the stalled-signups view joins on this id. The next arrival retries it.
    console.error(
      JSON.stringify({ fn: "activateMarketplaceHotel", step: "adopt_import", hotelId, error: promoted.message }),
    );
    return { activated: false, reason: "failed", message: promoted.message };
  }
  const importJobId = promoted.jobId;

  const { error: stateErr } = await admin.from("onboarding_states").upsert(
    { hotel_id: hotelId, path: "guided", import_job_id: importJobId, connected_at: now },
    { onConflict: "hotel_id" },
  );
  if (stateErr) return { activated: false, reason: "failed", message: stateErr.message };

  kickImportWorker();

  await admin.rpc("platform_log_event", {
    p_event_type: "pms.marketplace_activated",
    p_entity_type: "pms_connection",
    p_entity_id: hotelId,
    p_hotel_id: hotelId,
    p_detail: { pms_type: claim.pms_type, via: "marketplace_flow_a", requested_by: requestedBy },
  });

  return { activated: true, hotelId, importJobId };
}

/** The adoption step for a property that is already live but points at no import. */
async function adoptImportIfMissing(
  admin: SupabaseClient,
  hotelId: string,
  pmsType: string,
  requestedBy: string | null,
  now: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: state, error } = await admin
    .from("onboarding_states")
    .select("import_job_id")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (state?.import_job_id) return { ok: true };

  const promoted = await promoteImportJob(admin, hotelId, pmsType, requestedBy);
  if (!promoted.ok) return promoted;
  const { error: stateErr } = await admin.from("onboarding_states").upsert(
    state
      ? { hotel_id: hotelId, import_job_id: promoted.jobId }
      : { hotel_id: hotelId, path: "guided", import_job_id: promoted.jobId, connected_at: now },
    { onConflict: "hotel_id" },
  );
  if (stateErr) return { ok: false, message: stateErr.message };
  kickImportWorker();
  return { ok: true };
}

export { kickImportWorker };
