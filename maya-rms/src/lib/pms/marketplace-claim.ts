import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { MAYA_ACTIVE_HOTEL_COOKIE } from "@/lib/hotel-context";

/**
 * Redeem a Flow A claim ticket.
 *
 * The Marketplace callback has already done the irreversible half: the grant is
 * spent, the tokens are in the Vault, and an inert hotel row exists to hold
 * them. What is missing is an OWNER. This attaches one, and is the only thing
 * that makes the property real — before it runs the hotel is is_active false
 * with no membership, so it prices nothing and appears to nobody.
 *
 * Deliberately idempotent-ish: a ticket is single-use, but re-claiming by the
 * SAME user is treated as success rather than an error, because a refresh or a
 * double-submit after signing in should not look like a failure to the owner.
 */

export type ClaimResult =
  | { ok: true; hotelId: string; alreadyClaimed: boolean }
  | { ok: false; reason: "not_found" | "expired" | "taken" | "failed"; message: string };

export async function redeemMarketplaceClaim(
  token: string,
  userId: string,
): Promise<ClaimResult> {
  const admin = createAdminClient();

  const { data: claim } = await admin
    .from("pms_marketplace_claims")
    .select("token, hotel_id, pms_type, property_name, expires_at, claimed_by, claimed_at")
    .eq("token", token)
    .maybeSingle();

  if (!claim) {
    return { ok: false, reason: "not_found", message: "That connection link is not valid." };
  }
  if (claim.claimed_at) {
    // The same person coming back is fine; a different one is not.
    if (claim.claimed_by === userId) {
      return { ok: true, hotelId: String(claim.hotel_id), alreadyClaimed: true };
    }
    return { ok: false, reason: "taken", message: "That connection has already been claimed." };
  }
  if (new Date(claim.expires_at).getTime() < Date.now()) {
    return {
      ok: false,
      reason: "expired",
      message: "That connection link has expired. Reconnect the app from the Cloudbeds Marketplace.",
    };
  }

  const hotelId = String(claim.hotel_id);
  const now = new Date().toISOString();

  // Service role means auth.uid() is null, so the auto-membership trigger will
  // not fire — write it explicitly, exactly as the onboarding callback does.
  const { error: memberErr } = await admin.from("hotel_memberships").upsert(
    { hotel_id: hotelId, user_id: userId, role: "hotel_admin", status: "active" },
    { onConflict: "hotel_id,user_id" },
  );
  if (memberErr) {
    return { ok: false, reason: "failed", message: `Could not link you to the property: ${memberErr.message}` };
  }

  // Simulation mode ON: a property that arrives through the Marketplace has
  // never been configured by anyone, so nothing may reach its live rates until
  // its owner deliberately goes live.
  const { error: settingsErr } = await admin.from("hotel_settings").upsert(
    {
      hotel_id: hotelId,
      pricing_horizon_days: 365,
      pickup_window_cycles: 1,
      simulation_mode: true,
      rounding_mode: "none",
    },
    { onConflict: "hotel_id" },
  );
  if (settingsErr) {
    return { ok: false, reason: "failed", message: `Could not set up pricing: ${settingsErr.message}` };
  }

  const { error: activateErr } = await admin
    .from("hotels")
    .update({ is_active: true, setup_pending_at: null })
    .eq("id", hotelId);
  if (activateErr) {
    return { ok: false, reason: "failed", message: `Could not activate the property: ${activateErr.message}` };
  }

  await admin
    .from("pms_connections")
    .update({ status: "connected", last_tested_at: now, updated_at: now })
    .eq("hotel_id", hotelId)
    .eq("pms_type", claim.pms_type);

  // Queue the history import the same way the in-app connect flow does. Not
  // fatal: they are connected either way, and a missing job is recoverable —
  // but it must be loud, or the property sits on a progress screen forever.
  const { data: job, error: jobErr } = await admin
    .from("import_jobs")
    .insert({
      hotel_id: hotelId,
      pms_type: claim.pms_type,
      status: "queued",
      phase: "discover",
      requested_by: userId,
    })
    .select("id")
    .single();
  if (jobErr) {
    console.error(
      JSON.stringify({ fn: "redeemMarketplaceClaim", step: "queue_import", hotelId, error: jobErr.message }),
    );
  }

  await admin.from("onboarding_states").upsert(
    { hotel_id: hotelId, path: "guided", import_job_id: job?.id ?? null, connected_at: now },
    { onConflict: "hotel_id" },
  );

  const { error: burnErr } = await admin
    .from("pms_marketplace_claims")
    .update({ claimed_by: userId, claimed_at: now })
    .eq("token", token)
    .is("claimed_at", null);
  if (burnErr) {
    console.error(
      JSON.stringify({ fn: "redeemMarketplaceClaim", step: "burn_token", hotelId, error: burnErr.message }),
    );
  }

  await admin.rpc("platform_log_event", {
    p_event_type: "pms.marketplace_claimed",
    p_entity_type: "pms_connection",
    p_entity_id: hotelId,
    p_hotel_id: hotelId,
    p_detail: { pms_type: claim.pms_type, via: "marketplace_flow_a" },
  });

  return { ok: true, hotelId, alreadyClaimed: false };
}

export { MAYA_ACTIVE_HOTEL_COOKIE };
