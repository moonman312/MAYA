import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { graceDaysLeft, graceExpired, measureRooms, ROOM_SHORTFALL_GRACE_DAYS } from "./room-count";
import { formatUsd, isBillableRoomCount, MAX_ROOMS, priceCents, type BillingInterval } from "./tiers";
import { isResendConfigured, sendEmail } from "@/lib/email/resend";
import {
  roomShortfallHtml,
  roomShortfallSubject,
  roomShortfallText,
  type RoomShortfallInput,
} from "@/lib/email/room-shortfall-email";

/**
 * Raises a subscription's billed room count to the number the property actually
 * runs, once the grace period has passed.
 *
 * Jake's call, and the strict reading of it: MAYA charges per room, so a
 * property billing for 20 while running 60 is underpaying by two thirds, and no
 * shortfall is small enough to ignore — one extra room is real money every
 * month. They get told on the dashboard and by email, they get
 * ROOM_SHORTFALL_GRACE_DAYS to set it right themselves, and then this does it
 * for them.
 *
 * Deliberately one-directional. Billing for MORE rooms than they run is shown to
 * them so they can lower it, but never corrected automatically: a room type
 * switched off for a fortnight's refurbishment would otherwise cut the bill
 * without anyone asking for that.
 */

/** Subscriptions examined per invocation, so the route can't run long. */
export const TRUING_BATCH_SIZE = 25;

export type ShortfallRow = {
  hotel_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_interval: string | null;
  billed_rooms: number | null;
  measured_rooms: number | null;
  room_shortfall_since: string | null;
  room_shortfall_notified_at: string | null;
  room_shortfall_notified_rooms: number | null;
};

const SELECT_COLUMNS =
  "hotel_id, stripe_customer_id, stripe_subscription_id, billing_interval, billed_rooms, measured_rooms, room_shortfall_since, room_shortfall_notified_at, room_shortfall_notified_rooms";

/**
 * Properties that have been short for longer than the grace period.
 *
 * The window is filtered in SQL rather than here so a long backlog doesn't push
 * still-in-grace rows out of the batch. Oldest first: whoever has been
 * underpaying longest is corrected first.
 */
export async function dueForTruing(
  admin: SupabaseClient,
  now: Date,
  limit = TRUING_BATCH_SIZE,
): Promise<{ rows: ShortfallRow[]; error?: string }> {
  const cutoff = new Date(now.getTime() - ROOM_SHORTFALL_GRACE_DAYS * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("hotel_subscriptions")
    .select(SELECT_COLUMNS)
    .not("room_shortfall_since", "is", null)
    .lte("room_shortfall_since", cutoff)
    .order("room_shortfall_since", { ascending: true })
    .limit(limit);

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as ShortfallRow[] };
}

/**
 * Everyone currently short, whether or not their grace has run out.
 *
 * Separate from dueForTruing because the warning has to go out at the START of
 * the grace period and the correction at the end — a single query would mean
 * either warning people the day we charge them, or charging people we warned
 * seven days too early.
 */
export async function shortfallsNeedingNotice(
  admin: SupabaseClient,
  limit = TRUING_BATCH_SIZE,
): Promise<{ rows: ShortfallRow[]; error?: string }> {
  const { data, error } = await admin
    .from("hotel_subscriptions")
    .select(SELECT_COLUMNS)
    .not("room_shortfall_since", "is", null)
    .order("room_shortfall_since", { ascending: true })
    .limit(limit);

  if (error) return { rows: [], error: error.message };

  // Filtered here rather than in SQL: "notified about THIS count" is a
  // comparison between two columns, which PostgREST cannot express.
  const rows = (data ?? []).filter((r) => {
    const row = r as ShortfallRow;
    if (!row.room_shortfall_notified_at) return true;
    // Re-warn when the number moved — a hotel told about 25 rooms that is now at
    // 60 has not been told about 60.
    return Number(row.room_shortfall_notified_rooms) !== Number(row.measured_rooms);
  });
  return { rows: rows as ShortfallRow[] };
}

export type NoticeOutcome =
  | { kind: "sent" }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

/**
 * Tell one owner their count moved, before anything charges them for it.
 *
 * The recipient is the Stripe customer's email rather than a hotel membership:
 * it is the address that already receives the invoices, so it is the one that
 * will recognise this — and it is guaranteed to exist, because checkout put it
 * there.
 */
