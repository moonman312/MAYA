import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { persistSubscription, projectSubscription } from "./sync";

/**
 * Stamp hotel_subscriptions.first_paid_at from a paid invoice.
 *
 * The row only ever holds a subscription's current status, and 'canceled'
 * reads the same for a two-year customer as for a trial that never converted.
 * The never-paid retention sweep deletes imported history for the second kind
 * and must never do it to the first, so the moment money first moved is kept
 * here, once, and nothing later moves it (a trigger in
 * 99_supabase_migration_first_paid_at_v1.sql holds it).
 *
 * Only a paid invoice that charged something counts. A trial's first invoice
 * and a 100%-off code both come through invoice.payment_succeeded at zero.
 *
 * The column is per property, not per subscription: the row is reused when a
 * hotel re-subscribes, and an invoice for a subscription since replaced still
 * proves the hotel paid. Never throws; the webhook's other work does not wait
 * on this.
 */

export type FirstPaidResult =
  | { stamped: true; hotelId: string }
  | {
      stamped: false;
      reason: "not_charged" | "no_subscription" | "no_hotel" | "already_stamped" | "column_missing" | "error";
      message?: string;
    };

export async function recordFirstPayment(
  admin: SupabaseClient,
  stripe: Stripe,
  inv: Stripe.Invoice,
): Promise<FirstPaidResult> {
  try {
    if (inv.status !== "paid" || !(Number(inv.amount_paid) > 0)) {
      return { stamped: false, reason: "not_charged" };
    }
    const details = inv.parent?.subscription_details ?? null;
    const subRef = details?.subscription ?? null;
    const subId = typeof subRef === "string" ? subRef : (subRef?.id ?? null);
    if (!subId) return { stamped: false, reason: "no_subscription" };

    const paidAt = new Date(((inv.status_transitions?.paid_at ?? inv.created) || 0) * 1000).toISOString();

    // Which property: the recorded row for this subscription, else the hotel
    // the subscription was sold for, as Stripe snapshotted it on the invoice.
    let hotelId: string | null = null;
    const { data: row, error: rowErr } = await admin
      .from("hotel_subscriptions")
      .select("hotel_id")
      .eq("stripe_subscription_id", subId)
      .maybeSingle();
    if (rowErr) return { stamped: false, reason: "error", message: rowErr.message };
    if (row?.hotel_id) hotelId = String(row.hotel_id);
    hotelId ??= details?.metadata?.hotel_id || null;

    let stamp = await stampOnce(admin, hotelId, paidAt);
    if (stamp === "no_row") {
      // The invoice beat the subscription events here. Record the subscription
      // the same way they would, then stamp; a subscription created outside
      // our checkout has no hotel and is left alone.
      const sub = await stripe.subscriptions.retrieve(subId);
      const projection = projectSubscription(sub);
      if (!projection) return { stamped: false, reason: "no_hotel" };
      hotelId = projection.hotel_id;
      const saved = await persistSubscription(admin, projection);
      if (!saved.ok) return { stamped: false, reason: "error", message: saved.error };
      stamp = await stampOnce(admin, hotelId, paidAt);
    }

    if (stamp === "stamped") return { stamped: true, hotelId: hotelId! };
    if (stamp === "already") return { stamped: false, reason: "already_stamped" };
    if (stamp === "column_missing") {
      console.warn(
        JSON.stringify({
          fn: "recordFirstPayment",
          warning: "hotel_subscriptions.first_paid_at is missing; run 99_supabase_migration_first_paid_at_v1.sql",
        }),
      );
      return { stamped: false, reason: "column_missing" };
    }
    if (stamp === "no_row") return { stamped: false, reason: "no_hotel" };
    return { stamped: false, reason: "error", message: stamp.error };
  } catch (e) {
    return { stamped: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

type StampOutcome = "stamped" | "already" | "no_row" | "column_missing" | { error: string };

async function stampOnce(admin: SupabaseClient, hotelId: string | null, paidAt: string): Promise<StampOutcome> {
  if (!hotelId) return "no_row";
  const { data, error } = await admin
    .from("hotel_subscriptions")
    .update({ first_paid_at: paidAt })
    .eq("hotel_id", hotelId)
    .is("first_paid_at", null)
    .select("hotel_id");
  if (error) {
    if (error.code === "42703" || /first_paid_at/.test(error.message)) return "column_missing";
    return { error: error.message };
  }
  if ((data ?? []).length > 0) return "stamped";
  const { data: existing, error: readErr } = await admin
    .from("hotel_subscriptions")
    .select("hotel_id")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (readErr) return { error: readErr.message };
  return existing ? "already" : "no_row";
}
