import { PathChoice } from "@/components/onboarding/path-choice";
import { SubscribeStep, type SubscribePmsOption } from "@/components/onboarding/subscribe-step";
import { findPendingHotelForUser } from "@/lib/billing/pending-hotel";
import { listPmsSignupGates } from "@/lib/billing/pms-gates";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
import { findMarketplaceClaimForHotel, marketplaceTrialDays } from "@/lib/pms/marketplace-activate";
import { listPmsStatuses } from "@/lib/pms/registry";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * The front door of onboarding, which is payment now. Whichever step the user is
 * actually on gets rendered here rather than living behind its own URL, so there
 * is one place to come back to — from a cancelled checkout, a closed tab, the
 * dashboard — and it always lands on the right thing.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const cancelled = (await searchParams).checkout === "cancelled";

  // No Supabase means no user and no billing, so there is nothing to resolve —
  // the demo build keeps the path choice it has always shown.
  if (!isSupabaseConfigured()) return <PathChoice />;

  const supabase = createClient(await cookies());
  const step = await resolveOnboardingStep(supabase);
  if (step === "connect") redirect("/onboarding/connect");
  if (step === "done") redirect("/");
  if (step === "choose") return <PathChoice />;

  const marketplace = await marketplaceArrival(supabase);
  if (marketplace) {
    const days = marketplace.trialDays;
    return (
      <SubscribeStep
        cancelled={cancelled}
        lockPms
        pmsOptions={[
          { type: marketplace.pmsType, displayName: marketplace.displayName, requiresSignupCode: false },
        ]}
        title={`${marketplace.propertyName ?? "Your property"} is connected`}
        intro={
          days > 0
            ? `Try MAYA free for ${days} days. Set up a payment method and your booking history starts importing right away — nothing is charged until the trial ends, and you can cancel any time.`
            : "Set up a payment method and your booking history starts importing right away."
        }
        baseTrialDays={days}
        submitLabel={days > 0 ? "Set up payment" : "Continue to payment"}
        footnote="Card details are handled by Stripe — they never touch MAYA. Your history starts importing the moment payment is set up."
      />
    );
  }
  return <SubscribeStep cancelled={cancelled} pmsOptions={await subscribePmsOptions()} />;
}

/**
 * A property that arrived from the Cloudbeds Marketplace is connected and owned
 * but not paid for. It gets the same subscribe screen with the PMS settled, no
 * code asked for, and the Marketplace trial shown. It is also where a bounced
 * checkout lands back, so setting up payment is always one click away.
 */
async function marketplaceArrival(supabase: SupabaseClient): Promise<{
  pmsType: string;
  displayName: string;
  propertyName: string | null;
  trialDays: number;
} | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return null;
    const hotelId = await findPendingHotelForUser(supabase, userId);
    if (!hotelId) return null;
    const claim = await findMarketplaceClaimForHotel(createAdminClient(), hotelId);
    if (!claim) return null;
    const pms = listPmsStatuses().find((p) => p.type === claim.pms_type);
    return {
      pmsType: claim.pms_type,
      displayName: pms?.displayName ?? claim.pms_type,
      propertyName: claim.property_name,
      trialDays: marketplaceTrialDays(),
    };
  } catch (e) {
    // Falls back to the ordinary screen: they can still pay, they just get
    // asked which PMS they use and for a code they do not have.
    console.error(
      JSON.stringify({ fn: "marketplaceArrival", error: e instanceof Error ? e.message : String(e) }),
    );
    return null;
  }
}

/**
 * Which PMS answer decides whether the code field is optional, so it carries
 * each gate's state (/admin/pms-access). "Something else" is always gated: an
 * unknown system can't have had its gate opened.
 */
async function subscribePmsOptions(): Promise<SubscribePmsOption[]> {
  let gates: Awaited<ReturnType<typeof listPmsSignupGates>> = [];
  try {
    gates = await listPmsSignupGates(createAdminClient());
  } catch (e) {
    // Same failure direction as pmsSignupCodeRequired: an unreadable gate
    // means the code stays required, never that signup swings open.
    console.error(
      JSON.stringify({
        fn: "subscribePmsOptions",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
  const requiredFor = (type: string) =>
    gates.find((g) => g.pmsType === type)?.requiresSignupCode ?? true;
  return [
    ...listPmsStatuses().map((pms) => ({
      type: pms.type as string,
      displayName: pms.displayName,
      requiresSignupCode: requiredFor(pms.type),
    })),
    { type: "other", displayName: "Something else", requiresSignupCode: true },
  ];
}
