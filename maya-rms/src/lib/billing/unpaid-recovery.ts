/**
 * Pay what an unpaid subscription owes, the moment its owner puts a new card on.
 *
 * Once Stripe's retries run out a subscription goes 'unpaid' and stays there:
 * Stripe keeps the failed invoice open but never tries it again, so an owner who
 * did exactly what the billing page asked (update the card) was left paused
 * until someone paid the invoice by hand. This closes that gap.
 *
 * The trigger is customer.updated with the customer's default card changed,
 * which is what saving a new card as the default in the billing portal sends.
 * Not payment_method.attached: a card can be attached without being chosen, and
 * paying with a card the owner only added as a spare would be a surprise. Not
 * setup_intent.succeeded either: the card re-check (reverify.ts) confirms its
 * own SetupIntents against the OLD card, and those must never pay anything.
 *
 * Narrow on purpose: only this customer's subscriptions in status 'unpaid',
 * only ones our checkout made (hotel_id in metadata), only the one each hotel
 * is on today (hotel_subscriptions says which), only their 'open' invoices,
 * oldest first, and always with the card that is the customer's default right
 * now, read back from Stripe rather than off the event.
 *
 * The hotel check matters because one customer can hold an unpaid
 * subscription that a newer checkout has since replaced. Paying that one
 * would revive it beside the subscription the property pays for now, and bill
 * the property twice.
 *
 * A decline is an answer, not a failure: it is logged and the webhook still
 * acknowledges, because Stripe redelivering the event would only ask the same
 * bank the same question. Only a failure a retry could fix (Stripe unreachable,
 * rate limited) is thrown, so the route answers 500 and Stripe tries again; the
 * idempotency keys below make that retry safe.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

type StripeErrorish = {
  type?: string;
  rawType?: string;
  code?: string;
  decline_code?: string;
  message?: string;
};

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : (v?.id ?? null);

/** The most specific thing Stripe told us about a failure. */
function codeOf(err: StripeErrorish): string {
  return err.decline_code || err.code || err.type || "stripe_error";
}

/**
 * Did this customer.updated change the default card? previous_attributes only
 * lists what changed, so the key being there at all is the answer, even when
 * its old value was null (no default card before).
 */
export function defaultCardChanged(previous: unknown): boolean {
  if (!previous || typeof previous !== "object") return false;
  const settings = (previous as { invoice_settings?: unknown }).invoice_settings;
  return Boolean(settings && typeof settings === "object" && "default_payment_method" in settings);
}

export type InvoiceAttempt = {
  subscription: string;
  hotel: string;
  invoice: string;
  /** paid; declined by the bank; or refused by Stripe for the invoice itself. */
  outcome: "paid" | "declined" | "refused";
  code?: string;
};

export type RecoveryResult =
  | { attempted: false; reason: "customer_deleted" | "no_card" | "nothing_unpaid" }
  /** Every unpaid subscription was one its hotel has since moved off. */
  | { attempted: false; reason: "superseded"; superseded: string[] }
  | {
      attempted: true;
      card: string;
      attempts: InvoiceAttempt[];
      /** Unpaid subscriptions that had no open invoice to pay. */
      noOpenInvoice: string[];
      /** Subscriptions moved onto the new card after it paid. */
      moved: string[];
      /** Unpaid subscriptions left alone because their hotel is on another one now. */
      superseded: string[];
    };

