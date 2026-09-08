import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus } from "./entitlement";
import { compareRooms, graceDaysLeft, measureRooms, type RoomVerdict } from "./room-count";
import { isStripeConfigured, stripeClient } from "./stripe";
import { formatUsd, priceCents, type BillingInterval } from "./tiers";

/**
 * What a hotel owner sees about their own subscription.
 *
 * Reads under the caller's own session — hotel_subscriptions is readable by
 * members via is_hotel_accessible and writable by nobody but the webhook, so the
 * policy decides what they see rather than this file. Every mutation on this
 * page goes to Stripe and comes back through the webhook; nothing here writes.
 */

export type CardTrouble = { code: string | null; since: string };

export type AccountBilling = {
  hotelId: string;
  status: string;
  interval: BillingInterval;
  rooms: number;
  /** Per period, at the brackets — what Stripe bills absent a discount code. */
  periodCents: number;
  /**
   * What Stripe says the next invoice actually is — coupons and fixed-price
   * codes included. Null when Stripe can't be asked; show periodCents then,
   * which can only overstate, never surprise upward.
   */
  chargeCents: number | null;
  renewsAt: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  /** Set only once the card check has actually failed, not while it retries. */
  cardTrouble: CardTrouble | null;
  signupCode: string | null;
  entitled: boolean;
  /** How the billed count compares to what their PMS says they run. */
  roomTruth: RoomVerdict;
  /** Days left to fix a shortfall themselves before MAYA does it. */
  roomGraceDaysLeft: number;
  /** Bookable spaces excluded from billing because nobody sleeps in them. */
  notBilledFor: { name: string; rooms: number }[];
};

const COLUMNS =
  "hotel_id, status, billing_interval, billed_rooms, current_period_end, trial_end, cancel_at_period_end, card_verify_failed_at, card_verify_last_code, signup_code_id, measured_rooms, room_shortfall_since, stripe_subscription_id";

/**
 * The next invoice as Stripe would write it today. Best-effort with a short
 * leash: this decorates the billing page, and a slow Stripe outage must not
 * take the page down with it.
 */
async function previewChargeCents(subscriptionId: string): Promise<number | null> {
  if (!isStripeConfigured()) return null;
  try {
    const invoice = await stripeClient().invoices.createPreview(
      { subscription: subscriptionId },
      { timeout: 3000 },
    );
    return typeof invoice.amount_due === "number" ? invoice.amount_due : null;
  } catch {
    return null;
  }
}

/**
 * Null means this property never went through checkout — an admin-created hotel,
 * or a deployment with no Stripe. Callers must treat that as "billing does not
 * apply here" rather than as "unpaid", which is the same rule splitByEntitlement
 * follows.
 */
