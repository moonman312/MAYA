import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatUsd, priceCents, type BillingInterval } from "@/lib/billing/tiers";

/**
 * The triage desk behind /admin/stalled-signups.
 *
 * A stalled signup is a property that paid and then never finished setting up.
 * They don't file tickets — nobody complains about a tool they forgot they bought
 * — so the only way this surfaces before a chargeback is someone going to look.
 *
 * The list itself is one SECURITY DEFINER call (platform_list_stalled_signups):
 * the useful version needs the admin's email and whether it was ever confirmed,
 * which lives in auth.users and isn't reachable any other way. Everything in this
 * file is the part that turns those columns into a decision — which is the whole
 * point, because a table of raw timestamps is not a triage list.
 */

/** Which step they never got past. Extends the flow in lib/onboarding/step.ts. */
export type StallStage =
  | "payment_incomplete"
  | "no_pms"
  | "import_failed"
  | "import_stuck"
  | "no_path"
  | "review_pending";

export type StalledSignupRow = {
  hotel_id: string;
  hotel_name: string | null;
  stage: StallStage;
  stuck_since: string;
  stuck_hours: number;
  admin_email: string | null;
  admin_name: string | null;
  email_confirmed: boolean;
  last_sign_in_at: string | null;
  status: string;
  billing_interval: BillingInterval;
  billed_rooms: number;
  trial_end: string | null;
  current_period_end: string | null;
  periods_billed: number;
  card_verify_failed_at: string | null;
  card_verify_last_code: string | null;
  signup_code: string | null;
  pms_type: string | null;
  pms_status: string | null;
  import_status: string | null;
  import_phase: string | null;
  import_error: string | null;
  rooms_measured: number | null;
  signup_abandoned_at: string | null;
  signup_abandoned_note: string | null;
  created_at: string;
};

/**
 * How bad it is, which is not the same as how long it has been.
 *
 * `burning` is the one that matters: money has actually been taken for a product
 * they have never used, and every further period is more to argue about. A trial
 * that stalls costs nothing yet, so it is a nudge, not a problem — the whole
 * reason the activation email exists is to catch those before they get here.
 */
export type StallSeverity = "burning" | "warming" | "nudge" | "dead_card";

export type TriagedSignup = StalledSignupRow & {
  severity: StallSeverity;
  /** What is wrong, in the words you'd use to a colleague. */
  headline: string;
  /** The one thing to do about it. */
  action: string;
  monthly_cents: number;
  /** Money taken so far for nothing, as far as the billing period can tell. */
  spent_cents: number;
  /** Whether emailing them could actually reach anybody. */
  reachable: boolean;
};

const STAGE_HEADLINES: Record<StallStage, string> = {
  payment_incomplete: "Checkout never completed",
  no_pms: "Paid, never connected a PMS",
  import_failed: "The history import failed",
  import_stuck: "The history import stopped moving",
  no_path: "Connected, never chose how to start",
  review_pending: "Never finished reviewing the findings",
};

const STAGE_ACTIONS: Record<StallStage, string> = {
  payment_incomplete: "Nothing to chase — Stripe never took the money. Check for a stuck 3-D Secure.",
  no_pms: "Email them the connect link. This is the one that turns into a refund request.",
  import_failed: "Read the error first — if it's ours, they're waiting on us, not the reverse.",
  import_stuck: "Check the worker cron is running before you email anybody.",
  no_path: "One click from useful. Worth a two-line email.",
  review_pending: "Their rules are waiting on a confirmation they don't know about.",
};

/**
 * Whether an email would land. An unconfirmed address is usually a typo, which is
 * its own explanation for the silence — and a reason to look it up in Stripe,
 * where the address they gave the card is.
 */
export function isReachable(row: Pick<StalledSignupRow, "admin_email" | "email_confirmed">): boolean {
  return Boolean(row.admin_email) && row.email_confirmed;
}

/**
 * Monthly value, so a signup can be ranked by what it is worth rather than by
 * when it happened. Annual is divided back down to compare against monthly.
 */
export function monthlyCents(row: Pick<StalledSignupRow, "billed_rooms" | "billing_interval">): number {
  const cents = priceCents(row.billed_rooms, row.billing_interval);
  return row.billing_interval === "year" ? Math.round(cents / 12) : cents;
}

/**
 * What they have actually been charged, best effort.
 *
 * periods_billed comes off the billing period rather than Stripe's invoice list,
 * so this is an estimate and the UI says so. It is still the number that decides
 * whether an email is overdue or premature, which no exact figure elsewhere does.
 */
export function spentCents(row: Pick<StalledSignupRow, "billed_rooms" | "billing_interval" | "periods_billed">): number {
  return priceCents(row.billed_rooms, row.billing_interval) * Math.max(0, row.periods_billed);
}

