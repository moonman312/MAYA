import { listPmsStatuses } from "@/lib/pms/registry";
import { ConnectPms } from "@/components/onboarding/connect-pms";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function ConnectPage() {
  if (isSupabaseConfigured()) {
    const step = await resolveOnboardingStep(createClient(await cookies()));
    // Guards two ways at once. Arriving before paying sends them to the payment
    // step; arriving after a property already exists (the back button, a stale
    // tab) sends them away too, because the onboarding OAuth state carries a
    // user rather than a hotel and connecting a second time would build a second
    // property beside the one they paid for.
    if (step !== "connect") redirect("/onboarding");
  }

  return <ConnectPms pmsOptions={listPmsStatuses()} />;
}