export async function loadAccountBilling(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<AccountBilling | null> {
  const { data, error } = await supabase
    .from("hotel_subscriptions")
    .select(COLUMNS)
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (error || !data) return null;

  const interval = String(data.billing_interval) === "year" ? "year" : "month";
  const rooms = Number(data.billed_rooms) || 0;

  // Re-measured here rather than read off the row so the page can name the
  // spaces being left out. Someone who counts their own PMS and gets a bigger
  // number than their invoice needs to see why, or the invoice looks wrong.
  const measurement = await measureRooms(supabase, hotelId);

  let signupCode: string | null = null;
  if (data.signup_code_id) {
    const { data: code } = await supabase
      .from("signup_codes")
      .select("code")
      .eq("id", data.signup_code_id)
      .maybeSingle();
    signupCode = code ? String(code.code) : null;
  }

  const entitled = isEntitledStatus(String(data.status));
  // Only a subscription that will invoice again has a next charge to preview —
  // asking Stripe about a cancelled one is an error, not a number.
  const chargeCents =
    entitled && data.stripe_subscription_id
      ? await previewChargeCents(String(data.stripe_subscription_id))
      : null;

  return {
    hotelId,
    status: String(data.status),
    interval,
    rooms,
    periodCents: priceCents(rooms, interval),
    chargeCents,
    renewsAt: data.current_period_end ? String(data.current_period_end) : null,
    trialEndsAt: data.trial_end ? String(data.trial_end) : null,
    cancelAtPeriodEnd: data.cancel_at_period_end === true,
    cardTrouble: data.card_verify_failed_at
      ? {
          code: data.card_verify_last_code ? String(data.card_verify_last_code) : null,
          since: String(data.card_verify_failed_at),
        }
      : null,
    signupCode,
    entitled,
    notBilledFor: measurement.excluded,
    roomTruth: compareRooms(
      data.measured_rooms == null ? null : Number(data.measured_rooms),
      rooms,
    ),
    roomGraceDaysLeft: graceDaysLeft(
      data.room_shortfall_since ? String(data.room_shortfall_since) : null,
      new Date(),
    ),
  };
}

/** How loudly the page should say it. */
export type BillingTone = "ok" | "warn" | "stopped";

export type BillingHeadline = { tone: BillingTone; title: string; detail: string };

/**
 * The one sentence at the top of the billing page.
 *
 * Ordered by what the owner most needs to know, not by what is most technically
 * interesting: work having stopped outranks a card problem, which outranks a
 * scheduled cancellation, which outranks a trial counting down.
 */
export function headlineFor(billing: AccountBilling, now = new Date()): BillingHeadline {
  if (!billing.entitled) {
    // Two different fixes hide under "not entitled", and sending someone at the
    // wrong one wastes their time: an unpaid subscription is still alive in
    // Stripe and a working card revives it, whereas a cancelled one is gone and
    // no amount of card-updating brings it back.
    const recoverable = billing.status === "unpaid";
    return {
      tone: "stopped",
      title: "MAYA has paused work on this property",
      detail: recoverable
        ? "Prices are no longer being calculated or sent to your PMS. Update your card and the subscription restarts where it left off."
        : "Prices are no longer being calculated or sent to your PMS. Your subscription was cancelled, so starting again means a new one — restart below whenever you're ready.",
    };
  }

  if (billing.status === "past_due") {
    return {
      tone: "warn",
      title: "Your last payment did not go through",
      detail:
        "We are still pricing your rooms while the bank retries. Update your card to avoid an interruption.",
    };
  }

  if (billing.cardTrouble) {
    return {
      tone: "warn",
      title: "Your saved card stopped working",
      detail:
        "Nothing has failed yet, but the next charge will. Update it before your renewal to keep pricing running.",
    };
  }

  // Above a scheduled cancellation and a trial countdown, because this is the
  // only one where the amount they pay is about to change without them doing
  // anything. Being surprised by a larger charge is what turns a fair correction
  // into a chargeback, so it says the number and the date plainly.
  if (billing.roomTruth.kind === "short") {
    const { measured, billed, shortBy } = billing.roomTruth;
    const days = billing.roomGraceDaysLeft;
    return {
      tone: "warn",
      title: `You're billed for ${billed} rooms but running ${measured}`,
      detail:
        `MAYA charges per room, so ${shortBy} ${shortBy === 1 ? "room is" : "rooms are"} not being paid for. ` +
        (days > 0
          ? `Set the count right below within ${days} day${days === 1 ? "" : "s"} and nothing else happens — after that we'll update it to ${measured} for you and adjust your next invoice.`
          : `We'll update it to ${measured} shortly and adjust your next invoice. Change it below if that isn't right.`),
    };
  }

  if (billing.cancelAtPeriodEnd) {
    return {
      tone: "warn",
      title: "This subscription is set to cancel",
      detail: billing.renewsAt
        ? `MAYA keeps working until ${longDate(billing.renewsAt)}, then stops.`
        : "MAYA keeps working until the end of this billing period, then stops.",
    };
  }

  if (billing.status === "trialing" && billing.trialEndsAt) {
    const days = daysBetween(now, new Date(billing.trialEndsAt));
    return {
      tone: "ok",
      title: days <= 0 ? "Your trial ends today" : `Your trial ends in ${days} day${days === 1 ? "" : "s"}`,
      detail: `Your first charge of ${formatUsd(billing.chargeCents ?? billing.periodCents)} lands on ${longDate(billing.trialEndsAt)}.`,
    };
  }

  // chargeCents is Stripe's own preview — the number that survives discount
  // codes and fixed-price deals. The list price steps in only when Stripe
  // couldn't be asked, and can only ever read high.
  return {
    tone: "ok",
    title: "Your subscription is active",
    detail: billing.renewsAt
      ? `Next charge of ${formatUsd(billing.chargeCents ?? billing.periodCents)} on ${longDate(billing.renewsAt)}.`
      : `${formatUsd(billing.chargeCents ?? billing.periodCents)} per ${billing.interval === "year" ? "year" : "month"}.`,
  };
}

/**
 * What the period-end date actually means, which depends on whether anything is
 * still going to be charged. Calling it "Next charge" on a cancelled
 * subscription promises a payment that will never be taken.
 */
export function periodEndLabel(billing: AccountBilling): string {
  if (!billing.entitled) return "Ended";
  if (billing.cancelAtPeriodEnd) return "Access ends";
  if (billing.status === "past_due") return "Retrying payment until";
  return "Next charge";
}

/**
 * WHOLE days from now until then. Rounding up would call a trial with six hours
 * left "1 day", which reads as a day of slack the owner does not have.
 */
function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
