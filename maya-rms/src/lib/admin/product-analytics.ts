import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The product panel's numbers: every one is a SECURITY DEFINER function in
 * 99_supabase_migration_product_analytics_v1.sql over product_events, and the
 * definitions live in docs/analytics.md. This file only fetches and names
 * them. The page reads them with the service role, kept for a few minutes
 * (analytics-cache.ts), after checking the caller may read analytics; each
 * function's own check (analytics_assert_reader) lets the service role,
 * platform admins and Sales logins past their code through. Test properties
 * and which signup code was used are for the service role and platform
 * admins only (analytics_full_reader), so the page takes the codes out for
 * Sales itself (withoutSignupCodes).
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
  client: SupabaseClient,
  from: string,
  to: string,
  includeTest: boolean,
): Promise<ProductAnalytics> {
  const range = { p_from: from, p_to: to, p_include_test: includeTest };
  const calls = {
    walkedAwaySummary: client.rpc("analytics_walked_away_summary", range),
    walkedAway: client.rpc("analytics_walked_away", range),
    funnel: client.rpc("analytics_funnel", range),
    timeToValue: client.rpc("analytics_time_to_value", range),
    trials: client.rpc("analytics_trial_conversion", range),
    retention: client.rpc("analytics_retention", range),
    cancellations: client.rpc("analytics_cancellations", range),
    acquisition: client.rpc("analytics_acquisition", range),
    events: client.rpc("analytics_event_counts", range),
    health: client.rpc("analytics_pms_health", range),
    groups: client.rpc("analytics_groups", range),
    book: client.rpc("analytics_book", { p_include_test: includeTest }),
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

/**
 * The product numbers without anyone's email: what analytics-cache.ts keeps.
 * The kept copy sits in Next's data cache, which every server shares and
 * which forgets on its own schedule, so the follow-up list's owner emails are
 * left out of it and read fresh on every load (withOwnerEmails).
 */
export function withoutOwnerEmails(product: ProductAnalytics): ProductAnalytics {
  if (!product.available) return product;
  return { ...product, walkedAway: product.walkedAway.map((r) => ({ ...r, owner_email: null })) };
}

/**
 * The follow-up list's owner emails put back, one call to
 * analytics_owner_emails for every owner on the list (a primary key lookup
 * each). Throws when the call fails, so the panel says it could not load
 * rather than calling an owner "no account".
 */
export async function withOwnerEmails(client: SupabaseClient, product: ProductAnalytics): Promise<ProductAnalytics> {
  if (!product.available) return product;
  const ids = [...new Set(product.walkedAway.flatMap((r) => (r.owner_user_id ? [r.owner_user_id] : [])))];
  if (ids.length === 0) return product;
  const { data, error } = await client.rpc("analytics_owner_emails", { p_user_ids: ids });
  if (error) {
    if (isMissingFunction(error)) {
      return { available: false, reason: "Run 99_supabase_migration_command_center_speed_v1.sql to see these." };
    }
    throw new Error(`analytics_owner_emails: ${error.message}`);
  }
  const emailById = new Map(((data ?? []) as { user_id: string; email: string }[]).map((r) => [String(r.user_id), String(r.email)]));
  return {
    ...product,
    walkedAway: product.walkedAway.map((r) => ({ ...r, owner_email: r.owner_user_id ? emailById.get(r.owner_user_id) ?? null : null })),
  };
}

/** What a source says for someone who may not see which signup code was used, as the database says it. */
export const HIDDEN_SIGNUP_CODE = "code";
const NO_SIGNUP_CODE = "(no code)";

/**
 * The product numbers for a reader who may not see signup codes (anyone but
 * a platform admin: a code lets its holder past the waitlist). Each source
 * says "code" where one was used, never which, and rows that then say the
 * same are added up; the event counts keep only the total for redeemed codes.
 * The kept numbers are read with the service role for every reader, so the
 * page does this as it is drawn. The database does the same for a Sales
 * login calling analytics_acquisition or analytics_event_counts itself.
 */
export function withoutSignupCodes(product: ProductAnalytics): ProductAnalytics {
  if (!product.available) return product;
  const bySource = new Map<string, AcquisitionRow>();
  for (const row of product.acquisition) {
    const code = row.code === NO_SIGNUP_CODE ? NO_SIGNUP_CODE : HIDDEN_SIGNUP_CODE;
    const key = JSON.stringify([row.channel, code]);
    const had = bySource.get(key);
    bySource.set(
      key,
      had
        ? {
            ...had,
            subscriptions: had.subscriptions + row.subscriptions,
            trialing_now: had.trialing_now + row.trialing_now,
            paying_now: had.paying_now + row.paying_now,
            lost_now: had.lost_now + row.lost_now,
            billed_rooms: had.billed_rooms + row.billed_rooms,
          }
        : { ...row, code },
    );
  }
  const acquisition = [...bySource.values()].sort(
    (a, b) => b.subscriptions - a.subscriptions || a.channel.localeCompare(b.channel) || a.code.localeCompare(b.code),
  );
  const events = product.events.filter((e) => e.event !== "signup_code.redeemed" || e.detail === "(all)" || e.detail == null);
  return { ...product, acquisition, events };
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
