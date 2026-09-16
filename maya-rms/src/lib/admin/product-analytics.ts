import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The product panel's numbers: every one is a SECURITY DEFINER function in
 * 99_supabase_migration_product_analytics_v1.sql over product_events, and the
 * definitions live in docs/analytics.md. This file only fetches and names
 * them, under the caller's own session, so each function's own platform-admin
 * check is the gate.
 *
 * A deployment can run ahead of its migration. Then the functions are missing,
 * and the panel says so in one line rather than failing the whole page, which
 * also carries the revenue charts that do not depend on any of this.
 */

export type WalkedAwayStage =
  | "connected_never_claimed"
  | "claimed_never_checkout"
  | "checkout_never_subscribed"
  | "trialed_never_paid"
  | "paid_then_left";

export const WALKED_AWAY_STAGES: { stage: WalkedAwayStage; label: string }[] = [
  { stage: "connected_never_claimed", label: "Connected, never claimed" },
  { stage: "claimed_never_checkout", label: "Claimed, never started checkout" },
  { stage: "checkout_never_subscribed", label: "Started checkout, never subscribed" },
  { stage: "trialed_never_paid", label: "Trialed, never paid" },
  { stage: "paid_then_left", label: "Paid, then cancelled or disconnected" },
];

export type WalkedAwaySummaryRow = { sort: number; stage: string; properties: number; deferred: number; in_groups: number };

export type WalkedAwayRow = {
  property_key: string;
  hotel_id: string | null;
  hotel_exists: boolean;
  property_name: string | null;
  pms_type: string | null;
  pms_property_id: string | null;
  connected_at: string;
  connects: number;
  furthest_stage: string;
  outcome: "walked_away" | "in_flight" | "converted";
  walked_away_stage: WalkedAwayStage | null;
  deferred: boolean;
  subscription_status: string | null;
  group_key: string | null;
  group_size: number | null;
  owner_user_id: string | null;
  owner_email: string | null;
  last_activity_at: string;
};

export type FunnelRow = {
  path: "marketplace" | "direct";
  step: number;
  stage: string;
  entered: number;
  pct_of_previous: number | null;
  pct_of_first: number | null;
};

export type TimeToValueRow = { sort: number; step: string; properties: number; median_hours: number | null; p75_hours: number | null };

export type TrialRow = {
  segment: string;
  trials_ended: number;
  converted: number;
  lost: number;
  undecided: number;
  conversion_pct: number | null;
};

export type RetentionRow = {
  paying_at_start: number;
  new_paying: number;
  won_back: number;
  churned: number;
  paying_at_end: number;
  churn_pct: number | null;
  cancel_scheduled: number;
  cancel_withdrawn: number;
  disconnected: number;
  reconnected: number;
  still_disconnected: number;
  rooms_churned: number;
};

export type CancellationRow = {
  kind: string;
  was_paying: boolean;
  reason: string;
  feedback: string;
  properties: number;
  billed_rooms: number;
};

export type AcquisitionRow = {
  channel: string;
  code: string;
  subscriptions: number;
  trialing_now: number;
  paying_now: number;
  lost_now: number;
  billed_rooms: number;
};

export type EventCountRow = {
  event: string;
  detail: string | null;
  occurrences: number;
  properties: number;
  users: number;
  quantity: number | null;
};

export type HealthRow = {
  metric: string;
  occurrences: number;
  properties: number;
  rate_pct: number | null;
  median_minutes: number | null;
  median_rows: number | null;
};

export type GroupRow = {
  group_key: string;
  first_property_name: string | null;
  group_size: number | null;
  connected_at: string;
  properties_connected: number;
  claimed: number;
  subscribed: number;
  deferred_now: number;
  expired_unclaimed: number;
};

export type BookRow = {
  active_properties: number;
  paying: number;
  trialing: number;
  past_due: number;
  internal_plans: number;
  live: number;
  simulating: number;
  billed_rooms_paying: number;
  billed_rooms_trialing: number;
  measured_rooms_active: number;
  awaiting_claim: number;
  expired_awaiting_sweep: number;
  deferred: number;
  mrr_snapshot_day: string | null;
  list_mrr_cents: number | null;
  net_mrr_cents: number | null;
};

