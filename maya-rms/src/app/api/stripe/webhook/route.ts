/**
 * Stripe webhook — the only path that may change what a hotel owes.
 *
 * Two things this route must never do: trust an unsigned body, and trust the
 * object inside the event. The signature check is what stops anyone who knows
 * the URL from granting themselves a subscription; re-fetching the subscription
 * from Stripe is what stops out-of-order or replayed deliveries from persisting
 * a stale state over a newer one (see lib/billing/sync.ts).
 *
 * Returns 200 for anything already handled or not our concern. A non-2xx tells
 * Stripe to retry, so it is reserved for failures a retry could actually fix.
 */

import { createAdminClient } from "@/utils/supabase/admin";
import { isStripeConfigured, stripeClient } from "@/lib/billing/stripe";
import { persistSubscription, projectSubscription } from "@/lib/billing/sync";
import { decideNudge, sendRenewalNudge, type UpcomingInvoice } from "@/lib/billing/renewal-nudge";
import { NextResponse } from "next/server";
import type Stripe from "stripe";

// The signature is computed over the exact bytes Stripe sent, so this handler
// needs the raw body and must not run anywhere the body gets parsed for it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
]);

export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Without the secret every body is unverifiable, and accepting one would be
    // strictly worse than being down.
    console.error(JSON.stringify({ fn: "stripeWebhook", error: "STRIPE_WEBHOOK_SECRET missing" }));
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const raw = await request.text();
  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(raw, signature, secret);
  } catch (e) {
    // Bad signature or a timestamp outside the tolerance window (replay). 400,
    // not 500: a retry of the same forged body will fail identically.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Signature verification failed" },
      { status: 400 },
    );
  }

  const stripe = stripeClient();
  const admin = createAdminClient();

  try {
    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      const subId = (event.data.object as Stripe.Subscription).id;
      const fresh = await stripe.subscriptions.retrieve(subId);
      const row = projectSubscription(fresh);
      if (!row) {
        // No hotel_id in metadata: created outside our checkout, so there is
        // nothing to attach it to. Acknowledge so Stripe stops retrying.
        console.error(
          JSON.stringify({ fn: "stripeWebhook", type: event.type, sub: subId, skipped: "no_hotel_metadata" }),
        );
        return NextResponse.json({ received: true, skipped: "no_hotel_metadata" });
      }
      const saved = await persistSubscription(admin, row);
      if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 500 });
      return NextResponse.json({ received: true, hotel_id: row.hotel_id, status: row.status });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      // A session can complete before its subscription events land; recording
      // the redemption here is what makes the code report accurate even if the
      // owner never returns to the app.
      if (session.metadata?.signup_code_id && session.metadata?.hotel_id) {
        const { error } = await admin.from("signup_code_redemptions").insert({
          code_id: session.metadata.signup_code_id,
          hotel_id: session.metadata.hotel_id,
          user_id: session.metadata.user_id || null,
          email: session.customer_details?.email ?? session.metadata.email ?? "unknown",
        });
        // A duplicate is the expected outcome of a redelivery, not a failure.
        if (error && error.code !== "23505") {
          console.error(JSON.stringify({ fn: "stripeWebhook", step: "redemption", error: error.message }));
        }
      }
      if (subId) {
        const fresh = await stripe.subscriptions.retrieve(subId);
        const row = projectSubscription(fresh);
        if (row) {
          const saved = await persistSubscription(admin, row);
          if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 500 });
        }
      }
      return NextResponse.json({ received: true });
    }

    if (event.type === "invoice.upcoming") {
      // The highest-leverage moment in the whole flow: a few days out from a
      // charge, before the money moves. A property that paid and never connected
      // its PMS gets one nudge here; a connected one gets nothing, because it is
      // already getting what it pays for.
      //
      // How many days ahead this fires is a Stripe dashboard setting
      // (Settings > Billing > Subscriptions), not something we control here.
      const inv = event.data.object as Stripe.Invoice;
      // The subscription reference lives under parent.subscription_details in
      // this API version, not on the invoice itself.
      const subRef = inv.parent?.subscription_details?.subscription ?? null;
      const subId = typeof subRef === "string" ? subRef : (subRef?.id ?? null);

      // The invoice's own metadata is empty for an upcoming preview, so the
      // hotel has to come off the subscription we already recorded.
      let hotelId: string | null = null;
      let billedRooms = 0;
      let interval: "month" | "year" = "month";
      if (subId) {
        const { data: sub } = await admin
          .from("hotel_subscriptions")
          .select("hotel_id, billed_rooms, billing_interval")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        if (sub) {
          hotelId = String(sub.hotel_id);
          billedRooms = Number(sub.billed_rooms ?? 0);
          interval = sub.billing_interval === "year" ? "year" : "month";
        }
      }

      const upcoming: UpcomingInvoice = {
        subscriptionId: subId,
        hotelId,
        amountDue: inv.amount_due ?? 0,
        currency: inv.currency ?? "usd",
        nextPaymentAttempt: inv.next_payment_attempt ?? null,
        periodEnd: inv.period_end ?? null,
        customerEmail: inv.customer_email ?? null,
        billingInterval: interval,
        roomCount: billedRooms,
        // No amount paid yet on this subscription means this is the first real
        // charge — usually a trial ending, which reads differently.
        isFirstCharge: (inv.amount_paid ?? 0) === 0 && (inv.attempt_count ?? 0) === 0,
      };

      const decision = await decideNudge(admin, upcoming);
      if (!decision.send) {
        return NextResponse.json({ received: true, nudge: "skipped", reason: decision.reason });
      }

      const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "");
      if (!base) {
        // Without a base URL the mail would carry a dead link, which is worse
        // than not sending — the whole point is a door back in.
        console.error(JSON.stringify({ fn: "stripeWebhook", nudge: "no_base_url" }));
        return NextResponse.json({ received: true, nudge: "skipped", reason: "no_base_url" });
      }

      // /onboarding rather than /onboarding/connect: the connect page guards
      // itself and redirects anyone it doesn't consider mid-connect, so a deep
      // link from an email can bounce. /onboarding is the router — it resolves
      // whichever step this owner is actually on, and cannot turn them away.
      const sent = await sendRenewalNudge(upcoming, decision.to, `${base}/onboarding`);
      if (!sent.ok) {
        // Acknowledge anyway: Stripe retrying this event would not fix a mail
        // provider problem, and the charge should not be held up by an email.
        console.error(JSON.stringify({ fn: "stripeWebhook", nudge: "send_failed", error: sent.error }));
        return NextResponse.json({ received: true, nudge: "failed" });
      }
      return NextResponse.json({ received: true, nudge: "sent", hotel_id: decision.hotelId });
    }

    // Payment outcomes are already reflected in the subscription's own status,
    // which the events above carry — nothing extra to store for them.
    return NextResponse.json({ received: true, ignored: event.type });
  } catch (e) {
    // A Stripe read or a database write failed. 500 so Stripe retries, since
    // this class of failure is usually transient.
    const message = e instanceof Error ? e.message : "Webhook handling failed";
    console.error(JSON.stringify({ fn: "stripeWebhook", type: event.type, error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
