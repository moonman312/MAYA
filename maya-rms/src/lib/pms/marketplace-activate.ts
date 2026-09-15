import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus } from "@/lib/billing/entitlement";

/**
 * The second half of a Marketplace arrival: make the property real.
 *
 * A Flow A hotel used to go live the moment its owner claimed it — before
 * anyone had paid — and the history import started right there. Now the claim
 * only attaches an owner. The hotel stays parked (is_active false,
 * setup_pending_at set), which is exactly the shape Flow B's checkout leaves
 * behind, so the same subscribe screen and the same Stripe session attach a
 * subscription to it with no special casing anywhere in billing.
 *
 * This runs when that subscription becomes entitled: from the Stripe webhook
 * first, so the import is already underway before the owner is back from the
 * card form, and from the checkout return route in case the browser beats the
 * webhook. It is safe to call from both — the flip to is_active is a
 * compare-and-set, so the second arrival finds the work done and leaves.
 *
 * Nothing about the property is pulled before this point beyond what the
 * callback needed to name it. Compute and storage for a property that never
 * pays is waste, and a seven-year import for a card that bounces is a lot of
 * waste.
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
  if (!flipped || flipped.length === 0) {
    const { data: hotel } = await admin.from("hotels").select("id").eq("id", hotelId).maybeSingle();
    return { activated: false, reason: hotel ? "already_active" : "not_found" };
  }

  await admin
    .from("pms_connections")
    .update({ status: "connected", last_tested_at: now, updated_at: now })
    .eq("hotel_id", hotelId)
    .eq("pms_type", claim.pms_type);

  const requestedBy = opts.requestedBy ?? claim.claimed_by ?? null;

  // Not fatal: they are connected either way and a missing job is recoverable,
  // but it has to be loud or the property sits on a progress screen forever.
  const { data: job, error: jobErr } = await admin
    .from("import_jobs")
    .insert({
      hotel_id: hotelId,
      pms_type: claim.pms_type,
      status: "queued",
      phase: "discover",
      requested_by: requestedBy,
    })
    .select("id")
    .single();
  if (jobErr) {
    console.error(
      JSON.stringify({ fn: "activateMarketplaceHotel", step: "queue_import", hotelId, error: jobErr.message }),
    );
  }
  const importJobId = job?.id != null ? String(job.id) : null;

  await admin.from("onboarding_states").upsert(
    { hotel_id: hotelId, path: "guided", import_job_id: importJobId, connected_at: now },
    { onConflict: "hotel_id" },
  );

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

/**
 * Ask the import worker to run now. Fire-and-forget: cron picks the job up
 * within a minute regardless, so a failure here costs latency, not the import.
 */
export function kickImportWorker(): void {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.ONBOARDING_CRON_SECRET;
  if (!supabaseUrl || !secret) return;
  fetch(`${supabaseUrl}/functions/v1/onboarding-import-worker`, {
    method: "POST",
    headers: { "x-onboarding-cron-secret": secret },
  }).catch(() => {
    // Cron picks the job up within a minute.
  });
}
