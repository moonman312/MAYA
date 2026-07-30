import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { graceExpired, ROOM_SHORTFALL_GRACE_DAYS } from "./room-count";
import { isBillableRoomCount, MAX_ROOMS } from "./tiers";

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
  stripe_subscription_id: string | null;
  billed_rooms: number | null;
  measured_rooms: number | null;
  room_shortfall_since: string | null;
};

const SELECT_COLUMNS =
  "hotel_id, stripe_subscription_id, billed_rooms, measured_rooms, room_shortfall_since";

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
  const { rows, error } = await dueForTruing(admin, now, limit);
  if (error) {
    console.error(JSON.stringify({ fn: "sweepRoomTruing", error }));
    return { examined: 0, corrected: 0, skipped: 0, failed: 0, outcomes: [], error };
  }

  const outcomes: TruingSummary["outcomes"] = [];
  for (const row of rows) {
    outcomes.push({ hotelId: row.hotel_id, outcome: await trueUpOne(admin, stripe, row, now) });
  }

  return {
    examined: rows.length,
    corrected: outcomes.filter((o) => o.outcome.kind === "corrected").length,
    skipped: outcomes.filter((o) => o.outcome.kind === "skipped" || o.outcome.kind === "no_longer_short").length,
    failed: outcomes.filter((o) => o.outcome.kind === "error" || o.outcome.kind === "too_large").length,
    outcomes,
  };
}
