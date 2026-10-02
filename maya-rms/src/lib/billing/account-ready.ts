import "server-only";

/**
 * "Your account is ready": the email the "Payment received" screen promises
 * to anyone who leaves it before it moves on.
 *
 * Ready means what that screen waits for: the property's subscription is live
 * (trialing or active). The Stripe webhook is where that becomes true for good.
 * The checkout return route can record it a moment earlier, but only when the
 * owner is still in the browser and needs no email, and every live subscription
 * reaches the webhook regardless. So it is sent from there, right after a
 * Marketplace property is switched on (afterSubscriptionSaved, after-save.ts),
 * and from the nightly Stripe check when the webhook's message never came.
 *
 * Once per property, and never twice, across Stripe's redeliveries, events
 * that land together, and anything else: the delivery that wins
 * hotel_subscriptions.account_ready_emailed_at (an update ... where is null,
 * see 99_supabase_migration_account_ready_email_v1.sql) is the only one that
 * sends. A failed send gives the claim back so a later delivery can try again,
 * and Resend's idempotency key catches the case where the failure was only in
 * hearing back. That retry is bounded by ACCOUNT_READY_WINDOW_HOURS, the same
 * 24 hours the key lasts, so a late retry can never double up, and a property
 * that went live long ago never gets welcomed on some unrelated later event.
 *
 * The recipient is the person who paid: the MAYA login checkout stamped on the
 * subscription as user_id, which is who the link signs back in. The Stripe
 * customer's email is the fallback; checkout put that same address there.
 *
 * Never throws. The subscription is already recorded by the time this runs,
 * and a webhook failed over an email would make Stripe retry a payment record.
 */

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEntitledStatus } from "./entitlement";
import { PENDING_NAME_PREFIX } from "./pending-hotel";
import type { SubscriptionProjection } from "./sync";
import { isResendConfigured, sendEmail } from "@/lib/email/resend";
import {
  ACCOUNT_READY_REPLY_TO,
  accountReadyHtml,
  accountReadySubject,
  accountReadyText,
  type AccountReadyInput,
} from "@/lib/email/account-ready-email";

/** How long after the subscription starts the email may still go out. */
export const ACCOUNT_READY_WINDOW_HOURS = 24;

const MIGRATION = "99_supabase_migration_account_ready_email_v1.sql";

export type AccountReadyOutcome =
  | { sent: true; hotelId: string; to: string }
  | {
      sent: false;
      reason:
        | "not_entitled"
        | "not_fresh"
        | "already_sent"
        | "no_row"
        | "email_not_configured"
        | "no_base_url"
        | "no_recipient"
        | "column_missing"
        | "error"
        | "send_failed";
      message?: string;
    };

type DbError = { code?: string; message: string } | null;

const columnMissing = (e: DbError) => Boolean(e && (e.code === "42703" || /account_ready_emailed_at/.test(e.message)));

export async function sendAccountReadyOnce(
  admin: SupabaseClient,
  stripe: Stripe,
  sub: Stripe.Subscription,
  row: SubscriptionProjection,
  now = new Date(),
): Promise<AccountReadyOutcome> {
  try {
    return await sendOnce(admin, stripe, sub, row, now);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ fn: "accountReady", hotel: row.hotel_id, error: message }));
    return { sent: false, reason: "error", message };
  }
}

