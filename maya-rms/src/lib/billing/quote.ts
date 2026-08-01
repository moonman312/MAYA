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
  /** Bill this many rooms instead of what the owner typed. */
  roomsOverride?: number;
  percentOff?: number;
  /** "once" is the annual-rescaled form; a number is Stripe's repeating months. */
  percentDuration?: "once" | "forever" | number;
};

export type CheckoutQuote = {
  billedRooms: number;
  perRoomCents: number;
  /** A normal period after any never-ending discount. The headline. */
  recurringCents: number;
  /** The first invoice, discounts applied. */
  firstCents: number;
  /** Set when the first-invoice price only lasts this many monthly invoices. */
  discountMonths?: number;
  trialDays?: number;
  /** The billed count came from the code, not the typed rooms. */
  overridden: boolean;
};

/** Stripe applies percent coupons to the invoice subtotal and rounds to the cent. */
function lessPct(cents: number, pct: number): number {
  return Math.round((cents * (100 - pct)) / 100);
}

export function checkoutQuote(
  rooms: number,
  interval: BillingInterval,
  effect?: CodeDisplayEffect,
): CheckoutQuote {
  const billedRooms = effect?.roomsOverride ?? rooms;
  const base = priceCents(billedRooms, interval);
  const quote: CheckoutQuote = {
    billedRooms,
    perRoomCents: tierFor(billedRooms).centsPerRoom,
    recurringCents: base,
    firstCents: base,
    overridden: effect?.roomsOverride != null && effect.roomsOverride !== rooms,
  };
  if (effect?.trialDays) quote.trialDays = effect.trialDays;

  const pct = effect?.percentOff;
  if (!pct) return quote;

  if (effect.percentDuration === "forever") {
    quote.recurringCents = lessPct(base, pct);
    quote.firstCents = quote.recurringCents;
    return quote;
  }
  // "once" and repeating-months both discount the first invoice; only a
  // monthly buyer sees the repeat count, an annual invoice swallows it whole.
  quote.firstCents = lessPct(base, pct);
  if (typeof effect.percentDuration === "number" && interval === "month") {
    quote.discountMonths = effect.percentDuration;
  }
  return quote;
}
