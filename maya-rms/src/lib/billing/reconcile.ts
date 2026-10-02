import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterSubscriptionSaved } from "./after-save";
import { isEntitledStatus } from "./entitlement";
import { HOUR_MS, lastBillingSweep, recordBillingProblem, recordBillingSweep } from "./problems";
import { persistSubscription, projectSubscription, type SubscriptionProjection } from "./sync";

/**
 * The nightly Stripe check: MAYA's copy of every subscription, re-read from
 * Stripe and corrected.
 *
 * Stripe's messages (the webhook) are the only thing that keeps
 * hotel_subscriptions current. If they stop arriving (a signing secret
 * changed in Stripe and not in the app, the endpoint disabled, the app down
 * for longer than Stripe retries), a customer who cancelled is still priced,
 * one whose card finally failed is still served, and a new customer is only
 * switched on if they come back through the checkout page. This puts each one
 * right within a day, and says so to a person, because a difference means the
 * messages are not getting through.
 *
 * Two passes, both on the same rules as the webhook (projectSubscription,
 * persistSubscription and afterSubscriptionSaved, so this can never record
 * something the webhook would not):
 *
 *   1. Subscriptions created in Stripe in the last RECENT_DAYS days that MAYA
 *      has no record of and that are live: a signup whose messages were lost.
 *   2. Every subscription on record that is not over (canceled and
 *      incomplete_expired never change again), re-read and compared. A
 *      different status, room count, period or cancellation is corrected; a
 *      change of dates alone is corrected quietly (a renewal can land between
 *      Stripe's message and this read), anything else is a billing problem.
 *
 * Bounded by time rather than count: a run stops starting new reads after
 * BUDGET_MS and the next run carries on after the last property it reached
 * (the cursor rides on its billing.sweep row), so every subscription is
 * reached however many there are.
 */

export const RECONCILE_BUDGET_MS = 45_000;
export const RECONCILE_RECENT_DAYS = 3;
const TERMINAL = new Set(["canceled", "incomplete_expired"]);
const MAX_RECENT_PAGES = 5;

const COLUMNS =
  "hotel_id, stripe_customer_id, stripe_subscription_id, status, billing_interval, billed_rooms, current_period_end, trial_end, cancel_at_period_end";

type RecordedRow = {
  hotel_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string | null;
  billing_interval: string | null;
  billed_rooms: number | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean | null;
};

export type ReconcileResult = {
  /** Subscriptions on record re-read from Stripe this run. */
  examined: number;
  matched: number;
  /** Rows corrected from Stripe (dates only, or more). */
  corrected: number;
  /** Live subscriptions Stripe had that MAYA had no record of, now recorded. */
  recovered: number;
  failed: number;
  /** Stopped at the time budget; the next run carries on from the cursor. */
  partial: boolean;
  /** Corrections a person was told about. */
  differences: { hotelId: string; changes: string[] }[];
  errors: string[];
};

const iso = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** What differs between the row and Stripe's projection: [what matters, dates only]. */
export function differences(row: RecordedRow, fresh: SubscriptionProjection): { important: string[]; dates: string[] } {
  const important: string[] = [];
  const dates: string[] = [];
  if (row.stripe_subscription_id !== fresh.stripe_subscription_id) {
    important.push(`subscription ${row.stripe_subscription_id ?? "none"} → ${fresh.stripe_subscription_id}`);
  }
  if (row.status !== fresh.status) important.push(`status ${row.status ?? "none"} → ${fresh.status}`);
  if (Number(row.billed_rooms ?? 0) !== fresh.billed_rooms) important.push(`rooms ${row.billed_rooms ?? 0} → ${fresh.billed_rooms}`);
  if ((row.billing_interval ?? null) !== fresh.billing_interval) {
    important.push(`billed ${row.billing_interval ?? "none"} → ${fresh.billing_interval}`);
  }
  if (Boolean(row.cancel_at_period_end) !== fresh.cancel_at_period_end) {
    important.push(fresh.cancel_at_period_end ? "now set to cancel" : "no longer set to cancel");
  }
  if (iso(row.current_period_end) !== iso(fresh.current_period_end)) dates.push("period end");
  if (iso(row.trial_end) !== iso(fresh.trial_end)) dates.push("trial end");
  return { important, dates };
}

