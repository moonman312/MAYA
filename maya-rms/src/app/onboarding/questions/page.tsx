import { StrategyQuestions } from "@/components/onboarding/strategy-questions";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function QuestionsPage() {
  if (isSupabaseConfigured()) {
    // These questions are asked against a property whose import is already
    // running — reached any earlier (a bookmark, a deep link) the screen has
    // nothing to show and no progress to report.
    const step = await resolveOnboardingStep(createClient(await cookies()));
    if (step === "subscribe" || step === "connect") redirect("/onboarding");
  }

  return <StrategyQuestions />;
}
