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
import { isEntitled, persistSubscription, projectSubscription } from "@/lib/billing/sync";
import { listUnpaidMarketplaceHotels } from "@/lib/billing/pending-hotel";
import { activateMarketplaceHotelIfPending } from "@/lib/pms/marketplace-activate";
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
  // Checkout puts the hotel on the success URL. Browser-editable, so it is
  // never believed for anything but which property the waiting screen should
  // watch — and the status route that screen polls checks membership itself.
  const hintedHotelId = hotelIdHint(url.searchParams.get("hotel"));

  // Which hotel this payment was for, once Stripe has said so. The waiting
  // screen needs it: an owner paying for a group one property at a time has a
  // live property already, so "are they past payment" is no longer a question
  // about the account — it is about this hotel.
  let paidHotelId: string | null = null;

  try {
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    // Someone else's session id, or one from a different account entirely.
    if (session.metadata?.user_id !== user.id) return to("/onboarding");
    paidHotelId = session.metadata?.hotel_id || null;

    const subId =
      typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (subId) {
      // Re-fetched rather than read off the session for the same reason the
      // webhook re-fetches: the embedded copy is a snapshot of some earlier
      // moment. An unpaid or incomplete subscription projects with that status
      // and simply doesn't count as entitled.
      const sub = await stripe.subscriptions.retrieve(subId);
      const row = projectSubscription(sub);
      if (row) {
        const admin = createAdminClient();
        await persistSubscription(admin, row);
        // Straight on only when the payment is genuinely recorded AND live. A
        // subscription still `incomplete` writes fine and entitles nobody, so
        // treating a successful write as success would land them right back on
        // the payment form.
        if (isEntitled(row.status)) {
          // A Marketplace property is already connected; the payment is what
          // makes it live. The webhook normally gets there first — if the
          // browser won the race, do it here, and send them to the router
          // rather than to a PMS picker for a PMS they already have.
          const activation = await activateMarketplaceHotelIfPending(admin, row.hotel_id, {
            requestedBy: user.id,
          }).catch((e: unknown) => {
            console.error(
              JSON.stringify({
                fn: "checkoutReturn",
                step: "activate_marketplace",
                error: e instanceof Error ? e.message : String(e),
              }),
            );
            return null;
          });
          const marketplace =
            activation != null &&
            (activation.activated ||
              (activation.reason !== "not_marketplace" && activation.reason !== "not_found"));
          // A group grant is paid for one property at a time. Anything still
          // parked goes back to the subscribe screen, which offers the next
          // one; the card just taken is on the same customer, so it is short.
          const remaining = await listUnpaidMarketplaceHotels(admin, user.id).catch((e: unknown) => {
            console.error(
              JSON.stringify({
                fn: "checkoutReturn",
                step: "remaining_siblings",
                error: e instanceof Error ? e.message : String(e),
              }),
            );
            return [];
          });
          if (remaining.length > 0) return to("/onboarding");
          return to(marketplace ? "/onboarding" : "/onboarding/connect");
        }
      }
    }
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "checkoutReturn",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  // Anything else — Stripe unreachable, the subscription not live yet, the
  // session carrying no subscription at all — goes to a screen that waits for
  // the webhook and moves them on by itself. Sending them to the PMS picker
  // meant its own guard bounced them to /onboarding, which renders the payment
  // form: someone who had just paid was invited to pay again, with nothing on
  // screen to suggest that would be a mistake.
  //
  // Named hotel when there is one, so the screen waits on THIS property's
  // subscription rather than the account's step — which stays "subscribe" for
  // as long as a group has another property to pay for.
  const waitOn = paidHotelId ?? hintedHotelId;
  return to(
    waitOn ? `/onboarding/confirming?hotel=${encodeURIComponent(waitOn)}` : "/onboarding/confirming",
  );
}

/** A plausible id and nothing else, so no path or query characters reach a redirect. */
function hotelIdHint(raw: string | null): string | null {
  return raw && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}
