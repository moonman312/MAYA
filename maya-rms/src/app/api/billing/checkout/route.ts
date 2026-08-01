/**
 * Starts a Stripe Checkout session for a hotel's subscription.
 *
 * Card details never touch MAYA — Checkout is hosted by Stripe, which is what
 * keeps this out of PCI scope. The room count comes from the owner (the PMS
 * import hasn't run yet at this point in the flow); what the import later
 * measures is reconciled separately and surfaced for a human, never silently
 * re-charged.
 *
 * This is the FIRST step of onboarding now, so it usually runs before any
 * property exists. hotel_id in the subscription's metadata is the only thing
 * sync.ts can attach a payment to, so the hotel row is created here and the PMS
 * connect adopts it (lib/billing/pending-hotel.ts). Nothing reaches Stripe until
 * that row exists.
 */

import { hasHotelRank } from "@/lib/require-supabase-hotel";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { roleLabel } from "@/lib/roles";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { findPendingHotelForUser, provisionPendingHotel } from "@/lib/billing/pending-hotel";
import { isStripeConfigured, priceIdFor, stripeClient } from "@/lib/billing/stripe";
import { checkCode, checkoutEffectFor, type CheckoutEffect } from "@/lib/billing/codes";
import { pmsSignupCodeRequired } from "@/lib/billing/pms-gates";
import { isEntitled } from "@/lib/billing/sync";
import { enforceRateLimit } from "@/lib/rate-limit";
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
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    rooms?: number;
    interval?: string;
    code?: string;
    /**
     * Which PMS they intend to use, from the subscribe screen's picker.
     * Optional — "Something else" and older callers send none, and no
     * declaration means a code is required. Self-declared and therefore not
     * trusted on its own: connecting a gated PMS is separately enforced at the
     * OAuth kickoff (lib/pms/oauth-flow.ts), so lying here buys nothing.
     */
    pmsType?: string;
  } | null;

  const rooms = body?.rooms;
  if (!isBillableRoomCount(rooms)) {
    return NextResponse.json(
      { error: `Tell us how many rooms you have — any number from 1 to ${MAX_ROOMS}.` },
      { status: 400 },
    );
  }
  const interval: BillingInterval = body?.interval === "year" ? "year" : "month";

  // Committing a property that already exists to a recurring charge is a finance
  // action, so it stays above the Revenue Manager line with the other money
  // decisions. A first-time signup has no property, and so nobody to outrank:
  // the row is created below and whoever paid for it is its admin.
  const existingHotelId = await resolveAccessibleHotelId(supabase);
  if (existingHotelId && !(await hasHotelRank(supabase, existingHotelId, "general_manager"))) {
    return NextResponse.json(
      { error: `This needs ${roleLabel("general_manager")} access or higher on this property.` },
      { status: 403 },
    );
  }

  // Each attempt can mint a Stripe customer and a Checkout Session. The
  // idempotency key collapses identical retries, but varying the room count
  // defeats it, so the count itself needs a ceiling.
  const throttled = await enforceRateLimit("checkout", user.id,
    "Too many checkout attempts. Wait a few minutes and try again.");
  if (throttled) return throttled;

  const admin = createAdminClient();

  // Reuse whatever an abandoned checkout left behind, so bouncing off the card
  // form three times doesn't leave three properties. A failed lookup throws
  // rather than answering "none": carrying on would provision a second property
  // beside one they may already be paying for, and the honest response to not
  // knowing is to stop before Stripe is involved at all.
  let hotelId: string | null;
  try {
    hotelId = existingHotelId ?? (await findPendingHotelForUser(admin, user.id));
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "billingCheckout",
        step: "find_pending",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return NextResponse.json(
      { error: "We couldn't load your account just now. Please try again in a moment." },
      { status: 503 },
    );
  }

  // One subscription per hotel. Sending someone to Checkout who already has one
  // would create a second and bill them twice.
  const { data: existing } = hotelId
    ? await supabase
        .from("hotel_subscriptions")
        .select("stripe_customer_id, stripe_subscription_id, status")
        .eq("hotel_id", hotelId)
        .maybeSingle()
    : { data: null };
  // Only a subscription that is actually doing something blocks a new one.
  // Testing for "not canceled" instead trapped every dead-but-not-canceled
  // state — incomplete (they abandoned the card form), incomplete_expired,
  // unpaid after dunning gave up — with a message telling them to manage a
  // subscription in billing settings that would never charge or serve them.
  // A hotel in that state has paid nothing and has no way forward.
  if (existing?.stripe_subscription_id && isEntitled(existing.status)) {
    return NextResponse.json(
      { error: "This property already has a subscription. Manage it at /account/billing." },
      { status: 409 },
    );
  }

  // A code is required to reach checkout at all while signup is gated — but
  // that gate is now per PMS (see /admin/pms-access), so a declared PMS whose
  // gate is off may proceed with none. Typing one anyway is still validated
  // and honoured either way: this only ever widens who may check out with NO
  // code, never who gets to skip validation of a code they actually typed. A
  // typo'd real code has to fail loudly, not be silently discarded — someone
  // who thought they had a discount deserves to know it didn't apply, not
  // find out on their card statement.
  const typedCode = (body?.code ?? "").trim();
  const codeRequired =
    !body?.pmsType || (await pmsSignupCodeRequired(admin, body.pmsType));

  let signupCodeId: string | null = null;
  let signupCodeLabel: string | null = null;
  let effect: CheckoutEffect = {};
  if (typedCode || codeRequired) {
    // Checked against the service-role client because signup_codes is
    // admin-only under RLS and the person signing up is, by definition, not an
    // admin. The interval goes in because a code's meaning can depend on it: a
    // fixed price was agreed per period, and a duration-limited discount is
    // worth different money on a yearly invoice than a monthly one.
    const codeCheck = await checkCode(admin, typedCode, { hotelId, interval });
    if (!codeCheck.ok) {
      return NextResponse.json({ error: codeCheck.message, reason: codeCheck.reason }, { status: 403 });
    }
    signupCodeId = codeCheck.code.id;
    signupCodeLabel = codeCheck.code.code;
    effect = checkoutEffectFor(codeCheck.code, interval);
  }

  // After the code check so a rejected code leaves nothing behind; before Stripe
  // because a subscription without a hotel_id in its metadata is a payment
  // nothing can be attached to.
  if (!hotelId) {
    const provisioned = await provisionPendingHotel(admin, user.id);
    if (!provisioned.ok) {
      console.error(
        JSON.stringify({ fn: "billingCheckout", step: "provision", error: provisioned.error }),
      );
      return NextResponse.json(
        { error: "Could not set your property up for billing. Please try again." },
        { status: 500 },
      );
    }
    hotelId = provisioned.hotelId;
  }

  // Only a real property has a name worth putting on the Stripe customer — a
  // placeholder reads worse in the dashboard than the email on its own.
  let customerName: string | undefined;
  if (existingHotelId) {
    const { data: hotel } = await supabase
      .from("hotels")
      .select("name")
      .eq("id", existingHotelId)
      .maybeSingle();
    customerName = hotel?.name ?? undefined;
  }

  try {
    const stripe = stripeClient();
    const price = await priceIdFor(interval);

    // A percent-off code needs a Stripe coupon behind it. Created on first use
    // and written back onto the code row, so every later redemption of the same
    // code reuses one coupon instead of littering the account with duplicates.
    let couponId = effect.discountCouponId;
    const spec = effect.couponNeeded;
    if (!couponId && spec) {
      const coupon = await stripe.coupons.create(
        {
          ...(spec.percentOff != null
            ? { percent_off: spec.percentOff }
            : { amount_off: spec.amountOffCents, currency: "usd" }),
          duration: spec.duration,
          ...(spec.duration === "repeating" ? { duration_in_months: spec.durationMonths } : {}),
          name: `MAYA code ${signupCodeLabel}`,
          metadata: { signup_code_id: signupCodeId ?? "", billing_interval: interval },
        },
        // Keyed on everything that shapes the coupon, so bouncing off the card
        // form reuses the one already made — the annual-rescaled form is never
        // cached on the code row, and without this every attempt minted another
        // — while an edited code changes the key rather than colliding with the
        // old parameters.
        {
          idempotencyKey:
            `maya_coupon_${signupCodeId}_${interval}_` +
            `${spec.percentOff != null ? `p${spec.percentOff}` : `a${spec.amountOffCents}`}_` +
            `${spec.duration}_${spec.durationMonths ?? 0}_${signupCodeLabel}`,
        },
      );
      couponId = coupon.id;

      // Only the period-independent form gets remembered. Caching the annual
      // rescaling would hand a monthly buyer a percentage worked out for a year.
      if (spec.reusable) {
        const { error: backfillErr } = await admin
          .from("signup_codes")
          .update({ stripe_coupon_id: coupon.id })
          .eq("id", signupCodeId ?? "");
        // Not fatal: the coupon exists and this checkout can use it. The next
        // redemption would just create another one, untidy but not wrong.
        if (backfillErr) {
          console.error(
            JSON.stringify({ fn: "billingCheckout", step: "coupon_backfill", error: backfillErr.message }),
          );
        }
      }
    }

    // A fixed-price deal is honoured by billing the room count it was struck
    // at, so the owner's stated count doesn't change what was agreed.
    const billedRooms = effect.roomsOverride ?? rooms;

    // Reuse the customer if this hotel has been here before, so their history
    // stays in one place in the dashboard. A cancelled subscription left its
    // customer id on the row; an abandoned checkout never got that far, so its
    // customer is found back through the hotel_id stamped on it — otherwise
    // bouncing off the card form three times leaves three customers on one
    // email. Search indexing lags a minute or so behind creation, which is what
    // the idempotency key on the create is for: inside that window Stripe hands
    // back the customer it already made instead of another.
    let customerId = existing?.stripe_customer_id ?? null;
    if (!customerId) {
      const found = await stripe.customers.search({
        query: `metadata['hotel_id']:'${hotelId}'`,
        limit: 1,
      });
      customerId = found.data[0]?.id ?? null;
    }
    if (!customerId) {
      customerId = (
        await stripe.customers.create(
          {
            name: customerName,
            email: user.email ?? undefined,
            metadata: { hotel_id: hotelId },
          },
          { idempotencyKey: `maya_customer_${hotelId}` },
        )
      ).id;
    }

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
      // completed payment has nothing to attach to (see sync.ts). user_id rides
      // along because that hotel gets renamed on connect and could be deleted:
      // it is what gets a human back to the person who actually paid.
      subscription_data: {
        metadata: {
          hotel_id: hotelId,
          user_id: user.id,
          ...(signupCodeId ? { signup_code_id: signupCodeId } : {}),
        },
        ...(effect.trialDays ? { trial_period_days: effect.trialDays } : {}),
      },
      metadata: {
        hotel_id: hotelId,
        user_id: user.id,
        email: user.email ?? "",
        ...(signupCodeId ? { signup_code_id: signupCodeId } : {}),
      },
      // Through the return route rather than straight to the PMS picker: that
      // page decides whether they have paid, and the webhook which would tell it
      // so arrives whenever it arrives. See ./return/route.ts.
      success_url: `${origin}/api/billing/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/onboarding?checkout=cancelled`,
    },
    // One session per hotel per offer. The 409 above only knows about a
    // subscription that already exists, which is no help while two sessions are
    // still open — a double-clicked button, or the page open in two tabs, made
    // two, and completing both bills the property twice while persistSubscription
    // upserts on hotel_id and keeps a single row. The second subscription then
    // charges forever with nothing locally pointing at it.
    //
    // Keyed on everything that defines the offer, so genuinely changing the room
    // count or the period still starts a new session rather than silently
    // returning the old price.
    { idempotencyKey: `maya_checkout_${hotelId}_${interval}_${billedRooms}_${signupCodeId ?? "none"}` });

    if (!session.url) {
      return NextResponse.json({ error: "Stripe did not return a checkout URL." }, { status: 502 });
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    // The real message goes to the log only. Stripe failures name lookup keys,
    // scripts and account state — none of it is for the person holding a card.
    console.error(
      JSON.stringify({
        fn: "billingCheckout",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return NextResponse.json(
      { error: "We couldn't start checkout just now. Please try again in a moment." },
      { status: 502 },
    );
  }
}
