/**
 * Follow the owner to their new default card.
 *
 * Checkout puts the card on the subscription itself, and a subscription's own
 * card outranks the customer's default. So an owner who saved a new default
 * card in the billing portal, as the overdue banner asks, could watch Stripe
 * keep retrying the old card until the subscription went unpaid. Once unpaid,
 * Stripe stops trying altogether and leaves the failed invoice open.
 *
 * What happens when the default card changes (Jake's call, A35):
 *
 * - A subscription on the OLD default card moves to the new one. When the
 *   customer had no default before (Checkout never sets one, so the first card
 *   saved in the portal is a change from none), the old card is inferred only
 *   when EVERY billing subscription of this customer carries the same card:
 *   that is the card they were in fact paying with. One with no card, one on
 *   another card, or one already on the new card (unless MAYA itself moved it
 *   there for this same change) makes it unknowable, and nothing is moved.
 * - A subscription with no card of its own already uses the default. Nothing
 *   to move.
 * - A subscription on a DIFFERENT card of its own is never touched: a group
 *   property can sit on its own card on purpose, including the new card. When
 *   there was no default and the subscriptions do not all share one card,
 *   every subscription with its own card is left alone and logged.
 * - Then each moved or following subscription that is overdue (past_due or
 *   unpaid) has its open invoices paid with the new card at once, oldest
 *   first, the way G22 already paid an unpaid one.
 *
 * The trigger is customer.updated with the default card changed, which is
 * what saving a new card as the default in the billing portal sends. Not
 * payment_method.attached: a card can be attached without being chosen, and
 * paying with a card the owner only added as a spare would be a surprise. Not
 * setup_intent.succeeded either: the card re-check (reverify.ts) confirms its
 * own SetupIntents against the OLD card, and those must never move anything.
 *
 * Narrow on purpose: only this customer's subscriptions that still bill
 * (active, trialing, past_due, unpaid), only ones our checkout made (hotel_id
 * in metadata), only the one each hotel is on today (hotel_subscriptions says
 * which), and always the card that is the customer's default right now, read
 * back from Stripe rather than off the event. One customer can hold an old
 * subscription a newer checkout has since replaced; paying or moving that one
 * would revive it beside the one the property pays for now.
 *
 * Safe on redelivery. A subscription already on the new card is skipped, and
 * the payment is keyed on invoice and card, so a second delivery gets Stripe's
 * first answer instead of a second charge attempt. Each move is stamped on
 * the subscription (metadata maya_card_moved_from and maya_card_moved_event),
 * so a redelivery after a partial run still counts a subscription MAYA moved
 * as being on the old card, and reaches the same old card as the first run. A decline is an answer,
 * not a failure: it is logged and the webhook still acknowledges. Only a
 * failure a retry could fix (Stripe unreachable, rate limited, our database)
 * is thrown, so the route answers 500 and Stripe tries again.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { HOUR_MS, recordBillingProblem } from "./problems";

type StripeErrorish = {
  type?: string;
  rawType?: string;
  code?: string;
  decline_code?: string;
  message?: string;
};

/** Subscriptions that still bill. A card change means nothing to the rest. */
const BILLING_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

/** Subscriptions with a failed invoice that the new card pays straight away. */
const OVERDUE_STATUSES = new Set(["past_due", "unpaid"]);

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : (v?.id ?? null);

/** The most specific thing Stripe told us about a failure. */
function codeOf(err: StripeErrorish): string {
  return err.decline_code || err.code || err.type || "stripe_error";
}

