import { requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { isStripeConfigured, stripeClient } from "@/lib/billing/stripe";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * POST /api/billing/portal — a one-time link into Stripe's customer portal.
 *
 * Updating a card, downloading receipts, and cancelling all happen there rather
 * than here. That is deliberate: each of those is a place to leak card data or
 * get a refund wrong, and Stripe already has a hosted, PCI-compliant, localised
 * screen for every one of them. Building our own would be more code and a worse
 * outcome.
 *
 * The session is created against the customer id we hold for THIS hotel, so the
 * caller can only ever reach their own billing — the id never comes from them.
 * The return URL comes from configuration for the same reason it does in
 * lib/pms/registry.ts: a Host header is attacker-controlled and this one becomes
 * a link Stripe sends the customer to.
 */
export async function POST() {
  // General Manager and up: the same bar as taking pricing live and holding the
  // PMS connection (see canManageFinances in lib/roles.ts).
  const ctx = await requireSupabaseHotelRank(await cookies(), "general_manager");
  if (!ctx.ok) return ctx.response;

  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing is not configured on this deployment." }, { status: 503 });
  }

  const { data: sub } = await ctx.supabase
    .from("hotel_subscriptions")
    .select("stripe_customer_id")
    .eq("hotel_id", ctx.hotelId)
    .maybeSingle();

  if (!sub?.stripe_customer_id) {
    return NextResponse.json(
      { error: "This property has no billing account — it was not set up through checkout." },
      { status: 404 },
    );
  }

  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/+$/, "");
  if (!base) {
    return NextResponse.json(
      { error: "Billing is not fully configured on this deployment." },
      { status: 503 },
    );
  }

  try {
    const session = await stripeClient().billingPortal.sessions.create({
      customer: String(sub.stripe_customer_id),
      return_url: `${base}/account/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open the billing portal.";
    console.error(JSON.stringify({ fn: "billingPortal", hotel: ctx.hotelId, error: message }));
    // Stripe's message here is usually "configure the portal in the dashboard",
    // which is the operator's problem and not something to show a hotel owner.
    return NextResponse.json({ error: "Could not open the billing portal. Try again shortly." }, { status: 502 });
  }
}
