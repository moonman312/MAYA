/**
 * Signup codes: the gate on who can sign up, and what they pay.
 *
 * Until MAYA opens up, a valid code is required to reach checkout at all — the
 * point is to throttle demand while it's deployed to MHS's own clients first,
 * not just to discount. So "no code" is a hard stop, not a full-price path.
 *
 * Validation lives here rather than in the route so the pre-checkout "check my
 * code" call and checkout itself can never disagree about whether a code is
 * good. Redemption counting is done against the redemptions table rather than a
 * counter column, so a code can't drift out of sync with what it actually
 * granted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingInterval } from "./tiers";

/**
 * The shape every code has: alphanumeric plus dashes, 3-40 characters.
 *
 * Enforced on the way IN when a code is created and on the way OUT when one is
 * redeemed, from this single definition. The lookup side is not cosmetic
 * validation — see checkCode for what a code containing `%` used to do.
 */
export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export type SignupCodeKind = "trial" | "percent_off" | "fixed_price";

export type SignupCode = {
  id: string;
  code: string;
  kind: SignupCodeKind;
  trial_days: number | null;
  percent_off: number | null;
  duration_months: number | null;
  fixed_price_cents: number | null;
  fixed_price_interval: BillingInterval | null;
  tier_rooms_cap: number | null;
  max_redemptions: number | null;
  expires_at: string | null;
  is_active: boolean;
  stripe_coupon_id: string | null;
};

export type CodeRejection =
  | "unknown"
  | "inactive"
  | "expired"
  | "exhausted"
  | "already_redeemed"
  | "wrong_interval";

/** Plain-language reason, shown to whoever typed the code. */
export function rejectionMessage(reason: CodeRejection): string {
  switch (reason) {
    case "unknown":
      return "We don't recognize that code — check it for typos.";
    case "inactive":
      return "That code has been turned off.";
    case "expired":
      return "That code has expired.";
    case "exhausted":
      return "That code has already been used the maximum number of times.";
    case "already_redeemed":
      return "This property already used that code.";
    case "wrong_interval":
      return "That code is for a different billing period — switch between monthly and yearly to use it.";
  }
}

export type CodeCheck =
  | { ok: true; code: SignupCode; describe: string }
  | { ok: false; reason: CodeRejection; message: string };

/**
 * What the owner is told they're getting, before they commit to anything.
 *
 * Takes the interval because a limited percentage does not mean the same thing
 * on both — an annual buyer's discount is rescaled onto their single invoice, so
 * promising "20% off for 3 months" to someone who will see 5% once is a number
 * on screen that their receipt then contradicts.
 */
export function describeCode(code: SignupCode, interval: BillingInterval = "month"): string {
  if (code.kind === "trial") {
    const d = code.trial_days ?? 0;
    return `${d} day${d === 1 ? "" : "s"} free, then your normal rate. We'll ask for a card now but won't charge it until the trial ends.`;
  }
  if (code.kind === "percent_off") {
    const pct = Number(code.percent_off ?? 0);
    const months = code.duration_months;
    if (!months) return `${pct}% off, for as long as you stay.`;
    if (interval === "year" && months < 12) {
      const spec = checkoutEffectFor(code, "year").couponNeeded;
      return `${pct}% off your first ${months} month${months === 1 ? "" : "s"} — taken as ${spec?.percentOff}% off your first year, which is the same saving.`;
    }
    return `${pct}% off for your first ${months} month${months === 1 ? "" : "s"}.`;
  }
  const dollars = ((code.fixed_price_cents ?? 0) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
  });
  return `A fixed $${dollars} per ${code.fixed_price_interval === "year" ? "year" : "month"}, instead of the standard rate.`;
}

/**
 * Look a code up and decide whether it can be used, optionally for a specific
 * hotel. Reads with whatever client is passed: the pre-check route uses the
 * service-role client because signup_codes is admin-only under RLS and the
 * person typing a code is not an admin.
 */
