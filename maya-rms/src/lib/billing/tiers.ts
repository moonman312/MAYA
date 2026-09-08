/**
 * MAYA's price brackets, in one place.
 *
 * These mirror the Stripe prices created by scripts/stripe-bootstrap.mts. Stripe
 * is what actually charges; this exists so the UI can quote a number before
 * anyone reaches checkout, and so a room count can be validated without a
 * round-trip. If the two ever disagree, Stripe wins and the bootstrap script is
 * the thing to re-run.
 *
 * The whole property bills at the bracket its room count lands in — a step
 * function, not a marginal one. That means total cost is NOT monotonic across
 * boundaries: 21 rooms costs less than 20. That is deliberate and signed off;
 * it is not a bug to be smoothed into graduated pricing.
 */

export const MONTHLY_LOOKUP_KEY = "maya_rooms_monthly_v1";
export const ANNUAL_LOOKUP_KEY = "maya_rooms_annual_v1";

export type BillingInterval = "month" | "year";

/** Largest property MAYA sells to self-serve. */
export const MAX_ROOMS = 500;

/** Per-room cents per month, by upper bound of the bracket. */
export const TIERS: readonly { maxRooms: number; centsPerRoom: number }[] = [
  { maxRooms: 20, centsPerRoom: 550 },
  { maxRooms: 40, centsPerRoom: 500 },
  { maxRooms: 60, centsPerRoom: 400 },
  { maxRooms: 80, centsPerRoom: 300 },
  { maxRooms: MAX_ROOMS, centsPerRoom: 250 },
];

/**
 * Annual gets 10% off every bracket except the first. The smallest properties
 * can still pay annually — it is offered as "pay once a year", and the UI must
 * say exactly that rather than implying a discount they are not getting
 * (annualDiscountPct returns 0 for them, so ask it rather than assuming).
 */
export const ANNUAL_DISCOUNT_PCT = 10;

export function tierFor(rooms: number): { maxRooms: number; centsPerRoom: number } {
  return TIERS.find((t) => rooms <= t.maxRooms) ?? TIERS[TIERS.length - 1];
}

export function annualDiscountPct(rooms: number): number {
  return tierFor(rooms) === TIERS[0] ? 0 : ANNUAL_DISCOUNT_PCT;
}

/**
 * The brackets in the shape Stripe's volume-tier prices take, for
 * scripts/stripe-bootstrap.mts to push instead of keeping its own copy — a
 * reprice must be one edit that the quotes, the validators, and Stripe all see.
 * The last up_to is "inf": the Stripe price is uncapped, MAX_ROOMS is a sales
 * cap the app enforces, not one Stripe knows about.
 *
 * Annual discounts the per-room rate and rounds there, because Stripe bills
 * unit_amount times quantity. Keep rates where the discounted cents stay whole,
 * or priceCents and the actual invoice drift by pennies.
 */
export function stripeVolumeTiers(interval: BillingInterval): { upTo: string; cents: number }[] {
  return TIERS.map((t, i) => {
    const upTo = t.maxRooms === MAX_ROOMS ? "inf" : String(t.maxRooms);
    if (interval === "month") return { upTo, cents: t.centsPerRoom };
    const full = t.centsPerRoom * 12;
    return { upTo, cents: i === 0 ? full : Math.round((full * (100 - ANNUAL_DISCOUNT_PCT)) / 100) };
  });
}

/** What the property pays per billing period, in cents. */
export function priceCents(rooms: number, interval: BillingInterval): number {
  const monthly = rooms * tierFor(rooms).centsPerRoom;
  if (interval === "month") return monthly;
  const full = monthly * 12;
  return Math.round((full * (100 - annualDiscountPct(rooms))) / 100);
}

/** True when a stated room count is one we can actually bill and price. */
export function isBillableRoomCount(rooms: unknown): rooms is number {
  return typeof rooms === "number" && Number.isInteger(rooms) && rooms >= 1 && rooms <= MAX_ROOMS;
}

export type RoomChangeQuote = { newPeriodCents: number; deltaCents: number; summary: string };

/**
 * What changing the room count does to the bill, phrased for the owner about to
 * do it. Lives here rather than beside the page because the quote must come from
 * the same brackets that price the change — quoting from a second copy is how a
 * screen ends up promising a number Stripe does not charge.
 *
 * Says nothing about the exact proration: Stripe decides the credit, and the
 * honest answer is that the next invoice is adjusted, not a figure computed here
 * that could disagree with the invoice.
 */
export function describeRoomChange(
  currentRooms: number,
  newRooms: number,
  interval: BillingInterval,
): RoomChangeQuote {
  const currentCents = priceCents(currentRooms, interval);
  const newPeriodCents = priceCents(newRooms, interval);
  const deltaCents = newPeriodCents - currentCents;
  const per = interval === "year" ? "year" : "month";

  if (deltaCents === 0) {
    return { newPeriodCents, deltaCents, summary: `Still ${formatUsd(newPeriodCents)} per ${per}.` };
  }
  return {
    newPeriodCents,
    deltaCents,
    summary: `${formatUsd(currentCents)} ${deltaCents > 0 ? "up" : "down"} to ${formatUsd(newPeriodCents)} per ${per}. Your next invoice is adjusted for the part of this period you have already paid.`,
  };
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Per-room rates always show cents. Left to formatUsd, one bracket reads "$5"
 * and the next "$5.50", which looks like a mistake rather than two rates.
 */
export function formatPerRoom(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
