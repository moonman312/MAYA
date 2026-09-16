import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  findPendingHotelForUser,
  findPendingHotelSubscription,
  listUnpaidMarketplaceHotels,
} from "@/lib/billing/pending-hotel";
import { isStripeConfigured } from "@/lib/billing/stripe";
import { isEntitled } from "@/lib/billing/sync";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { activateMarketplaceHotelIfPending } from "@/lib/pms/marketplace-activate";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";

/**
 * Where the signed-in user is in onboarding.
 *
 * In flow order: pay, connect a PMS, choose how much help you want, done. One
 * function because /onboarding, the connect page, the questions page and the
 * dashboard all have to agree — three separate readings of "have they paid yet"
 * is how someone ends up staring at a payment form they already filled in.
 */
export type OnboardingStep = "subscribe" | "connect" | "choose" | "done";

export async function resolveOnboardingStep(
  supabase: SupabaseClient,
): Promise<OnboardingStep> {
  // A group grant from the Marketplace parks several properties under one
  // owner and they are paid for one at a time, so an owner with a live property
  // can still owe a checkout. Checked first, before the live property wins:
  // otherwise the second property is never offered payment and stays parked
  // forever. Scoped to redeemed Marketplace claims, so Flow B — one placeholder,
  // adopted by the PMS connect — reads exactly as it did.
  if (isStripeConfigured()) {
    const userId = await currentUserId(supabase);
    if (userId) {
      try {
        const unpaid = await listUnpaidMarketplaceHotels(createAdminClient(), userId);
        if (unpaid.length > 0) return "subscribe";
      } catch {
        // No admin client (a test, an install without the service key): the
        // ordinary reading below stands.
      }
    }
  }

  // An active property means the connect callback ran and adopted the row
  // checkout created, so billing stops gating onboarding from here. Being behind
  // on payment and being half-onboarded are different problems; the dunning
  // banner owns the first one and must not turn into a second signup.
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (hotelId) return (await hasChosenPath(supabase)) ? "done" : "choose";

  // A deployment with no Stripe keys cannot take a payment at all, so asking for
  // one is a dead end. Those installs onboard straight into the PMS connect.
  if (!isStripeConfigured()) return "connect";

  const pendingHotelId = await pendingHotelFor(supabase);
  if (pendingHotelId && (await isPaidFor(supabase, pendingHotelId))) {
    // A paid Marketplace property is already connected and only needs
    // activating, which the webhook normally did before anyone asked. If a
    // page got here first, do it now: the PMS picker would connect it twice.
    if (await activateIfMarketplace(pendingHotelId)) return "choose";
    return "connect";
  }

  return "subscribe";
}

/**
 * Whether to offer "Manage billing or cancel" on an onboarding screen: the
 * caller's still-pending property has a subscription left to cancel, which
 * the billing page cannot reach until the PMS is connected. Any doubt hides
 * the link rather than breaking the page it sits on; the portal route checks
 * again on its own.
 */
export async function hasPendingSubscriptionToManage(supabase: SupabaseClient): Promise<boolean> {
  if (!isStripeConfigured() || !isAdminConfigured()) return false;
  const userId = await currentUserId(supabase);
  if (!userId) return false;
  try {
    return (await findPendingHotelSubscription(createAdminClient(), userId)) != null;
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "hasPendingSubscriptionToManage",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return false;
  }
}

/** True for a Marketplace property (activated now, or already), false for Flow B's placeholder. */
async function activateIfMarketplace(hotelId: string): Promise<boolean> {
  try {
    const r = await activateMarketplaceHotelIfPending(createAdminClient(), hotelId);
    if (r.activated) return true;
    if (r.reason === "not_marketplace" || r.reason === "not_found") return false;
    if (r.reason === "failed") {
      console.error(
        JSON.stringify({ fn: "resolveOnboardingStep", step: "activate_marketplace", hotelId, error: r.message }),
      );
    }
    return true;
  } catch {
    // No admin client here (a test, an install without the service key): the
    // webhook still owns activation, and this reads as Flow B.
    return false;
  }
}

async function pendingHotelFor(supabase: SupabaseClient): Promise<string | null> {
  const userId = await currentUserId(supabase);
  return userId ? findPendingHotelForUser(supabase, userId) : null;
}

async function isPaidFor(supabase: SupabaseClient, hotelId: string): Promise<boolean> {
  const { data } = await supabase
    .from("hotel_subscriptions")
    .select("status")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  return isEntitled(data?.status);
}

/**
 * Either button on the choice screen counts: "let me drive" records the path and
 * stamps onboarding_dismissed_at, and a user who dismissed onboarding under an
 * older build has only the stamp.
 */
async function hasChosenPath(supabase: SupabaseClient): Promise<boolean> {
  const userId = await currentUserId(supabase);
  // No session: the layout has already sent them to /login, and claiming there's
  // a choice outstanding would render the screen for nobody.
  if (!userId) return true;

  const { data } = await supabase
    .from("profiles")
    .select("onboarding_path, onboarding_dismissed_at")
    .eq("id", userId)
    .maybeSingle();
  return Boolean(data?.onboarding_path || data?.onboarding_dismissed_at);
}

/** Cookie read only — see the note in hotel-context.ts about auth round-trips. */
async function currentUserId(supabase: SupabaseClient): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}
