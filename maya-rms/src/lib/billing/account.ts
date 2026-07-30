import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus } from "./entitlement";
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
  renewsAt: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  /** Set only once the card check has actually failed, not while it retries. */
  cardTrouble: CardTrouble | null;
  signupCode: string | null;
  entitled: boolean;
};

const COLUMNS =
  "hotel_id, status, billing_interval, billed_rooms, current_period_end, trial_end, cancel_at_period_end, card_verify_failed_at, card_verify_last_code, signup_code_id";

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

  let signupCode: string | null = null;
  if (data.signup_code_id) {
    const { data: code } = await supabase
      .from("signup_codes")
      .select("code")
      .eq("id", data.signup_code_id)
      .maybeSingle();
    signupCode = code ? String(code.code) : null;
  }

  return {
    hotelId,
    status: String(data.status),
    interval,
    rooms,
    periodCents: priceCents(rooms, interval),
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
    entitled: isEntitledStatus(String(data.status)),
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
    return {
      tone: "stopped",
      title: "MAYA has paused work on this property",
      detail:
        "Prices are no longer being calculated or sent to your PMS. Restart the subscription and it picks up where it left off.",
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
      detail: `Your first charge of ${formatUsd(billing.periodCents)} lands on ${longDate(billing.trialEndsAt)}.`,
    };
  }

  return {
    tone: "ok",
    title: "Your subscription is active",
    detail: billing.renewsAt
      ? `Next charge of ${formatUsd(billing.periodCents)} on ${longDate(billing.renewsAt)}.`
      : `${formatUsd(billing.periodCents)} per ${billing.interval === "year" ? "year" : "month"}.`,
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