export function severityOf(row: StalledSignupRow): StallSeverity {
  // A dead card outranks everything: they are not ignoring us, they are already
  // gone, and the email to send is about the card, not about setup.
  if (row.card_verify_failed_at) return "dead_card";
  // Nothing was ever collected, so there is nothing to give back.
  if (row.stage === "payment_incomplete") return "nudge";
  if (row.status === "trialing" || row.periods_billed < 1) return "nudge";
  if (row.periods_billed >= 2) return "burning";
  return "warming";
}

export function triage(row: StalledSignupRow): TriagedSignup {
  const severity = severityOf(row);
  return {
    ...row,
    severity,
    headline: STAGE_HEADLINES[row.stage] ?? row.stage,
    action:
      severity === "dead_card"
        ? "Their card stopped working too. Sort that out before anything about setup."
        : (STAGE_ACTIONS[row.stage] ?? "Take a look."),
    monthly_cents: monthlyCents(row),
    spent_cents: severity === "nudge" ? 0 : spentCents(row),
    reachable: isReachable(row),
  };
}

export type StallTotals = {
  count: number;
  /** Signups that have been charged for a product they have never used. */
  burning: number;
  /** Everything taken from those, so far. */
  spent_cents: number;
  monthly_cents: number;
  unreachable: number;
};

export function rollUp(rows: TriagedSignup[]): StallTotals {
  return {
    count: rows.length,
    burning: rows.filter((r) => r.severity === "burning").length,
    spent_cents: rows.reduce((sum, r) => sum + r.spent_cents, 0),
    monthly_cents: rows.reduce((sum, r) => sum + r.monthly_cents, 0),
    unreachable: rows.filter((r) => !r.reachable).length,
  };
}

/** One line for the top of the page, so the number is read before the table. */
export function summarize(totals: StallTotals): string {
  if (totals.count === 0) return "Nobody is stuck. Everyone who paid got set up.";
  const parts = [
    `${totals.count} propert${totals.count === 1 ? "y" : "ies"} paid and never finished`,
  ];
  if (totals.burning > 0) {
    parts.push(
      `${totals.burning} of them charged at least twice — about ${formatUsd(totals.spent_cents)} taken for nothing`,
    );
  }
  if (totals.unreachable > 0) {
    parts.push(`${totals.unreachable} with no confirmed email to reach`);
  }
  return parts.join(". ") + ".";
}

/** How long they have been sitting there, at the resolution that reads best. */
export function stuckFor(hours: number): string {
  if (hours < 48) return `${Math.max(1, Math.round(hours))}h`;
  const days = Math.round(hours / 24);
  if (days < 21) return `${days} days`;
  const weeks = Math.round(days / 7);
  return weeks < 9 ? `${weeks} weeks` : `${Math.round(days / 30)} months`;
}

export type StallWindow = 24 | 72 | 168;

export const MISSING_MIGRATION =
  "Run 99_supabase_migration_stalled_signups_v1.sql — this list needs the platform_list_stalled_signups function.";

/**
 * Reads under the caller's own session. The RPC re-checks is_platform_admin, so
 * the database is what decides who sees other people's email addresses — a
 * regression in a route guard still hits a closed door.
 */
export async function listStalledSignups(
  ssr: SupabaseClient,
  opts: { minHours?: StallWindow; includeAbandoned?: boolean } = {},
): Promise<TriagedSignup[]> {
  const { data, error } = await ssr.rpc("platform_list_stalled_signups", {
    p_min_hours: opts.minHours ?? 24,
    p_include_abandoned: opts.includeAbandoned ?? false,
  });
  if (error) {
    // PGRST202 is PostgREST not finding the function. Deploying the page before
    // running the migration is the likeliest way anyone meets this screen, and a
    // stack trace does not tell them which file to run.
    if (error.code === "PGRST202") throw new Error(MISSING_MIGRATION);
    throw new Error(`platform_list_stalled_signups: ${error.message}`);
  }

  const rows = ((data ?? []) as StalledSignupRow[]).map(triage);
  // The RPC orders by how long they've been stuck, which is the right tiebreak
  // but the wrong first key: a property two payments deep matters more than one
  // that has been sitting on the choice screen since last week for free.
  const rank: Record<StallSeverity, number> = { burning: 0, dead_card: 1, warming: 2, nudge: 3 };
  return rows.sort((a, b) => rank[a.severity] - rank[b.severity] || b.stuck_hours - a.stuck_hours);
}

export async function flagSignupAbandoned(
  ssr: SupabaseClient,
  hotelId: string,
  abandoned: boolean,
  note?: string | null,
): Promise<void> {
  const { error } = await ssr.rpc("platform_flag_signup_abandoned", {
    p_hotel_id: hotelId,
    p_abandoned: abandoned,
    p_note: note ?? null,
  });
  if (error) throw new Error(`platform_flag_signup_abandoned: ${error.message}`);
}