export async function payUnpaidAfterCardUpdate(
  admin: SupabaseClient,
  stripe: Stripe,
  customerId: string,
): Promise<RecoveryResult> {
  const customer = await stripe.customers.retrieve(customerId);
  if ("deleted" in customer && customer.deleted) return { attempted: false, reason: "customer_deleted" };

  // The default as it stands now. Two quick card changes can arrive in either
  // order; reading it back means both deliveries use the card the owner ended on.
  const card = idOf(customer.invoice_settings?.default_payment_method ?? null);
  if (!card) return { attempted: false, reason: "no_card" };

  const listed = await stripe.subscriptions.list({ customer: customerId, status: "unpaid", limit: 100 });
  // A subscription made by hand in the dashboard carries no hotel and is not ours to collect.
  const listedUnpaid = listed.data.filter((s) => s.status === "unpaid" && s.metadata?.hotel_id);
  if (listedUnpaid.length === 0) return { attempted: false, reason: "nothing_unpaid" };

  const unpaid: Stripe.Subscription[] = [];
  const superseded: string[] = [];
  for (const sub of listedUnpaid) {
    const hotel = String(sub.metadata.hotel_id);
    const recorded = await recordedSubscription(admin, hotel);
    if (recorded === sub.id) {
      unpaid.push(sub);
      continue;
    }
    superseded.push(sub.id);
    console.error(
      JSON.stringify({
        fn: "unpaidRecovery",
        customer: customerId,
        sub: sub.id,
        hotel,
        recorded,
        action: "stale_unpaid_not_revived",
      }),
    );
  }
  if (unpaid.length === 0) return { attempted: false, reason: "superseded", superseded };

  const attempts: InvoiceAttempt[] = [];
  const noOpenInvoice: string[] = [];
  const moved: string[] = [];

  for (const sub of unpaid) {
    const hotel = String(sub.metadata.hotel_id);
    const open = await stripe.invoices.list({ subscription: sub.id, status: "open", limit: 100 });
    const invoices = open.data.filter((inv) => inv.status === "open").sort((a, b) => a.created - b.created);
    if (invoices.length === 0) {
      noOpenInvoice.push(sub.id);
      continue;
    }

    let allPaid = true;
    for (const inv of invoices) {
      const attempt = await payOne(stripe, inv, card);
      attempts.push({ subscription: sub.id, hotel, invoice: inv.id, ...attempt });
      if (attempt.outcome !== "paid") {
        // The next invoice would go to the same card and the same bank. One
        // refusal is the answer for this subscription until the card changes.
        allPaid = false;
        break;
      }
    }

    if (allPaid && (await moveOntoCard(stripe, sub, card))) moved.push(sub.id);
  }

  for (const a of attempts) {
    if (a.outcome === "paid") continue;
    console.error(
      JSON.stringify({ fn: "unpaidRecovery", customer: customerId, ...a, action: "still_unpaid_owner_needs_another_card" }),
    );
  }
  if (noOpenInvoice.length > 0) {
    // Unpaid with nothing open means the failed invoice was voided or marked
    // uncollectible in Stripe. Paying those is a person's call, not ours.
    console.error(JSON.stringify({ fn: "unpaidRecovery", customer: customerId, noOpenInvoice }));
  }
  console.log(
    JSON.stringify({
      fn: "unpaidRecovery",
      customer: customerId,
      subscriptions: unpaid.length,
      paid: attempts.filter((a) => a.outcome === "paid").length,
      notPaid: attempts.filter((a) => a.outcome !== "paid").length,
      moved: moved.length,
      superseded: superseded.length,
    }),
  );

  return { attempted: true, card, attempts, noOpenInvoice, moved, superseded };
}

/**
 * The subscription the hotel's row points at, or null when it has none. A
 * failed read throws: the webhook answers 500 and Stripe redelivers, which is
 * better than guessing either way about someone's money.
 */
async function recordedSubscription(admin: SupabaseClient, hotelId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("hotel_subscriptions")
    .select("stripe_subscription_id")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the subscription for ${hotelId}: ${error.message}`);
  return data?.stripe_subscription_id ? String(data.stripe_subscription_id) : null;
}

async function payOne(
  stripe: Stripe,
  inv: Stripe.Invoice,
  card: string,
): Promise<{ outcome: InvoiceAttempt["outcome"]; code?: string }> {
  try {
    const paid = await stripe.invoices.pay(
      inv.id,
      // Named explicitly: the subscription can still point at the card that
      // failed, and that card would be the one charged otherwise.
      { payment_method: card, off_session: true },
      // Keyed on invoice and card, not on the event. A redelivery, or a second
      // event for the same card, gets Stripe's first answer back instead of a
      // second charge attempt; a different card is a genuinely new question.
      { idempotencyKey: `maya_unpaid_pay_${inv.id}_${card}` },
    );
    return paid.status === "paid" ? { outcome: "paid" } : { outcome: "declined", code: String(paid.status) };
  } catch (e) {
    const err = e as StripeErrorish;
    // Declined, or the bank wants the cardholder present. Either way the answer
    // for this card, and asking again would get the same one.
    if (err.type === "StripeCardError" || err.rawType === "card_error") {
      return { outcome: "declined", code: codeOf(err) };
    }
    // Stripe refusing this invoice: already paid in the meantime, no longer
    // open, a card it will not use. A retry fails the same way.
    if (
      err.type === "StripeInvalidRequestError" ||
      err.rawType === "invalid_request_error" ||
      err.type === "StripeIdempotencyError"
    ) {
      return { outcome: "refused", code: codeOf(err) };
    }
    // Unreachable, rate limited, a Stripe outage: worth a redelivery.
    throw e;
  }
}

/**
 * A subscription's own card outranks the customer's default, and checkout sets
 * one. Left alone, the subscription would restart on the new card today and go
 * back to the old one at the next renewal, so the card that just paid becomes
 * the subscription's card too. Never throws: the payment already went through,
 * and a redelivery would find nothing unpaid to come back for.
 */
async function moveOntoCard(stripe: Stripe, sub: Stripe.Subscription, card: string): Promise<boolean> {
  const current = idOf(sub.default_payment_method);
  if (!current || current === card) return false;
  try {
    await stripe.subscriptions.update(
      sub.id,
      { default_payment_method: card },
      { idempotencyKey: `maya_unpaid_card_${sub.id}_${card}` },
    );
    return true;
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "unpaidRecovery",
        step: "move_card",
        sub: sub.id,
        error: e instanceof Error ? e.message : String(e),
        action: "move_subscription_to_new_card_by_hand",
      }),
    );
    return false;
  }
}
