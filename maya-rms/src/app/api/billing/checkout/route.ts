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
import { createAdminClient } from "@/utils/supabase/admin";
import { isStripeConfigured, priceIdFor, stripeClient } from "@/lib/billing/stripe";
import { checkCode, checkoutEffectFor } from "@/lib/billing/codes";
import { isBillableRoomCount, MAX_ROOMS, type BillingInterval } from "@/lib/billing/tiers";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Labels this checkout flow in the Stripe dashboard so it can be compared
 * against any other flow we add later. Constant on purpose — it identifies the
 * flow, not the session; the random suffix is what keeps it distinct from other
 * integrations' labels.
 */
const INTEGRATION_IDENTIFIER = "maya_onboarding_aqxfqvdg";

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

  // A code is required to reach checkout at all while signup is gated. Checked
  // against the service-role client because signup_codes is admin-only under
  // RLS and the person signing up is, by definition, not an admin.
  const admin = createAdminClient();
  const codeCheck = await checkCode(admin, body?.code ?? "", { hotelId });
  if (!codeCheck.ok) {
    return NextResponse.json({ error: codeCheck.message, reason: codeCheck.reason }, { status: 403 });
  }
  const effect = checkoutEffectFor(codeCheck.code);

  const { data: hotel } = await supabase
    .from("hotels")
    .select("name")
    .eq("id", hotelId)
    .maybeSingle();

  try {
    const stripe = stripeClient();
    const price = await priceIdFor(interval);

    // A percent-off code needs a Stripe coupon behind it. Created on first use
    // and written back onto the code row, so every later redemption of the same
    // code reuses one coupon instead of littering the account with duplicates.
    let couponId = effect.discountCouponId;
    if (!couponId && effect.couponNeeded) {
      const coupon = await stripe.coupons.create({
        percent_off: effect.couponNeeded.percentOff,
        ...(effect.couponNeeded.durationMonths
          ? { duration: "repeating", duration_in_months: effect.couponNeeded.durationMonths }
          : { duration: "forever" }),
        name: `MAYA code ${codeCheck.code.code}`,
        metadata: { signup_code_id: codeCheck.code.id },
      });
      couponId = coupon.id;
      const { error: backfillErr } = await admin
        .from("signup_codes")
        .update({ stripe_coupon_id: coupon.id })
        .eq("id", codeCheck.code.id);
      // Not fatal: the coupon exists and this checkout can use it. The next
      // redemption would just create another one, which is untidy but not wrong.
      if (backfillErr) {
        console.error(
          JSON.stringify({ fn: "billingCheckout", step: "coupon_backfill", error: backfillErr.message }),
        );
      }
    }

    // A fixed-price deal is honoured by billing the room count it was struck
    // at, so the owner's stated count doesn't change what was agreed.
    const billedRooms = effect.roomsOverride ?? rooms;

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
      integration_identifier: INTEGRATION_IDENTIFIER,
      line_items: [{ price, quantity: billedRooms }],
      // Collected even for trials: it is what makes billing start on its own
      // when the trial ends, and what the 48-hour re-check has to check.
      payment_method_collection: "always",
      // Stripe rejects allow_promotion_codes alongside discounts, so it can only
      // be stated when no coupon is attached. Absent means off either way, which
      // is what we want: codes are validated against our own table, so Checkout's
      // promo field is never the place one gets honoured.
      ...(couponId ? { discounts: [{ coupon: couponId }] } : { allow_promotion_codes: false }),
      // hotel_id on the subscription is what the webhook keys on — without it a
      // completed payment has nothing to attach to (see sync.ts).
      subscription_data: {
        metadata: { hotel_id: hotelId, signup_code_id: codeCheck.code.id },
        ...(effect.trialDays ? { trial_period_days: effect.trialDays } : {}),
      },
      metadata: {
        hotel_id: hotelId,
        user_id: user.id,
        email: user.email ?? "",
        signup_code_id: codeCheck.code.id,
      },
      // The session id lets the landing page confirm what actually happened
      // rather than trusting that arriving here means the payment went through.
      success_url: `${origin}/onboarding/connect?session_id={CHECKOUT_SESSION_ID}`,
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
