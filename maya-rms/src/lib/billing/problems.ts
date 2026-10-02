/**
 * Billing problems a person has to act on, and the billing jobs' heartbeats.
 *
 * Both are rows in platform_audit_events, written with the service role:
 *
 *   billing.problem  one per occurrence, entity_id = the problem's key. The
 *                    billing watchdog (billing_watchdog(), run by pg_cron every
 *                    15 minutes; 99_supabase_migration_billing_watchdog_v1.sql)
 *                    posts each key to the alert channel, at most once per 6
 *                    hours, through the same Slack webhook as every other alert
 *                    (the Vault secret maya_alert_webhook).
 *   billing.sweep    one per run of a billing job (card check, room-count
 *                    truing, the nightly Stripe check), entity_id = the job.
 *                    The watchdog says so when one has not run for too long,
 *                    which is the only way to hear about a job that never
 *                    starts: a missing BILLING_CRON_SECRET, a cron that was
 *                    never scheduled, an app that is down.
 *
 * The app writes rows rather than posting itself because the app does not
 * hold the alert address (it lives in the function secrets and Vault), and a
 * webhook handler must not wait on Slack. A write is one insert.
 *
 * Neither function ever throws: a billing path that failed over its own alarm
 * would be worse than the silence this replaces.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const BILLING_PROBLEM_EVENT = "billing.problem";
export const BILLING_SWEEP_EVENT = "billing.sweep";

/** The billing jobs the watchdog expects to hear from. */
export type BillingJob = "card-reverify" | "room-truing" | "stripe-reconcile";

export type BillingProblem = {
  /** Stable identity: one alert line per key per 6 hours. */
  key: string;
  title: string;
  detail: string;
  hotelId?: string | null;
  /** Critical reaches the channel by default; warn only when the watchdog is told to send warnings. */
  severity?: "critical" | "warn";
};

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Newest row of one kind and key, or null; throws on a failed read. */
async function newest(
  admin: SupabaseClient,
  eventType: string,
  key: string,
): Promise<{ created_at: string; detail: Record<string, unknown> } | null> {
  const { data, error } = await admin
    .from("platform_audit_events")
    .select("created_at, detail")
    .eq("event_type", eventType)
    .eq("entity_id", key)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as { created_at?: unknown; detail?: unknown } | undefined;
  if (!row?.created_at) return null;
  return { created_at: String(row.created_at), detail: (row.detail ?? {}) as Record<string, unknown> };
}

async function logEvent(
  admin: SupabaseClient,
  eventType: string,
  entityType: string,
  key: string,
  hotelId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  const write = (hotel: string | null) =>
    admin.rpc("platform_log_event", {
      p_event_type: eventType,
      p_entity_type: entityType,
      p_entity_id: key,
      ...(hotel ? { p_hotel_id: hotel } : {}),
      p_detail: detail,
    });
  let { error } = await write(hotelId);
  // A hotel that is gone (or an id from Stripe metadata that never was one)
  // fails the foreign key. The problem still needs a person, so the id rides
  // in the detail instead.
  if (error && hotelId && error.code === "23503") ({ error } = await write(null));
  if (error) throw new Error(error.message);
}

/**
 * Hand a problem to a person. `quietForMs` skips the write when the same key
 * was written that recently, for a condition a sweep finds on every run.
 */
export async function recordBillingProblem(
  admin: SupabaseClient,
  problem: BillingProblem,
  opts: { quietForMs?: number; now?: Date } = {},
): Promise<{ recorded: boolean }> {
  try {
    const now = opts.now ?? new Date();
    if (opts.quietForMs) {
      const last = await newest(admin, BILLING_PROBLEM_EVENT, problem.key);
      if (last && now.getTime() - Date.parse(last.created_at) < opts.quietForMs) return { recorded: false };
    }
    await logEvent(admin, BILLING_PROBLEM_EVENT, "billing", problem.key, problem.hotelId ?? null, {
      severity: problem.severity ?? "critical",
      title: problem.title,
      detail: problem.detail,
      ...(problem.hotelId ? { hotel_id: problem.hotelId } : {}),
    });
    return { recorded: true };
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "recordBillingProblem",
        key: problem.key,
        title: problem.title,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return { recorded: false };
  }
}

/**
 * Say a billing job ran, with its counts. `everyMs` skips the write when the
 * job already said so that recently (the card check runs every 15 minutes;
 * the watchdog only needs to know it is still running).
 */
export async function recordBillingSweep(
  admin: SupabaseClient,
  job: BillingJob,
  detail: Record<string, unknown>,
  opts: { everyMs?: number; now?: Date } = {},
): Promise<{ recorded: boolean }> {
  try {
    const now = opts.now ?? new Date();
    if (opts.everyMs) {
      const last = await newest(admin, BILLING_SWEEP_EVENT, job);
      if (last && now.getTime() - Date.parse(last.created_at) < opts.everyMs) return { recorded: false };
    }
    await logEvent(admin, BILLING_SWEEP_EVENT, "billing_job", job, null, { job, ...detail });
    return { recorded: true };
  } catch (e) {
    console.error(
      JSON.stringify({ fn: "recordBillingSweep", job, error: e instanceof Error ? e.message : String(e) }),
    );
    return { recorded: false };
  }
}

/** What a job said on its last run, or null (never ran, or the read failed). */
export async function lastBillingSweep(
  admin: SupabaseClient,
  job: BillingJob,
): Promise<{ at: string; detail: Record<string, unknown> } | null> {
  try {
    const last = await newest(admin, BILLING_SWEEP_EVENT, job);
    return last ? { at: last.created_at, detail: last.detail } : null;
  } catch {
    return null;
  }
}