async function sendOnce(
  admin: SupabaseClient,
  stripe: Stripe,
  sub: Stripe.Subscription,
  row: SubscriptionProjection,
  now: Date,
): Promise<AccountReadyOutcome> {
  const hotelId = row.hotel_id;
  if (!isEntitledStatus(row.status)) return { sent: false, reason: "not_entitled" };
  if (now.getTime() - sub.created * 1000 > ACCOUNT_READY_WINDOW_HOURS * 3600_000) {
    return { sent: false, reason: "not_fresh" };
  }

  // Cheap look first: a signup brings several events inside a second, and only
  // the first needs the recipient looked up. The claim below is what decides.
  const { data: current, error: readErr } = await admin
    .from("hotel_subscriptions")
    .select("account_ready_emailed_at")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (columnMissing(readErr)) return warnColumnMissing();
  if (readErr) return { sent: false, reason: "error", message: readErr.message };
  // No row: persistSubscription declined to write it (a quantity of 0), so
  // there is no property on record to call ready.
  if (!current) return { sent: false, reason: "no_row" };
  if (current.account_ready_emailed_at) return { sent: false, reason: "already_sent" };

  // Faults, not decisions, so they log: silent, a deployment with email
  // switched off looks the same as one where every owner stayed on the page.
  if (!isResendConfigured()) {
    console.error(JSON.stringify({ fn: "accountReady", hotel: hotelId, skipped: "email_not_configured" }));
    return { sent: false, reason: "email_not_configured" };
  }
  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/+$/, "");
  if (!base) {
    // A welcome with a dead link is worse than none.
    console.error(JSON.stringify({ fn: "accountReady", hotel: hotelId, skipped: "no_base_url" }));
    return { sent: false, reason: "no_base_url" };
  }

  const to = await recipientFor(admin, stripe, sub, row);
  if (!to) {
    console.error(JSON.stringify({ fn: "accountReady", hotel: hotelId, skipped: "no_recipient" }));
    return { sent: false, reason: "no_recipient" };
  }

  const { data: hotel } = await admin.from("hotels").select("name").eq("id", hotelId).maybeSingle();
  const name = typeof hotel?.name === "string" ? hotel.name.trim() : "";

  const input: AccountReadyInput = {
    // The router, not a step: it sends them wherever they actually are.
    continueUrl: `${base}/onboarding`,
    // Flow B's placeholder is not a name anyone chose.
    propertyName: name && !name.startsWith(PENDING_NAME_PREFIX) ? name : null,
    trialEndsOn: sub.status === "trialing" && sub.trial_end ? longDate(sub.trial_end) : null,
    // Checkout marks a Marketplace arrival; its Cloudbeds connection came first.
    pmsConnected: sub.metadata?.via === "marketplace_flow_a",
  };

  const claimedAt = now.toISOString();
  const { data: claimed, error: claimErr } = await admin
    .from("hotel_subscriptions")
    .update({ account_ready_emailed_at: claimedAt })
    .eq("hotel_id", hotelId)
    .eq("stripe_subscription_id", sub.id)
    .is("account_ready_emailed_at", null)
    .select("hotel_id");
  if (columnMissing(claimErr)) return warnColumnMissing();
  if (claimErr) return { sent: false, reason: "error", message: claimErr.message };
  // Another delivery got there first. It sends; this one stops.
  if (!claimed || claimed.length === 0) return { sent: false, reason: "already_sent" };

  try {
    await sendEmail({
      to,
      subject: accountReadySubject(input),
      html: accountReadyHtml(input),
      text: accountReadyText(input),
      replyTo: ACCOUNT_READY_REPLY_TO,
      idempotencyKey: `account-ready:${hotelId}`,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Give the claim back, but only our own: if anything else has stamped it
    // since, it is theirs.
    const { error: releaseErr } = await admin
      .from("hotel_subscriptions")
      .update({ account_ready_emailed_at: null })
      .eq("hotel_id", hotelId)
      .eq("account_ready_emailed_at", claimedAt);
    console.error(
      JSON.stringify({
        fn: "accountReady",
        hotel: hotelId,
        error: message,
        released: !releaseErr,
        ...(releaseErr ? { releaseError: releaseErr.message } : {}),
      }),
    );
    return { sent: false, reason: "send_failed", message };
  }

  return { sent: true, hotelId, to };
}

function warnColumnMissing(): AccountReadyOutcome {
  console.warn(
    JSON.stringify({ fn: "accountReady", warning: `hotel_subscriptions.account_ready_emailed_at is missing; run ${MIGRATION}` }),
  );
  return { sent: false, reason: "column_missing" };
}

async function recipientFor(
  admin: SupabaseClient,
  stripe: Stripe,
  sub: Stripe.Subscription,
  row: SubscriptionProjection,
): Promise<string | null> {
  const userId = sub.metadata?.user_id;
  if (userId) {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (!error && data?.user?.email) return data.user.email;
  }
  const customer = await stripe.customers.retrieve(row.stripe_customer_id);
  if ("deleted" in customer && customer.deleted) return null;
  return customer.email ?? null;
}

function longDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
