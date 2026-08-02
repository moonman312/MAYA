/**
 * What the subscribe screen may promise.
 *
 * The headline number and what Stripe charges must come from the same
 * arithmetic or they will disagree — a fixed-price code pins the billed room
 * count to its tier, so quoting from the typed count showed a 12-room owner
 * $66 while Stripe presented $200. Checkout builds its session from
 * checkoutEffectFor; this is the same effect reduced to display, so the panel
 * moves when the code does.
 */

import { priceCents, tierFor, type BillingInterval } from "./tiers";

/** A code's consequences, as validate-code reports them to the screen. */
export type CodeDisplayEffect = {
  trialDays?: number;
  /** At most one of these — a code discounts by percent or by dollars, never both. */
  percentOff?: number;
  amountOffCents?: number;
  /** "once" is the annual-rescaled form; a number is Stripe's repeating months. */
  discountDuration?: "once" | "forever" | number;
};

export type CheckoutQuote = {
  perRoomCents: number;
  /** A normal period after any never-ending discount. The headline. */
  recurringCents: number;
  /** The first invoice, discounts applied. */
  firstCents: number;
  /** Set when the first-invoice price only lasts this many monthly invoices. */
  discountMonths?: number;
  trialDays?: number;
};

/** Stripe applies percent coupons to the invoice subtotal and rounds to the cent. */
function lessPct(cents: number, pct: number): number {
  return Math.round((cents * (100 - pct)) / 100);
}

/** Amount coupons floor at zero — Stripe never invoices a negative. */
function lessAmount(cents: number, offCents: number): number {
  return Math.max(0, cents - offCents);
}

export function checkoutQuote(
  rooms: number,
  interval: BillingInterval,
  effect?: CodeDisplayEffect,
): CheckoutQuote {
  const base = priceCents(rooms, interval);
  const quote: CheckoutQuote = {
    perRoomCents: tierFor(rooms).centsPerRoom,
    recurringCents: base,
    firstCents: base,
  };
  if (effect?.trialDays) quote.trialDays = effect.trialDays;

  const pct = effect?.percentOff;
  const amt = effect?.amountOffCents;
  if (!pct && !amt) return quote;
  const discounted = pct ? lessPct(base, pct) : lessAmount(base, amt ?? 0);

  if (effect?.discountDuration === "forever") {
    quote.recurringCents = discounted;
    quote.firstCents = discounted;
    return quote;
  }
  // "once" and repeating-months both discount the first invoice; only a
  // monthly buyer sees the repeat count, an annual invoice swallows it whole.
  quote.firstCents = discounted;
  if (typeof effect?.discountDuration === "number" && interval === "month") {
    quote.discountMonths = effect.discountDuration;
  }
  return quote;
}
