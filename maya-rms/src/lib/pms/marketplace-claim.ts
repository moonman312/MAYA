import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { MAYA_ACTIVE_HOTEL_COOKIE } from "@/lib/hotel-context";
import { isStripeConfigured } from "@/lib/billing/stripe";
import {
  activateMarketplaceHotelIfPending,
  hasEntitledSubscription,
} from "@/lib/pms/marketplace-activate";

/**
 * Redeem a Flow A claim ticket.
 *
 * The Marketplace callback has already done the irreversible half: the grant is
 * spent, the tokens are in the Vault, and an inert hotel row exists to hold
 * them. What is missing is an OWNER. This attaches one. It does NOT make the
 * property live — that waits for a subscription (marketplace-activate.ts), so
 * an owned-but-unpaid Marketplace hotel looks exactly like the placeholder
 * Flow B's checkout creates: is_active false, setup_pending_at set, one member.
 * The subscribe screen finds it by that shape, and nothing about the property
 * is imported until someone has paid for it.
 *
 * Deliberately idempotent-ish: a ticket is single-use, but re-claiming by the
 * SAME user is treated as success rather than an error, because a refresh or a
 * double-submit after signing in should not look like a failure to the owner.
 */

export type ClaimResult =
  | { ok: true; hotelId: string; alreadyClaimed: boolean; hotelIds: string[] }
  | { ok: false; reason: "not_found" | "expired" | "taken" | "failed"; message: string };

export async function redeemMarketplaceClaim(
  token: string,
  userId: string,
): Promise<ClaimResult> {
  const admin = createAdminClient();

  const BASE_COLS = "token, hotel_id, pms_type, property_name, expires_at, claimed_by, claimed_at";
  // group_key arrives in its own migration. Selecting a column that does not
  // exist is a hard PostgREST error (42703), so a claim would be unredeemable
  // if this code deployed ahead of the SQL — fall back and lose only bundling.
  let { data: claim } = await admin
    .from("pms_marketplace_claims")
    .select(`${BASE_COLS}, group_key`)
    .eq("token", token)
    .maybeSingle();
  if (!claim) {
    const fallback = await admin
      .from("pms_marketplace_claims")
      .select(BASE_COLS)
      .eq("token", token)
      .maybeSingle();
    claim = fallback.data as typeof claim;
  }

  if (!claim) {
    return { ok: false, reason: "not_found", message: "That connection link is not valid." };
  }
  if (claim.claimed_at) {
    // The same person coming back is fine; a different one is not.
    if (claim.claimed_by === userId) {
      return { ok: true, hotelId: String(claim.hotel_id), alreadyClaimed: true, hotelIds: [String(claim.hotel_id)] };
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

  // A group grant parks one property per hotel and ties them with a group_key.
  // The owner clicked ONE link, so they get all of their hotels — handing back
  // the first and leaving the rest parked would be the same silent drop this
  // was built to fix. Expiry is re-checked per sibling: the bundle was minted
  // together, but a row that somehow outlived its window is still not claimable.
  const siblings: { token: string; hotel_id: string }[] = [];
  if ((claim as { group_key?: string | null }).group_key) {
    const { data: rest } = await admin
      .from("pms_marketplace_claims")
      .select("token, hotel_id, expires_at")
      .eq("group_key", (claim as { group_key?: string | null }).group_key!)
      .is("claimed_at", null)
      .neq("token", token);
    for (const r of rest ?? []) {
      if (new Date(String(r.expires_at)).getTime() < Date.now()) continue;
      siblings.push({ token: String(r.token), hotel_id: String(r.hotel_id) });
    }
  }
  const allHotelIds = [hotelId, ...siblings.map((s) => s.hotel_id)];

  // Service role means auth.uid() is null, so the auto-membership trigger will
  // not fire — write it explicitly, exactly as the onboarding callback does.
  const { error: memberErr } = await admin.from("hotel_memberships").upsert(
    allHotelIds.map((id) => ({ hotel_id: id, user_id: userId, role: "hotel_admin", status: "active" })),
    { onConflict: "hotel_id,user_id" },
  );
  if (memberErr) {
    return { ok: false, reason: "failed", message: `Could not link you to the property: ${memberErr.message}` };
  }

  // Simulation mode ON: a property that arrives through the Marketplace has
  // never been configured by anyone, so nothing may reach its live rates until
  // its owner deliberately goes live.
  const { error: settingsErr } = await admin.from("hotel_settings").upsert(
    allHotelIds.map((id) => ({
      hotel_id: id,
      pricing_horizon_days: 365,
      pickup_window_cycles: 1,
      simulation_mode: true,
      rounding_mode: "none",
    })),
    { onConflict: "hotel_id" },
  );
  if (settingsErr) {
    return { ok: false, reason: "failed", message: `Could not set up pricing: ${settingsErr.message}` };
  }

  // The property stays parked until it is paid for. Two cases do not wait: an
  // install with no Stripe keys cannot take a payment and would strand everyone
  // at a form that cannot be paid, and a hotel that already holds a live
  // subscription — the same owner reconnecting after a card change, say — has
  // paid already. The claim row is handed over because its claimed_at is not
  // on disk yet; the burn below is what writes it.
  const claimFor = (id: string, token: string) => ({
    token,
    hotel_id: id,
    pms_type: String(claim.pms_type),
    property_name: id === hotelId ? (claim.property_name as string | null) : null,
    claimed_by: userId,
    claimed_at: now,
  });
  for (const id of allHotelIds) {
    if (!isStripeConfigured() || (await hasEntitledSubscription(admin, id))) {
      const token_ = id === hotelId ? token : siblings.find((s) => s.hotel_id === id)!.token;
      const activation = await activateMarketplaceHotelIfPending(admin, id, {
        requestedBy: userId,
        claim: claimFor(id, token_),
      });
      if (!activation.activated && activation.reason === "failed") {
        return { ok: false, reason: "failed", message: `Could not activate the property: ${activation.message}` };
      }
    }
  }

  const { error: burnErr } = await admin
    .from("pms_marketplace_claims")
    .update({ claimed_by: userId, claimed_at: now })
    .in("token", [token, ...siblings.map((s) => s.token)])
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
    p_detail: {
      pms_type: claim.pms_type,
      via: "marketplace_flow_a",
      ...(allHotelIds.length > 1 ? { group_properties: allHotelIds.length } : {}),
    },
  });

  return { ok: true, hotelId, alreadyClaimed: false, hotelIds: allHotelIds };
}

export { MAYA_ACTIVE_HOTEL_COOKIE };