export async function notifyOne(
  admin: SupabaseClient,
  stripe: Stripe,
  row: ShortfallRow,
  now: Date,
): Promise<NoticeOutcome> {
  if (!isResendConfigured()) return { kind: "skipped", reason: "email_not_configured" };

  const measured = Number(row.measured_rooms);
  const billed = Number(row.billed_rooms);
  if (!Number.isFinite(measured) || measured <= billed) return { kind: "skipped", reason: "no_longer_short" };

  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/+$/, "");
  if (!base) {
    // A warning with a dead link is worse than none: it tells someone their bill
    // is changing and gives them no way to act on it.
    console.error(JSON.stringify({ fn: "notifyOne", hotel: row.hotel_id, error: "no_base_url" }));
    return { kind: "skipped", reason: "no_base_url" };
  }

  if (!row.stripe_customer_id) return { kind: "skipped", reason: "no_customer" };

  let to: string | null = null;
  try {
    const customer = await stripe.customers.retrieve(row.stripe_customer_id);
    to = "deleted" in customer && customer.deleted ? null : (customer.email ?? null);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : "customer lookup failed" };
  }
  if (!to) return { kind: "skipped", reason: "no_recipient" };

  const interval: BillingInterval = row.billing_interval === "year" ? "year" : "month";
  const daysLeft = graceDaysLeft(row.room_shortfall_since, now);
  const correctionDate = new Date(
    Date.parse(row.room_shortfall_since ?? now.toISOString()) + ROOM_SHORTFALL_GRACE_DAYS * 86_400_000,
  );

  // Re-measured so the email can name the spaces we are NOT charging for. A
  // hotel that counts its own PMS will get a bigger number than this email
  // quotes, and unexplained that reads as an error in our favour.
  const { excluded } = await measureRooms(admin, row.hotel_id);

  const input: RoomShortfallInput = {
    billingUrl: `${base}/account/billing`,
    billedRooms: billed,
    measuredRooms: measured,
    correctionDate: correctionDate.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }),
    daysLeft,
    currentAmount: formatUsd(priceCents(billed, interval)),
    correctedAmount: formatUsd(priceCents(measured, interval)),
    notBilledFor: excluded.map((e) => e.name),
  };

  try {
    await sendEmail({
      to,
      subject: roomShortfallSubject(input),
      html: roomShortfallHtml(input),
      text: roomShortfallText(input),
      // Keyed on the count, so a redelivered sweep cannot mail twice about the
      // same number while a genuinely changed one still gets its own warning.
      idempotencyKey: `room-shortfall:${row.hotel_id}:${measured}`,
    });
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : "send failed" };
  }

  await admin
    .from("hotel_subscriptions")
    .update({
      room_shortfall_notified_at: now.toISOString(),
      room_shortfall_notified_rooms: measured,
    })
    .eq("hotel_id", row.hotel_id);

  return { kind: "sent" };
}

export type TruingOutcome =
  | { kind: "corrected"; from: number; to: number }
  /** Resolved itself between the measurement and now. */
  | { kind: "no_longer_short" }
  /** Beyond what MAYA sells self-serve — a person has to price this one. */
  | { kind: "too_large"; measured: number }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

/**
 * Correct one subscription.
 *
 * Re-reads the subscription from Stripe rather than trusting the local row, for
 * the same reason the webhook does: our copy can be a delivery behind, and
 * setting a quantity from a stale reading is how you bill someone for rooms they
 * already corrected.
 */