/** Everything on record for Stripe-billed properties, by hotel; throws on a failed read. */
async function recordedRows(admin: SupabaseClient): Promise<RecordedRow[]> {
  const { data, error } = await admin
    .from("hotel_subscriptions")
    .select(COLUMNS)
    .eq("plan_kind", "stripe")
    .order("hotel_id", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as RecordedRow[];
}

async function recentSubscriptions(stripe: Stripe, now: Date): Promise<Stripe.Subscription[]> {
  const out: Stripe.Subscription[] = [];
  const gte = Math.floor((now.getTime() - RECONCILE_RECENT_DAYS * 86_400_000) / 1000);
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_RECENT_PAGES; page += 1) {
    const list = await stripe.subscriptions.list({
      status: "all",
      created: { gte },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...list.data);
    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return out;
}

export async function sweepStripeReconcile(opts: {
  admin: SupabaseClient;
  stripe: Stripe;
  now?: Date;
  budgetMs?: number;
  /** For tests: the clock the budget is measured on. */
  clock?: () => number;
}): Promise<ReconcileResult> {
  const { admin, stripe } = opts;
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budget = opts.budgetMs ?? RECONCILE_BUDGET_MS;
  const result: ReconcileResult = {
    examined: 0,
    matched: 0,
    corrected: 0,
    recovered: 0,
    failed: 0,
    partial: false,
    differences: [],
    errors: [],
  };

  let rows: RecordedRow[];
  try {
    rows = await recordedRows(admin);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result.errors.push(message);
    console.error(JSON.stringify({ fn: "stripeReconcile", step: "read_rows", error: message }));
    await recordBillingProblem(
      admin,
      {
        key: "billing-sweep-failed:stripe-reconcile",
        title: "The nightly Stripe check cannot read MAYA's subscriptions",
        detail: `Reading hotel_subscriptions failed: ${message}. Nothing was checked against Stripe.`,
      },
      { quietForMs: 6 * HOUR_MS, now },
    );
    await recordBillingSweep(admin, "stripe-reconcile", { examined: 0, error: message }, { now });
    return result;
  }

  const onRecord = new Set(rows.map((r) => r.stripe_subscription_id).filter((id): id is string => Boolean(id)));

  // A difference: corrected, followed up like a webhook would, and told.
  const apply = async (
    fresh: Stripe.Subscription,
    projection: SubscriptionProjection,
    changes: string[],
    hotelId: string,
  ): Promise<boolean> => {
    const saved = await persistSubscription(admin, projection);
    if (!saved.ok) {
      result.failed += 1;
      result.errors.push(`${hotelId}: ${saved.error}`);
      return false;
    }
    await afterSubscriptionSaved(admin, stripe, fresh, projection);
    if (changes.length > 0) result.differences.push({ hotelId, changes });
    return true;
  };

  // 1. Live subscriptions Stripe has and MAYA does not.
  try {
    for (const sub of await recentSubscriptions(stripe, now)) {
      if (onRecord.has(sub.id) || !isEntitledStatus(sub.status)) continue;
      const projection = projectSubscription(sub);
      // Made outside our checkout, or a quantity of 0: the webhook skips these too.
      if (!projection || projection.billed_rooms < 1) continue;
      const known = rows.find((r) => r.hotel_id === projection.hotel_id);
      if (known?.stripe_subscription_id && isEntitledStatus(String(known.status))) {
        // Two live subscriptions on one property, and the one on record is
        // live too. Recording this one would swap the row every night; the
        // double charge is what a person has to sort out.
        await recordBillingProblem(
          admin,
          {
            key: `billing-duplicate-subscription:${projection.hotel_id}`,
            hotelId: projection.hotel_id,
            title: "Two live subscriptions on one property",
            detail:
              `Stripe has ${sub.id} (${sub.status}) and ${known.stripe_subscription_id} (${known.status}) live for ` +
              `this property, and MAYA follows ${known.stripe_subscription_id}. One of them is a double charge: ` +
              "cancel and refund it in Stripe.",
          },
          { quietForMs: 6 * HOUR_MS, now },
        );
        continue;
      }
      const changes = [
        known?.stripe_subscription_id
          ? `a live subscription ${sub.id} in place of the one on record (${known.stripe_subscription_id}, ${known.status})`
          : `a live subscription ${sub.id} MAYA had no record of`,
      ];
      if (await apply(sub, projection, changes, projection.hotel_id)) {
        result.recovered += 1;
        onRecord.add(sub.id);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result.failed += 1;
    result.errors.push(`recent: ${message}`);
  }

  // 2. Everything on record that can still change, from where the last run stopped.
  const open = rows.filter((r) => r.stripe_subscription_id && !TERMINAL.has(String(r.status)));
  const cursor = (await lastBillingSweep(admin, "stripe-reconcile"))?.detail?.cursor;
  const from = typeof cursor === "string" ? open.findIndex((r) => r.hotel_id > cursor) : 0;
  const ordered = from > 0 ? [...open.slice(from), ...open.slice(0, from)] : open;
  let reached: string | null = null;

  for (const row of ordered) {
    if (clock() - started > budget) {
      result.partial = true;
      break;
    }
    result.examined += 1;
    reached = row.hotel_id;
    try {
      const fresh = await stripe.subscriptions.retrieve(String(row.stripe_subscription_id));
      const projection = projectSubscription(fresh);
      if (!projection) {
        // No hotel on it in Stripe any more (metadata edited by hand).
        result.failed += 1;
        result.errors.push(`${row.hotel_id}: ${fresh.id} has no hotel_id in Stripe`);
        continue;
      }
      const { important, dates } = differences(row, projection);
      if (important.length === 0 && dates.length === 0) {
        result.matched += 1;
        continue;
      }
      if (await apply(fresh, projection, important, row.hotel_id)) result.corrected += 1;
      if (important.length === 0) {
        console.log(JSON.stringify({ fn: "stripeReconcile", hotel: row.hotel_id, corrected: dates }));
      }
    } catch (e) {
      result.failed += 1;
      result.errors.push(`${row.hotel_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // A person hears about every difference that mattered, one line per
  // property, and about failures once per run.
  for (const d of result.differences) {
    await recordBillingProblem(
      admin,
      {
        key: `billing-drift:${d.hotelId}`,
        hotelId: d.hotelId,
        title: "MAYA's copy of a subscription was out of date",
        detail:
          `Corrected from Stripe: ${d.changes.join("; ")}. Stripe's messages may not be reaching MAYA: check the ` +
          "endpoint in Stripe (Developers, Webhooks) for failed deliveries, and STRIPE_WEBHOOK_SECRET in the app.",
      },
      { quietForMs: 6 * HOUR_MS, now },
    );
  }
  if (result.failed > 0) {
    await recordBillingProblem(
      admin,
      {
        key: "billing-reconcile-failed",
        title: "The nightly Stripe check could not check every subscription",
        detail:
          `${result.failed} could not be checked. First: ${result.errors[0] ?? "unknown"}. ` +
          "If every one failed, check STRIPE_SECRET_KEY in the app.",
      },
      { quietForMs: 6 * HOUR_MS, now },
    );
  }

  const summary = {
    examined: result.examined,
    matched: result.matched,
    corrected: result.corrected,
    recovered: result.recovered,
    failed: result.failed,
    differences: result.differences.length,
    partial: result.partial,
    // Where the next run starts; null once a run reached everything.
    cursor: result.partial ? reached : null,
  };
  console.log(JSON.stringify({ fn: "stripeReconcile", ...summary }));
  await recordBillingSweep(admin, "stripe-reconcile", summary, { now });
  return result;
}
