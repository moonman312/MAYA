/**
 * Starts a Stripe Checkout session for a hotel's subscription.
 *
 * Card details never touch MAYA — Checkout is hosted by Stripe, which is what
 * keeps this out of PCI scope. The room count comes from the owner (the PMS
 * import hasn't run yet at this point in the flow); what the import later
 * measures is reconciled separately and surfaced for a human, never silently
 * re-charged.
 */

import { requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { isStripeConfigured, priceIdFor, stripeClient } from "@/lib/billing/stripe";
import { isBillableRoomCount, MAX_ROOMS, type BillingInterval } from "@/lib/billing/tiers";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing is not configured yet." }, { status: 503 });
  }

  // Committing a property to a recurring charge is a finance action, so it sits
  // above the Revenue Manager line with the other money decisions.
  const ctx = await requireSupabaseHotelRank(await cookies(), "general_manager");
  if (!ctx.ok) return ctx.response;
  const { supabase, hotelId } = ctx;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    rooms?: number;
    interval?: string;
    code?: string;
  } | null;

  const rooms = body?.rooms;
  if (!isBillableRoomCount(rooms)) {
    return NextResponse.json(
      { error: `Tell us how many rooms you have — any number from 1 to ${MAX_ROOMS}.` },
      { status: 400 },
    );
  }
  const interval: BillingInterval = body?.interval === "year" ? "year" : "month";

  // One subscription per hotel. Sending someone to Checkout who already has one
  // would create a second and bill them twice.
  const { data: existing } = await supabase
    .from("hotel_subscriptions")
    .select("stripe_customer_id, stripe_subscription_id, status")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (existing?.stripe_subscription_id && existing.status !== "canceled") {
    return NextResponse.json(
      { error: "This property already has a subscription. Manage it from billing settings." },
      { status: 409 },
    );
  }

  const { data: hotel } = await supabase
    .from("hotels")
    .select("name")
    .eq("id", hotelId)
    .maybeSingle();

  try {
    const stripe = stripeClient();
    const price = await priceIdFor(interval);

    // Reuse the customer if this hotel has been here before (a cancelled
    // subscription, or an abandoned checkout) so their history stays in one
    // place in the dashboard.
    const customerId =
      existing?.stripe_customer_id ??
      (
        await stripe.customers.create({
          name: hotel?.name ?? undefined,
          email: user.email ?? undefined,
          metadata: { hotel_id: hotelId },
        })
      ).id;

    const origin = new URL(request.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price, quantity: rooms }],
      // Collected even for trials: it is what makes billing start on its own
      // when the trial ends, and what the 48-hour re-check has to check.
      payment_method_collection: "always",
      // Codes are validated and attached server-side in a later step; Stripe's
      // own promo field stays off so there is exactly one place a code is
      // honoured.
      allow_promotion_codes: false,
      // hotel_id on the subscription is what the webhook keys on — without it a
      // completed payment has nothing to attach to (see sync.ts).
      subscription_data: { metadata: { hotel_id: hotelId } },
      metadata: { hotel_id: hotelId, user_id: user.id, email: user.email ?? "" },
      success_url: `${origin}/onboarding/connect?paid=1`,
      cancel_url: `${origin}/onboarding?checkout=cancelled`,
    });

    if (!session.url) {
      return NextResponse.json({ error: "Stripe did not return a checkout URL." }, { status: 502 });
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not start checkout.";
    console.error(JSON.stringify({ fn: "billingCheckout", hotelId, error: message }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
