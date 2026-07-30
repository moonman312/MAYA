/**
 * Where Stripe sends the owner after Checkout.
 *
 * The webhook is still the authority on what a hotel owes. This exists because
 * it is asynchronous and the next screen has to know whether they paid: landing
 * on the PMS picker before the webhook does would bounce someone who just handed
 * over a card back to the payment form. So the session is read from Stripe here
 * and projected through the same sync.ts the webhook uses — same row, same
 * upsert, keyed on hotel_id, so whichever arrives first wins and the other is a
 * no-op.
 *
 * The session id in the URL proves nothing on its own; it is a value the browser
 * can edit. It is fetched from Stripe and checked to belong to the signed-in
 * caller before any of it is believed. Nothing here trusts the query string, and
 * nothing here grants anything Stripe didn't already say.
 *
 * Redemptions are deliberately left to the webhook: it records them on
 * checkout.session.completed, and two writers racing a unique index to log the
 * same fact buys nothing.
 */

import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { isStripeConfigured, stripeClient } from "@/lib/billing/stripe";
import { persistSubscription, projectSubscription } from "@/lib/billing/sync";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin), { status: 303 });

  if (!isStripeConfigured() || !isSupabaseConfigured()) return to("/onboarding");

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return to("/login");

  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return to("/onboarding");

  try {
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    // Someone else's session id, or one from a different account entirely.
    if (session.metadata?.user_id !== user.id) return to("/onboarding");

    const subId =
      typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (subId) {
      // Re-fetched rather than read off the session for the same reason the
      // webhook re-fetches: the embedded copy is a snapshot of some earlier
      // moment. An unpaid or incomplete subscription projects with that status
      // and simply doesn't count as entitled.
      const sub = await stripe.subscriptions.retrieve(subId);
      const row = projectSubscription(sub);
      if (row) await persistSubscription(createAdminClient(), row);
    }
  } catch (e) {
    // Carry on: the webhook writes the same row, and the PMS picker sends them
    // back to payment if it never turns up.
    console.error(
      JSON.stringify({
        fn: "checkoutReturn",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  return to("/onboarding/connect");
}