export async function checkCode(
  admin: SupabaseClient,
  raw: string,
  opts: { hotelId?: string | null; now?: Date; interval?: BillingInterval } = {},
): Promise<CodeCheck> {
  const typed = raw.trim().toUpperCase();

  // Shape check BEFORE the query, and it is a security boundary rather than
  // politeness: the lookup below is a LIKE pattern match, so an unfiltered `%`
  // matched whatever live code happened to be there and walked straight through
  // the gate, while `M%` and `_______` turned this into an oracle for guessing
  // real codes character by character. A well-formed code cannot contain either
  // wildcard. Rejects with the same "unknown" as a wrong code so this adds no
  // new signal about what exists.
  if (!CODE_PATTERN.test(typed)) {
    return { ok: false, reason: "unknown", message: rejectionMessage("unknown") };
  }

  // Codes get read off a business card, so matching is case-insensitive —
  // uq_signup_codes_code indexes lower(code) to match.
  const { data, error } = await admin
    .from("signup_codes")
    .select(
      "id, code, kind, trial_days, percent_off, duration_months, fixed_price_cents, fixed_price_interval, tier_rooms_cap, max_redemptions, expires_at, is_active, stripe_coupon_id",
    )
    .ilike("code", typed)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "unknown", message: rejectionMessage("unknown") };
  const code = data as SignupCode;

  if (!code.is_active) return { ok: false, reason: "inactive", message: rejectionMessage("inactive") };

  const now = opts.now ?? new Date();
  if (code.expires_at && new Date(code.expires_at) <= now) {
    return { ok: false, reason: "expired", message: rejectionMessage("expired") };
  }

  if (code.max_redemptions != null) {
    const { count } = await admin
      .from("signup_code_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("code_id", code.id);
    if ((count ?? 0) >= code.max_redemptions) {
      return { ok: false, reason: "exhausted", message: rejectionMessage("exhausted") };
    }
  }

  if (opts.hotelId) {
    const { data: mine } = await admin
      .from("signup_code_redemptions")
      .select("id")
      .eq("code_id", code.id)
      .eq("hotel_id", opts.hotelId)
      .maybeSingle();
    if (mine) {
      return { ok: false, reason: "already_redeemed", message: rejectionMessage("already_redeemed") };
    }
  }

  // A fixed price was agreed against a billing period — "$99 a month" is not an
  // offer of "$99 a year". Without this the buyer picks whichever period suits
  // them and the deal means something different from what was struck.
  if (code.kind === "fixed_price" && code.fixed_price_interval && opts.interval) {
    if (code.fixed_price_interval !== opts.interval) {
      return { ok: false, reason: "wrong_interval", message: rejectionMessage("wrong_interval") };
    }
  }

  return { ok: true, code, describe: describeCode(code, opts.interval ?? "month") };
}

/**
 * The parts of a Checkout Session a code changes.
 *
 * A percent-off code needs a Stripe coupon to exist; `couponNeeded` says so
 * rather than creating one here, because creating Stripe objects belongs to the
 * caller that can also persist the resulting id back onto the code row.
 */
export type CouponSpec = {
  percentOff: number;
  /** Stated outright rather than inferred from a null month count, which is how
   *  a one-off discount previously became a permanent one. */
  duration: "once" | "repeating" | "forever";
  durationMonths?: number;
  /**
   * Whether this coupon may be cached on the code row and reused. False for the
   * annual-rescaled form: it is worth the wrong amount on a monthly
   * subscription, and one cached id is shared by every later redemption.
   */
  reusable: boolean;
};

export type CheckoutEffect = {
  trialDays?: number;
  discountCouponId?: string;
  couponNeeded?: CouponSpec;
  /** Bill this many rooms instead of what the owner stated. */
  roomsOverride?: number;
};

/**
 * A duration-limited discount, expressed so it is worth the same on either
 * billing period.
 *
 * Stripe counts a repeating coupon's duration in MONTHS but applies it per
 * INVOICE, and an annual invoice covers twelve of them — so "20% off for 3
 * months" attached to an annual subscription discounted the whole first year,
 * four times the intended giveaway. Scaling the percentage and charging it once
 * hands over the same money the monthly buyer would have received.
 */
function annualEquivalent(percentOff: number, durationMonths: number): number {
  // Two decimals is what Stripe accepts on percent_off.
  return Math.round((percentOff * durationMonths * 100) / 12) / 100;
}

export function checkoutEffectFor(code: SignupCode, interval: BillingInterval): CheckoutEffect {
  if (code.kind === "trial") {
    return { trialDays: code.trial_days ?? undefined };
  }
  if (code.kind === "percent_off") {
    const percentOff = Number(code.percent_off ?? 0);
    const months = code.duration_months;

    // Only a LIMITED discount needs rescaling: "forever" is worth the same on
    // either period, and twelve months or more already covers a whole annual
    // invoice. The rescaled coupon is deliberately NOT cached — the stored id is
    // shared by every later redemption of this code, so a monthly buyer would
    // inherit a percentage computed for a year.
    const rescale = interval === "year" && months != null && months < 12;
    if (rescale) {
      return {
        couponNeeded: {
          percentOff: annualEquivalent(percentOff, months),
          duration: "once",
          reusable: false,
        },
      };
    }

    if (code.stripe_coupon_id) return { discountCouponId: code.stripe_coupon_id };
    return {
      couponNeeded: months
        ? { percentOff, duration: "repeating", durationMonths: months, reusable: true }
        : { percentOff, duration: "forever", reusable: true },
    };
  }
  // fixed_price: pinning the billed room count to the tier the deal was struck
  // at is how an agreed number is honoured without inventing a bespoke price
  // per customer. The cap is a room count, so it lands on an existing bracket.
  return code.tier_rooms_cap ? { roomsOverride: code.tier_rooms_cap } : {};
}
