import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findPendingHotelForUser } from "@/lib/billing/pending-hotel";
import { isStripeConfigured } from "@/lib/billing/stripe";
import { isEntitled } from "@/lib/billing/sync";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";

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
  if (pendingHotelId && (await isPaidFor(supabase, pendingHotelId))) return "connect";

  return "subscribe";
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
