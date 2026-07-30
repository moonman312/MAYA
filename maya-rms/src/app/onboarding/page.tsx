import { PathChoice } from "@/components/onboarding/path-choice";
import { SubscribeStep } from "@/components/onboarding/subscribe-step";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
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
  return <SubscribeStep cancelled={cancelled} />;
}
