/**
 * Projects a Stripe subscription into hotel_subscriptions.
 *
 * Everything here writes with the service-role client: the billing tables
 * revoke writes from `authenticated` on purpose, so the only path that can
 * change what a hotel owes is a signature-verified webhook.
 *
 * Callers pass a subscription they have just RE-FETCHED from Stripe rather than
 * the object embedded in the event. Webhooks arrive out of order and more than
 * once — a `customer.subscription.updated` can land before the `created` that
 * precedes it — so trusting event payloads means occasionally persisting an
 * older state on top of a newer one. Re-fetching makes delivery order and
 * duplicate delivery both irrelevant, which is cheaper than a version column
 * and impossible to get subtly wrong.
 */

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingInterval } from "./tiers";

/** How long after signup the card is checked a second time (Jake's call). */
export const CARD_REVERIFY_AFTER_HOURS = 48;

export type SubscriptionProjection = {
  hotel_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  status: string;
  billing_interval: BillingInterval;
  billed_rooms: number;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  card_verify_due_at: string | null;
  signup_code_id: string | null;
};

const iso = (unixSeconds: number | null | undefined): string | null =>
  unixSeconds == null ? null : new Date(unixSeconds * 1000).toISOString();

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : (v?.id ?? null);

/**
 * Turn a Stripe subscription into a row. Returns null when the subscription
 * carries no hotel — a subscription created outside our checkout (by hand in
 * the dashboard, say) has nothing to attach to and must not guess.
 */
export function projectSubscription(sub: Stripe.Subscription): SubscriptionProjection | null {
  const hotelId = sub.metadata?.hotel_id;
  if (!hotelId) return null;

  const item = sub.items?.data?.[0];
  if (!item) return null;

  // Stripe types this as a branded string, so compare then re-state the type
  // rather than relying on narrowing that doesn't happen.
  const rawInterval = String(item.price?.recurring?.interval ?? "");
  if (rawInterval !== "month" && rawInterval !== "year") return null;
  const interval: BillingInterval = rawInterval;

  const customerId = idOf(sub.customer);
  if (!customerId) return null;

  // current_period_end moved onto the item in recent API versions; read the
  // item first and fall back so this keeps working across a version bump.
  const itemPeriodEnd = (item as { current_period_end?: number }).current_period_end;
  const subPeriodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;

  return {
    hotel_id: hotelId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    billing_interval: interval,
    billed_rooms: item.quantity ?? 0,
    current_period_end: iso(itemPeriodEnd ?? subPeriodEnd),
    trial_end: iso(sub.trial_end),
    cancel_at_period_end: sub.cancel_at_period_end === true,
    // Due immediately, not in 48 hours: the card gets checked twice. Now, to
    // catch one that was never good, and again at signup + 48h, to catch a
    // virtual card cancelled after the fact — which is the only reason to wait
    // at all. patchFor moves this deadline to +48h once the first check passes,
    // and trg_hotel_subscriptions_reset_card_verify stops a later webhook
    // dragging it back here. Anchored on the subscription's own creation so a
    // replayed webhook can't keep pushing the first check forward.
    card_verify_due_at: iso(sub.created),
    signup_code_id: sub.metadata?.signup_code_id || null,
  };
}

/**
 * Write the projection. `billed_rooms` of 0 would be a nonsense charge and the
 * column rejects it, so a subscription whose item lost its quantity is dropped
 * here with a log rather than failing the whole webhook and making Stripe retry
 * something that will never succeed.
 */
export async function persistSubscription(
  admin: SupabaseClient,
  row: SubscriptionProjection,
): Promise<{ ok: boolean; error?: string }> {
  if (row.billed_rooms < 1) {
    console.error(
      JSON.stringify({ fn: "persistSubscription", reason: "non_billable_quantity", sub: row.stripe_subscription_id }),
    );
    return { ok: true };
  }

  const { error } = await admin
    .from("hotel_subscriptions")
    .upsert(row, { onConflict: "hotel_id" });
  if (error) {
    console.error(
      JSON.stringify({ fn: "persistSubscription", sub: row.stripe_subscription_id, error: error.message }),
    );
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Kept as a named re-export because most of the app reads it from here. The one
 * definition lives in _shared/billing/entitlement.ts so the Deno cron that stops
 * doing the work and the pages that explain why cannot disagree about who has
 * paid.
 */
export { isEntitledStatus as isEntitled } from "./entitlement";
