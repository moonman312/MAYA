import { ConfirmingPayment } from "@/components/onboarding/confirming-payment";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Where someone waits for a webhook they should never have to think about.
 *
 * Checked on the server first so the common case never renders: by the time the
 * browser follows the redirect from Stripe, the payment is usually already
 * recorded, and showing a "please wait" that vanishes instantly is worse than
 * not showing one. Only a genuine gap reaches the client component, which then
 * polls its own way out.
 */
export default async function ConfirmingPage() {
  if (!isSupabaseConfigured()) redirect("/onboarding");

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const step = await resolveOnboardingStep(supabase);
  if (step === "connect") redirect("/onboarding/connect");
  if (step !== "subscribe") redirect("/onboarding");

  return <ConfirmingPayment />;
}