export type ProductAnalytics =
  | { available: false; reason: string }
  | {
      available: true;
      walkedAwaySummary: WalkedAwaySummaryRow[];
      walkedAway: WalkedAwayRow[];
      funnel: FunnelRow[];
      timeToValue: TimeToValueRow[];
      trials: TrialRow[];
      retention: RetentionRow | null;
      cancellations: CancellationRow[];
      acquisition: AcquisitionRow[];
      events: EventCountRow[];
      health: HealthRow[];
      groups: GroupRow[];
      book: BookRow | null;
    };

/** PostgREST's "no such function", which is what an unmigrated database answers. */
export function isMissingFunction(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");
}

export async function loadProductAnalytics(
  ssr: SupabaseClient,
  from: string,
  to: string,
  includeTest: boolean,
): Promise<ProductAnalytics> {
  const range = { p_from: from, p_to: to, p_include_test: includeTest };
  const calls = {
    walkedAwaySummary: ssr.rpc("analytics_walked_away_summary", range),
    walkedAway: ssr.rpc("analytics_walked_away", range),
    funnel: ssr.rpc("analytics_funnel", range),
    timeToValue: ssr.rpc("analytics_time_to_value", range),
    trials: ssr.rpc("analytics_trial_conversion", range),
    retention: ssr.rpc("analytics_retention", range),
    cancellations: ssr.rpc("analytics_cancellations", range),
    acquisition: ssr.rpc("analytics_acquisition", range),
    events: ssr.rpc("analytics_event_counts", range),
    health: ssr.rpc("analytics_pms_health", range),
    groups: ssr.rpc("analytics_groups", range),
    book: ssr.rpc("analytics_book", { p_include_test: includeTest }),
  };
  const keys = Object.keys(calls) as (keyof typeof calls)[];
  const results = await Promise.all(keys.map((k) => calls[k]));

  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const [i, key] of keys.entries()) {
    const { data, error } = results[i];
    if (error) {
      if (isMissingFunction(error)) {
        return { available: false, reason: "Run 99_supabase_migration_product_events_v1.sql and 99_supabase_migration_product_analytics_v1.sql to see these." };
      }
      throw new Error(`${key}: ${error.message}`);
    }
    rows[key] = (data ?? []) as Record<string, unknown>[];
  }

  return {
    available: true,
    walkedAwaySummary: rows.walkedAwaySummary as WalkedAwaySummaryRow[],
    walkedAway: rows.walkedAway as unknown as WalkedAwayRow[],
    funnel: rows.funnel as unknown as FunnelRow[],
    timeToValue: rows.timeToValue as TimeToValueRow[],
    trials: rows.trials as TrialRow[],
    retention: (rows.retention[0] as RetentionRow | undefined) ?? null,
    cancellations: rows.cancellations as unknown as CancellationRow[],
    acquisition: rows.acquisition as unknown as AcquisitionRow[],
    events: rows.events as unknown as EventCountRow[],
    health: rows.health as unknown as HealthRow[],
    groups: rows.groups as unknown as GroupRow[],
    book: (rows.book[0] as BookRow | undefined) ?? null,
  };
}

/** "3.5h", "2.1d": hours read badly past two days, days read badly under one. */
export function formatDuration(value: number | string | null | undefined): string {
  // Postgres numerics can arrive as strings depending on the client.
  const hours = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(hours)) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

/** The ISO week (Monday to Sunday, UTC) containing a day, as inclusive YYYY-MM-DD strings. */
export function isoWeek(day: string): { from: string; to: string } {
  const d = new Date(`${day}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - offset * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

/**
 * One count out of the long event list, zeros when the event never happened.
 * With no detail it reads the event's '(all)' row, which counts distinct
 * properties across every detail rather than adding them up.
 */
export function countOf(events: EventCountRow[], event: string, detail?: string) {
  const hit = events.find((e) => e.event === event && e.detail === (detail ?? "(all)"));
  return { occurrences: hit?.occurrences ?? 0, properties: hit?.properties ?? 0, quantity: hit?.quantity ?? 0 };
}
