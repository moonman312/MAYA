import { PathChoice } from "@/components/onboarding/path-choice";
import { SubscribeStep, type SubscribePmsOption } from "@/components/onboarding/subscribe-step";
import { listPmsSignupGates } from "@/lib/billing/pms-gates";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
import { listPmsStatuses } from "@/lib/pms/registry";
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

  const step = await resolveOnboardingStep(createClient(await cookies()));
  if (step === "connect") redirect("/onboarding/connect");
  if (step === "done") redirect("/");
  if (step === "choose") return <PathChoice />;
  return <SubscribeStep cancelled={cancelled} pmsOptions={await subscribePmsOptions()} />;
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
