import "server-only";

/**
 * Decides whether an upcoming charge should trigger the "you haven't connected
 * your PMS yet" email, and sends it.
 *
 * The rule is narrow on purpose: only a property that has paid and still has no
 * working PMS connection gets nudged. A hotel that is already connected is
 * getting what it pays for, and a renewal notice it did not ask for is just
 * noise that trains people to ignore our mail.
 *
 * Kept out of the webhook route so the "should this send" logic can be tested
 * without a signature, a Stripe client, or an email provider.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isResendConfigured, sendEmail } from "@/lib/email/resend";
import {
  renewalNudgeHtml,
  renewalNudgeSubject,
  renewalNudgeText,
  type RenewalNudgeInput,
} from "@/lib/email/renewal-nudge-email";
import { formatPerRoom, priceCents, type BillingInterval } from "./tiers";

/**
 * A connection in any of these states is doing its job or will recover on its
 * own — 'degraded' and 'error' mean it connected once and is now unhappy, which
 * is a different problem with a different message, not an onboarding nudge.
 */
const WORKING_OR_RECOVERABLE = new Set(["connected", "degraded", "error"]);

export type NudgeSkip =
  | "no_hotel_metadata"
  | "pms_connected"
  | "no_recipient"
  | "email_not_configured"
  | "nothing_due"
  /** Couldn't read the connection state, so we decline to guess. */
  | "pms_state_unknown";

export type NudgeDecision =
  | { send: true; to: string; hotelId: string }
  | { send: false; reason: NudgeSkip };

export type UpcomingInvoice = {
  /** Stripe subscription id, or null when the invoice isn't for one. */
  subscriptionId: string | null;
  hotelId: string | null;
  amountDue: number;
  currency: string;
  /** Unix seconds the charge is expected. */
  nextPaymentAttempt: number | null;
  periodEnd: number | null;
  customerEmail: string | null;
  billingInterval: "month" | "year";
  roomCount: number;
  /** No previous paid invoice on this subscription — a trial ending, usually. */
  isFirstCharge: boolean;
};

/**
 * Whether to nudge. Reads pms_connections rather than trusting anything on the
 * Stripe side, since "have they actually connected" is only knowable here.
 */
export async function decideNudge(
  admin: SupabaseClient,
  invoice: UpcomingInvoice,
): Promise<NudgeDecision> {
  if (!invoice.hotelId) return { send: false, reason: "no_hotel_metadata" };
  if (invoice.amountDue <= 0) return { send: false, reason: "nothing_due" };

  const { data: connections, error } = await admin
    .from("pms_connections")
    .select("status")
    .eq("hotel_id", invoice.hotelId);

  // A failed read used to look identical to "no connection", which sent a
  // connected, paying customer an email telling them they had never set MAYA up.
  // Staying quiet is the safe direction: the worst case is one missed nudge,
  // against telling someone their working product doesn't work.
  if (error) {
    console.error(
      JSON.stringify({ fn: "decideNudge", hotel: invoice.hotelId, error: error.message }),
    );
    return { send: false, reason: "pms_state_unknown" };
  }

  const working = (connections ?? []).some((c) => WORKING_OR_RECOVERABLE.has(String(c.status)));
  if (working) return { send: false, reason: "pms_connected" };

  if (!invoice.customerEmail) return { send: false, reason: "no_recipient" };
  if (!isResendConfigured()) return { send: false, reason: "email_not_configured" };

  return { send: true, to: invoice.customerEmail, hotelId: invoice.hotelId };
}

function formatMoney(minorUnits: number, currency: string): string {
  const symbol = currency.toLowerCase() === "usd" ? "$" : "";
  const value = (minorUnits / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return symbol ? `${symbol}${value}` : `${value} ${currency.toUpperCase()}`;
}

function formatChargeDate(unixSeconds: number | null): string {
  if (unixSeconds == null) return "shortly";
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * What one room costs for a whole billing period, so room count times this rate
 * reconstructs the total the customer is about to be charged.
 */
function perRoomForPeriod(rooms: number, interval: BillingInterval): number {
  if (rooms < 1) return 0;
  return Math.round(priceCents(rooms, interval) / rooms);
}

/**
 * The billing page on the same deployment. Derived rather than threaded through
 * every caller, since both links are the same origin — and tolerant of a caller
 * that hands over something which isn't a parseable URL, because losing the
 * whole email over the second link is a worse outcome than an odd-looking one.
 */
function billingUrlFrom(resumeUrl: string): string {
  try {
    return new URL("/account/billing", resumeUrl).toString();
  } catch {
    return `${resumeUrl.replace(/\/+$/, "")}/account/billing`;
  }
}

export function buildNudge(invoice: UpcomingInvoice, resumeUrl: string): RenewalNudgeInput {
  return {
    resumeUrl,
    billingUrl: billingUrlFrom(resumeUrl),
    amount: formatMoney(invoice.amountDue, invoice.currency),
    chargeDate: formatChargeDate(invoice.nextPaymentAttempt ?? invoice.periodEnd),
    billingInterval: invoice.billingInterval,
    roomCount: invoice.roomCount,
    // Per room FOR THIS PERIOD, so the sentence's own arithmetic holds. The
    // bracket rate is per month, and printing it beside an annual total put two
    // numbers a factor of ten apart in one line — the sort of thing that makes
    // someone doubt the whole invoice.
    perRoom: formatPerRoom(perRoomForPeriod(invoice.roomCount, invoice.billingInterval)),
    isFirstCharge: invoice.isFirstCharge,
  };
}

/**
 * Send it. The idempotency key is the subscription plus the period the charge
 * covers: invoice.upcoming carries no invoice id (Stripe builds the invoice
 * later), so there is nothing else stable to deduplicate a redelivery against,
 * and without one a retried webhook mails the same person twice.
 */
export async function sendRenewalNudge(
  invoice: UpcomingInvoice,
  to: string,
  resumeUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  const input = buildNudge(invoice, resumeUrl);
  try {
    await sendEmail({
      to,
      subject: renewalNudgeSubject(input),
      html: renewalNudgeHtml(input),
      text: renewalNudgeText(input),
      idempotencyKey: `nudge:${invoice.subscriptionId ?? "none"}:${invoice.periodEnd ?? 0}`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}
