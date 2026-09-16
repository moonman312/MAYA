import { requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { isStripeConfigured, stripeClient } from "@/lib/billing/stripe";
import { roleRank } from "@/lib/roles";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type Stripe from "stripe";

/**
 * POST /api/billing/portal — a one-time link into Stripe's customer portal.
 *
 * Updating a card, downloading receipts, and cancelling all happen there rather
 * than here. That is deliberate: each of those is a place to leak card data or
 * get a refund wrong, and Stripe already has a hosted, PCI-compliant, localised
 * screen for every one of them. Building our own would be more code and a worse
 * outcome.
 *
 * The session is created against the customer id we hold for THIS hotel — the
 * id never comes from the caller. That customer is not always this hotel's
 * alone, though: a Marketplace group is billed on its owner's one customer
 * (see checkout/route.ts), so a General Manager of one property would find the
 * whole group's subscriptions in a full portal. When the customer also bills a
 * property the caller cannot manage, the session is narrowed to this hotel's
 * subscription (a flow, not the portal home) and returns here when done. If
 * Stripe refuses the narrowing, the answer is no portal at all — never the
 * full one, which is exactly the screen the narrowing exists to keep shut.
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
    .select("stripe_customer_id, stripe_subscription_id")
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

  const customer = String(sub.stripe_customer_id);
  const return_url = `${base}/account/billing`;

  const stripe = stripeClient();
  let flow: Stripe.BillingPortal.SessionCreateParams.FlowData | null = null;
  try {
    const shared = await billsAPropertyOutsideCallerReach(ctx.supabase, customer, ctx.hotelId);
    if (shared) flow = scopedFlow(sub.stripe_subscription_id, return_url);
    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url,
      ...(flow ? { flow_data: flow } : {}),
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open the billing portal.";

    // A flow is only accepted while its feature is switched on in the portal
    // configuration, and that switch is a dashboard toggle no code here can
    // flip. The flow is only ever set because the caller is below General
    // Manager on a sibling this customer bills, so retrying without it would
    // hand them that sibling's subscription and card. The request fails
    // instead, and the log says exactly which toggle is off, since that is
    // the only fix.
    if (flow && isFlowRefused(error, flow.type)) {
      console.error(
        JSON.stringify({
          fn: "billingPortal",
          hotel: ctx.hotelId,
          refused: "portal_flow_disabled",
          flow: flow.type,
          fix: `Enable "${FEATURE_TOGGLE[flow.type] ?? flow.type}" under Settings -> Billing -> Customer portal in the Stripe dashboard (per mode: test and live are separate)`,
          consequence: "no portal for this caller until then; the full portal would list this customer's other properties",
          error: message,
        }),
      );
      return NextResponse.json(
        { error: "Billing for a shared group is still being set up. Ask the account owner, or try again later." },
        { status: 502 },
      );
    }

    console.error(
      JSON.stringify({
        fn: "billingPortal",
        hotel: ctx.hotelId,
        error: message,
        // The other operator-side failure: no portal configuration at all in
        // this mode. Stripe only makes the default one when the settings page
        // is saved once, and a fresh sandbox (or live account) has none.
        ...(/configuration/i.test(message)
          ? { fix: "Save the Customer portal settings once in the Stripe dashboard (Settings -> Billing -> Customer portal) for this mode" }
          : {}),
      }),
    );
    // Stripe's message here is usually "configure the portal in the dashboard",
    // which is the operator's problem and not something to show a hotel owner.
    return NextResponse.json({ error: "Could not open the billing portal. Try again shortly." }, { status: 502 });
  }
}

/** The dashboard's name for each flow's switch, for the log line. */
const FEATURE_TOGGLE: Record<string, string> = {
  subscription_update: "Subscriptions -> Customers can switch plans / update quantities (features.subscription_update)",
  subscription_update_confirm: "Subscriptions -> Customers can switch plans (features.subscription_update)",
  subscription_cancel: "Subscriptions -> Customers can cancel subscriptions (features.subscription_cancel)",
  payment_method_update: "Payment methods -> Customers can update their payment methods (features.payment_method_update)",
};

/**
 * Did Stripe refuse the portal session BECAUSE of the flow, rather than for
 * some other reason (bad key, unknown customer, no portal configuration at
 * all)? The docs don't publish the message text, so this keys on what the SDK
 * types promise: an invalid_request_error (Stripe.errors.StripeError.rawType)
 * whose `param` points into flow_data, or whose message names flow_data or the
 * flow's type. Anything else is not the flow's fault and a retry without it
 * would fail the same way.
 */
function isFlowRefused(error: unknown, flowType: string): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { type?: unknown; rawType?: unknown; param?: unknown; message?: unknown };
  const invalidRequest = e.rawType === "invalid_request_error" || e.type === "StripeInvalidRequestError";
  if (!invalidRequest) return false;
  if (typeof e.param === "string" && e.param.startsWith("flow_data")) return true;
  const message = typeof e.message === "string" ? e.message : "";
  return message.includes("flow_data") || message.includes(flowType);
}

/**
 * Does this Stripe customer bill any other property on which the caller is
 * below General Manager? Read on the service role: the sibling rows belong to
 * hotels the caller may have no membership on, which is the very thing being
 * checked. Unknown (no service role, a failed read) counts as shared — the
 * narrower session is the safe answer.
 */
async function billsAPropertyOutsideCallerReach(
  supabase: SupabaseClient,
  customerId: string,
  hotelId: string,
): Promise<boolean> {
  if (!isAdminConfigured()) return true;
  const admin = createAdminClient();

  const { data: siblings, error } = await admin
    .from("hotel_subscriptions")
    .select("hotel_id")
    .eq("stripe_customer_id", customerId)
    .neq("hotel_id", hotelId);
  if (error) return true;
  const siblingIds = (siblings ?? []).map((r) => String(r.hotel_id));
  if (siblingIds.length === 0) return false;

  // Cookie read only; requireSupabaseHotelRank already ran getUser().
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return true;

  const { data: memberships, error: mErr } = await admin
    .from("hotel_memberships")
    .select("hotel_id, role")
    .eq("user_id", userId)
    .eq("status", "active")
    .in("hotel_id", siblingIds);
  if (mErr) return true;

  const bestRank = new Map<string, number>();
  for (const m of memberships ?? []) {
    const id = String(m.hotel_id);
    bestRank.set(id, Math.max(bestRank.get(id) ?? -1, roleRank(String(m.role))));
  }
  const floor = roleRank("general_manager");
  return siblingIds.some((id) => (bestRank.get(id) ?? -1) < floor);
}

/**
 * The portal narrowed to this hotel: its subscription when we hold one, else
 * the card on file. after_completion is set explicitly because Stripe's
 * default sends a finished flow to the portal home — the screen being kept
 * out of reach here.
 */
function scopedFlow(
  subscriptionId: unknown,
  return_url: string,
): Stripe.BillingPortal.SessionCreateParams.FlowData {
  const after_completion = { type: "redirect" as const, redirect: { return_url } };
  return subscriptionId
    ? {
        type: "subscription_update",
        subscription_update: { subscription: String(subscriptionId) },
        after_completion,
      }
    : { type: "payment_method_update", after_completion };
}