export async function trueUpOne(
  admin: SupabaseClient,
  stripe: Stripe,
  row: ShortfallRow,
  now: Date,
): Promise<TruingOutcome> {
  if (!row.stripe_subscription_id) return { kind: "skipped", reason: "no_subscription" };
  if (!graceExpired(row.room_shortfall_since, now)) return { kind: "skipped", reason: "in_grace" };

  // Nobody is charged more without having been told first, and told about THIS
  // number. If the notice never went out — no email configured, no address on
  // the customer, a Resend outage — the grace period expiring means nothing,
  // because the clock they were supposed to be racing was never shown to them.
  // Waiting costs one billing cycle; not waiting costs the customer.
  if (Number(row.room_shortfall_notified_rooms) !== Number(row.measured_rooms)) {
    return { kind: "skipped", reason: "not_yet_notified" };
  }

  const measured = Number(row.measured_rooms);
  const billed = Number(row.billed_rooms);
  if (!Number.isFinite(measured) || measured <= billed) return { kind: "no_longer_short" };

  // Above the self-serve ceiling there is no bracket to bill against, so this
  // stops and waits for a human rather than inventing a price.
  if (!isBillableRoomCount(measured)) {
    console.error(
      JSON.stringify({ fn: "trueUpOne", hotel: row.hotel_id, measured, max: MAX_ROOMS, action: "needs_manual_pricing" }),
    );
    return { kind: "too_large", measured };
  }

  try {
    const live = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    const item = live.items.data[0];
    if (!item) return { kind: "skipped", reason: "no_subscription_item" };
    if ((item.quantity ?? 0) >= measured) return { kind: "no_longer_short" };

    await stripe.subscriptions.update(
      row.stripe_subscription_id,
      {
        items: [{ id: item.id, quantity: measured }],
        // Charge the difference on the next invoice rather than immediately. The
        // correction is already unwelcome; a same-day charge on top of it is how
        // a fair adjustment becomes a chargeback.
        proration_behavior: "create_prorations",
      },
      // One correction per property per measurement, so an overlapping sweep
      // can't raise the quantity twice.
      { idempotencyKey: `maya_room_truing_${row.hotel_id}_${measured}` },
    );

    // billed_rooms itself is left to the webhook, which is the only writer of
    // what Stripe says is true. This just records that MAYA acted, and stops the
    // clock so the property isn't corrected again on the next pass.
    await admin
      .from("hotel_subscriptions")
      .update({ room_corrected_at: now.toISOString(), room_shortfall_since: null })
      .eq("hotel_id", row.hotel_id);

    console.log(
      JSON.stringify({ fn: "trueUpOne", hotel: row.hotel_id, from: billed, to: measured, corrected: true }),
    );
    return { kind: "corrected", from: billed, to: measured };
  } catch (e) {
    const message = e instanceof Error ? e.message : "truing failed";
    console.error(JSON.stringify({ fn: "trueUpOne", hotel: row.hotel_id, error: message }));
    return { kind: "error", message };
  }
}

export type TruingSummary = {
  examined: number;
  notified: number;
  corrected: number;
  skipped: number;
  failed: number;
  outcomes: { hotelId: string; outcome: TruingOutcome }[];
};

export async function sweepRoomTruing(args: {
  admin: SupabaseClient;
  stripe: Stripe;
  now: Date;
  limit?: number;
}): Promise<TruingSummary & { error?: string }> {
  const { admin, stripe, now, limit } = args;

  // Warnings go out first, and on every pass. A property that becomes short
  // today is warned today and corrected a week later — the two halves are the
  // same sweep so one cron entry drives both, and so a correction can never run
  // in an invocation where its warning did not.
  const { rows: toNotify } = await shortfallsNeedingNotice(admin, limit);
  let notified = 0;
  for (const row of toNotify) {
    const outcome = await notifyOne(admin, stripe, row, now);
    if (outcome.kind === "sent") notified += 1;
    else if (outcome.kind === "error") {
      console.error(JSON.stringify({ fn: "sweepRoomTruing", step: "notify", hotel: row.hotel_id, error: outcome.message }));
    }
  }

  const { rows, error } = await dueForTruing(admin, now, limit);
  if (error) {
    console.error(JSON.stringify({ fn: "sweepRoomTruing", error }));
    return { examined: 0, notified, corrected: 0, skipped: 0, failed: 0, outcomes: [], error };
  }

  const outcomes: TruingSummary["outcomes"] = [];
  for (const row of rows) {
    outcomes.push({ hotelId: row.hotel_id, outcome: await trueUpOne(admin, stripe, row, now) });
  }

  return {
    examined: rows.length,
    notified,
    corrected: outcomes.filter((o) => o.outcome.kind === "corrected").length,
    skipped: outcomes.filter((o) => o.outcome.kind === "skipped" || o.outcome.kind === "no_longer_short").length,
    failed: outcomes.filter((o) => o.outcome.kind === "error" || o.outcome.kind === "too_large").length,
    outcomes,
  };
}