function isInvalidRequest(err: StripeErrorish): boolean {
  return (
    err.type === "StripeInvalidRequestError" ||
    err.rawType === "invalid_request_error" ||
    err.type === "StripeIdempotencyError"
  );
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

/**
 * The default card before this change, off the event. The event is the only
 * place the old value exists; the customer read back from Stripe has only
 * the new one. Null when there was none.
 */
export function previousDefaultCard(previous: unknown): string | null {
  if (!previous || typeof previous !== "object") return null;
  const settings = (previous as { invoice_settings?: unknown }).invoice_settings;
  if (!settings || typeof settings !== "object") return null;
  const value = (settings as { default_payment_method?: unknown }).default_payment_method;
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

/** Metadata keys a move leaves on the subscription, so a redelivery knows MAYA put it on the new card. */
export const MOVED_FROM_KEY = "maya_card_moved_from";
export const MOVED_EVENT_KEY = "maya_card_moved_event";

/** One billing subscription's card, as oldCardFor reads it. */
export type SubscriptionCard = {
  /** The subscription's own card, or null when it has none. */
  own: string | null;
  /**
   * The card MAYA moved it from for THIS change (its stamp names this event),
   * or null. Only a stamp of the same event counts: any other subscription on
   * the new card may sit there on purpose.
   */
  movedFrom?: string | null;
};

/** The card a subscription's stamp says MAYA moved it from for this event, or null. */
export function stampedMoveFrom(
  metadata: Record<string, string> | null | undefined,
  eventId: string | undefined,
): string | null {
  if (!eventId || !metadata) return null;
  const from = metadata[MOVED_FROM_KEY];
  return metadata[MOVED_EVENT_KEY] === eventId && typeof from === "string" && from ? from : null;
}

/**
 * Which card counts as "the old default card".
 *
 * The customer's default before the change, when it had one. Otherwise a card
 * is inferred only when every billing subscription carries that same card,
 * counting one MAYA already moved for this change (its stamp) as still on the
 * card it came from, so a redelivery reaches the same answer. A subscription
 * with no card, one on another card, or one on the new card by any other way
 * (a group property paid with that card on purpose, or the portal moving it)
 * makes it ambiguous: null, and nothing is moved.
 */
export function oldCardFor(
  previousDefault: string | null,
  subs: SubscriptionCard[],
  newCard: string,
): { card: string | null; ambiguous: boolean } {
  if (previousDefault) return { card: previousDefault, ambiguous: false };
  const cards = subs.map((s) => (s.own === newCard && s.movedFrom ? s.movedFrom : s.own));
  // Nothing of their own to move off: every one follows the default or is on the new card already.
  if (cards.every((c) => !c || c === newCard)) return { card: null, ambiguous: false };
  const first = cards[0];
  if (first && first !== newCard && cards.every((c) => c === first)) return { card: first, ambiguous: false };
  return { card: null, ambiguous: true };
}

/**
 * What a card change does to one subscription.
 * - move: it was on the old default card, so it goes to the new one.
 * - follows: no card of its own, so it already uses the default.
 * - already: it is on the new card.
 * - own_card: a different card of its own. Never touched.
 */
export type CardPlan = "move" | "follows" | "already" | "own_card";

export function planFor(own: string | null, newCard: string, oldCard: string | null): CardPlan {
  if (!own) return "follows";
  if (own === newCard) return "already";
  if (oldCard && own === oldCard) return "move";
  return "own_card";
}

export type InvoiceAttempt = {
  subscription: string;
  hotel: string;
  invoice: string;
  /**
   * paid; already_paid (Stripe refused because the invoice was paid in the
   * meantime, by Stripe's own retry or the portal's pay button); declined by
   * the bank; or refused by Stripe for the invoice itself (no longer open, a
   * card it will not use).
   */
  outcome: "paid" | "already_paid" | "declined" | "refused";
  code?: string;
};

export type CardChangeResult =
  | { acted: false; reason: "customer_deleted" | "no_card" | "no_subscriptions" }
  /** Every billing subscription was one its hotel has since moved off. */
  | { acted: false; reason: "superseded"; superseded: string[] }
  | {
      acted: true;
      /** The customer's default card now. */
      card: string;
      /** The card that counted as the old default, or null when there was none to go by. */
      oldCard: string | null;
      /** No default before, and the subscriptions were on different cards. */
      ambiguous: boolean;
      /** Subscriptions moved onto the new card. */
      moved: string[];
      /** Subscriptions on a different card of their own, left alone. */
      kept: string[];
      /** Subscriptions Stripe would not move (logged for a person to do by hand). */
      moveRefused: string[];
      attempts: InvoiceAttempt[];
      /** Overdue subscriptions that had no open invoice to pay. */
      noOpenInvoice: string[];
      /** Subscriptions left alone because their hotel is on another one now. */
      superseded: string[];
    };

export async function followNewDefaultCard(
  admin: SupabaseClient,
  stripe: Stripe,
  customerId: string,
  opts: { previousCard: string | null; eventId?: string },
): Promise<CardChangeResult> {
  const customer = await stripe.customers.retrieve(customerId);
  if ("deleted" in customer && customer.deleted) return { acted: false, reason: "customer_deleted" };

  // The default as it stands now. Two quick card changes can arrive in either
  // order; reading it back means both deliveries use the card the owner ended on.
  const card = idOf(customer.invoice_settings?.default_payment_method ?? null);
  if (!card) return { acted: false, reason: "no_card" };

  // No status filter: Stripe's default list is everything not cancelled, and
  // the statuses that still bill are picked out below.
  const listed = await stripe.subscriptions.list({ customer: customerId, limit: 100 });
  // A subscription made by hand in the dashboard carries no hotel and is not ours.
  const billing = listed.data.filter((s) => BILLING_STATUSES.has(s.status) && s.metadata?.hotel_id);
  if (listed.has_more) {
    console.error(JSON.stringify({ fn: "cardChange", customer: customerId, warn: "more_than_100_subscriptions" }));
  }
  if (billing.length === 0) return { acted: false, reason: "no_subscriptions" };

  const current: Stripe.Subscription[] = [];
  const superseded: string[] = [];
  for (const sub of billing) {
    const hotel = String(sub.metadata.hotel_id);
    const recorded = await recordedSubscription(admin, hotel);
    if (recorded === sub.id) {
      current.push(sub);
      continue;
    }
    superseded.push(sub.id);
    console.error(
      JSON.stringify({
        fn: "cardChange",
        customer: customerId,
        sub: sub.id,
        status: sub.status,
        hotel,
        recorded,
        action: "stale_subscription_not_touched",
      }),
    );
  }
  if (current.length === 0) return { acted: false, reason: "superseded", superseded };

  const old = oldCardFor(
    opts.previousCard,
    current.map((s) => ({ own: idOf(s.default_payment_method), movedFrom: stampedMoveFrom(s.metadata, opts.eventId) })),
    card,
  );

  const moved: string[] = [];
  const kept: string[] = [];
  const moveRefused: string[] = [];
  const attempts: InvoiceAttempt[] = [];
  const noOpenInvoice: string[] = [];

  for (const sub of current) {
    const hotel = String(sub.metadata.hotel_id);
    const own = idOf(sub.default_payment_method);
    const plan = planFor(own, card, old.card);

    if (plan === "own_card") {
      kept.push(sub.id);
      console.error(
        JSON.stringify({
          fn: "cardChange",
          customer: customerId,
          sub: sub.id,
          hotel,
          status: sub.status,
          action: old.ambiguous ? "old_card_unknown_left_alone" : "own_card_left_alone",
          // An overdue one keeps retrying its own card. Worth a person's look.
          ...(OVERDUE_STATUSES.has(sub.status) ? { overdue: true } : {}),
        }),
      );
      continue;
    }

    if (plan === "move") {
      const outcome = await moveOntoCard(stripe, sub.id, card, old.card, opts.eventId);
      if (outcome === "moved") moved.push(sub.id);
      else moveRefused.push(sub.id);
    }

    if (!OVERDUE_STATUSES.has(sub.status)) continue;

    const open = await stripe.invoices.list({ subscription: sub.id, status: "open", limit: 100 });
    const invoices = open.data.filter((inv) => inv.status === "open").sort((a, b) => a.created - b.created);
    if (invoices.length === 0) {
      noOpenInvoice.push(sub.id);
      continue;
    }
    for (const inv of invoices) {
      const attempt = await payOne(stripe, inv, card);
      attempts.push({ subscription: sub.id, hotel, invoice: inv.id, ...attempt });
      // The next invoice would go to the same card and the same bank. One
      // refusal is the answer for this subscription until the card changes.
      if (attempt.outcome !== "paid" && attempt.outcome !== "already_paid") break;
    }
  }

  for (const a of attempts) {
    if (a.outcome === "paid") continue;
    if (a.outcome === "already_paid") {
      // Stripe's own retry or the portal's pay button got there first. Nothing to do.
      console.log(JSON.stringify({ fn: "cardChange", customer: customerId, ...a, action: "invoice_already_paid" }));
      continue;
    }
    // Only a decline means the owner needs another card. A refusal is Stripe
    // saying no to the invoice itself, which a person looks at.
    console.error(
      JSON.stringify({
        fn: "cardChange",
        customer: customerId,
        ...a,
        action: a.outcome === "declined" ? "still_overdue_owner_needs_another_card" : "invoice_not_payable",
      }),
    );
  }
  if (noOpenInvoice.length > 0) {
    // Overdue with nothing open means the failed invoice was voided or marked
    // uncollectible in Stripe. Paying those is a person's call, not ours.
    console.error(JSON.stringify({ fn: "cardChange", customer: customerId, noOpenInvoice }));
  }
  await handToAPerson(admin, customerId, current, attempts, moveRefused, noOpenInvoice);
  console.log(
    JSON.stringify({
      fn: "cardChange",
      customer: customerId,
      subscriptions: current.length,
      oldCard: old.card ? "known" : old.ambiguous ? "ambiguous" : "none",
      moved: moved.length,
      kept: kept.length,
      moveRefused: moveRefused.length,
      paid: attempts.filter((a) => a.outcome === "paid").length,
      alreadyPaid: attempts.filter((a) => a.outcome === "already_paid").length,
      declined: attempts.filter((a) => a.outcome === "declined").length,
      refused: attempts.filter((a) => a.outcome === "refused").length,
      superseded: superseded.length,
    }),
  );

  return {
    acted: true,
    card,
    oldCard: old.card,
    ambiguous: old.ambiguous,
    moved,
    kept,
    moveRefused,
    attempts,
    noOpenInvoice,
    superseded,
  };
}

/**
 * What still needs a person after a card change goes to the alert channel
 * (problems.ts), one line per subscription: a new card declined on an overdue
 * subscription (the owner needs yet another card, and may not know), an
 * invoice Stripe would not take payment for, a subscription Stripe would not
 * move, or an overdue one with no open invoice. Never throws.
 */
async function handToAPerson(
  admin: SupabaseClient,
  customerId: string,
  current: Stripe.Subscription[],
  attempts: InvoiceAttempt[],
  moveRefused: string[],
  noOpenInvoice: string[],
): Promise<void> {
  const hotelOf = new Map(current.map((s) => [s.id, String(s.metadata.hotel_id)]));
  const statusOf = new Map(current.map((s) => [s.id, s.status]));
  const problems = new Map<string, { title: string; detail: string }>();
  for (const a of attempts) {
    if (a.outcome === "declined") {
      problems.set(a.subscription, {
        title: "A new card was declined on an overdue subscription",
        detail:
          `The owner saved a new default card and paying invoice ${a.invoice} with it was declined` +
          `${a.code ? ` (${a.code})` : ""}. Subscription ${a.subscription} is still ${statusOf.get(a.subscription)}; ` +
          "they need another card.",
      });
    } else if (a.outcome === "refused") {
      problems.set(a.subscription, {
        title: "Stripe would not take payment for an overdue invoice",
        detail:
          `Paying invoice ${a.invoice} of subscription ${a.subscription} with the owner's new card was refused by Stripe` +
          `${a.code ? ` (${a.code})` : ""}. Look at the invoice in Stripe.`,
      });
    }
  }
  for (const sub of moveRefused) {
    if (problems.has(sub)) continue;
    problems.set(sub, {
      title: "Stripe would not move a subscription onto the new card",
      detail: `The owner saved a new default card, and subscription ${sub} could not be moved onto it. Move it by hand in Stripe.`,
    });
  }
  for (const sub of noOpenInvoice) {
    if (problems.has(sub)) continue;
    problems.set(sub, {
      title: "An overdue subscription has no open invoice to pay",
      detail:
        `Subscription ${sub} is ${statusOf.get(sub)} with no open invoice (voided or marked uncollectible in Stripe), ` +
        "so the owner's new card paid nothing. Whether to restart it is a person's call.",
    });
  }
  for (const [sub, p] of problems) {
    await recordBillingProblem(
      admin,
      { key: `billing-card-change:${sub}`, hotelId: hotelOf.get(sub) ?? null, title: p.title, detail: `${p.detail} Customer ${customerId}.` },
      { quietForMs: 6 * HOUR_MS },
    );
  }
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

/**
 * Put the subscription's own card on the new default, and stamp the move on
 * it (which card it came from, for which event), so a redelivery after a
 * partial run still knows this subscription was on the old card. Keyed on the
 * event as well as the card: a key of subscription and card alone would,
 * inside Stripe's 24 hours, replay a first move after the owner switched away
 * and back, and leave the subscription where it was.
 */
async function moveOntoCard(
  stripe: Stripe,
  subId: string,
  card: string,
  fromCard: string | null,
  eventId: string | undefined,
): Promise<"moved" | "refused"> {
  try {
    await stripe.subscriptions.update(
      subId,
      {
        default_payment_method: card,
        // Stripe merges metadata keys, so hotel_id and the rest stay.
        metadata: { [MOVED_FROM_KEY]: fromCard ?? "", [MOVED_EVENT_KEY]: eventId ?? "" },
      },
      eventId ? { idempotencyKey: `maya_card_move_${eventId}_${subId}_${card}` } : undefined,
    );
    return "moved";
  } catch (e) {
    const err = e as StripeErrorish;
    // Stripe refusing this move (the card cannot be used for it, say). A
    // retry gets the same answer, so a person does it.
    if (isInvalidRequest(err)) {
      console.error(
        JSON.stringify({
          fn: "cardChange",
          step: "move_card",
          sub: subId,
          code: codeOf(err),
          action: "move_subscription_to_new_card_by_hand",
        }),
      );
      return "refused";
    }
    // Unreachable, rate limited: worth a redelivery, which finds it still on
    // the old card and tries again.
    throw e;
  }
}

async function payOne(
  stripe: Stripe,
  inv: Stripe.Invoice,
  card: string,
): Promise<{ outcome: InvoiceAttempt["outcome"]; code?: string }> {
  try {
    const paid = await stripe.invoices.pay(
      inv.id,
      // Named explicitly: a subscription left on its own card would charge
      // that card otherwise.
      { payment_method: card, off_session: true },
      // Keyed on invoice and card, not on the event. A redelivery, or a second
      // event for the same card, gets Stripe's first answer back instead of a
      // second charge attempt; a different card is a genuinely new question.
      { idempotencyKey: `maya_overdue_pay_${inv.id}_${card}` },
    );
    return paid.status === "paid" ? { outcome: "paid" } : { outcome: "declined", code: String(paid.status) };
  } catch (e) {
    const err = e as StripeErrorish;
    // Declined, or the bank wants the cardholder present. Either way the answer
    // for this card, and asking again would get the same one.
    if (err.type === "StripeCardError" || err.rawType === "card_error") {
      return { outcome: "declined", code: codeOf(err) };
    }
    // Stripe refusing this invoice: already paid in the meantime (Stripe's own
    // retry or the portal's pay button got there first), no longer open, a
    // card it will not use. A retry fails the same way. Read it back to tell
    // a race that ended paid from a real refusal.
    if (isInvalidRequest(err)) {
      if (await invoiceNowPaid(stripe, inv.id)) return { outcome: "already_paid", code: codeOf(err) };
      return { outcome: "refused", code: codeOf(err) };
    }
    // Unreachable, rate limited, a Stripe outage: worth a redelivery.
    throw e;
  }
}

/** Whether the invoice reads as paid now. A failed read is no: the refusal stands. */
async function invoiceNowPaid(stripe: Stripe, invoiceId: string): Promise<boolean> {
  try {
    const fresh = await stripe.invoices.retrieve(invoiceId);
    return fresh.status === "paid";
  } catch {
    return false;
  }
}
