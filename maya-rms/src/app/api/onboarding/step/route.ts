import { resolveOnboardingStep } from "@/lib/onboarding/step";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/onboarding/step — where this user is in the flow, as one word.
 *
 * Exists so the post-checkout screen can wait for the webhook instead of
 * guessing. It answers from resolveOnboardingStep, the same function the pages
 * redirect on, so a client that polls until it says "connect" and a server that
 * renders on the same value cannot disagree and bounce someone between screens.
 *
 * Reveals nothing a page load wouldn't: the caller's own position in their own
 * signup.
 */
export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // Polled by the confirming screen while it waits on the Stripe webhook. The
  // poller eases off and gives up on its own; a 429 here just reads as "not
  // yet" to it, so a client stuck in a tight loop costs a counter upsert.
  const throttled = await enforceRateLimit("stepPoll", user.id);
  if (throttled) return throttled;

  return NextResponse.json({ step: await resolveOnboardingStep(supabase) });
}
