import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPaidLiveHotel } from "@/lib/billing/entitlement";

/**
 * A Marketplace property's history import, from the claim to the payment.
 *
 * The import starts when the owner claims the property, not when they pay:
 * reading is what makes MAYA useful the moment they arrive, and by the time
 * they are back from the card form the work is done. It is queued for the one
 * property the owner is about to be shown, so a group grant imports each
 * sibling as it comes up on the subscribe screen rather than all at once, and
 * never one the owner has said "Not now" to. An anonymous Marketplace connect
 * that nobody claims is never imported.
 *
 * Nothing here makes a property live. Its connection stays 'pending' and the
 * hotel stays parked, so the scheduled syncs, rate pushes and the engine keep
 * leaving it alone until a subscription lands. Payment then adopts whatever
 * job exists instead of starting a second one.
 *
 * The queue itself (99_supabase_migration_import_at_claim_v1.sql) runs paid
 * jobs first and one unpaid job per owner at a time, and both it and the
 * worker cancel a job whose property disconnected, was put off, or lost its
 * claim. A canceled job keeps its checkpoint; the helpers below re-queue it
 * where that reason goes away.
 */

type JobRow = { id: string; status: string; stats: Record<string, unknown> | null };

const ACTIVE = new Set(["queued", "running"]);

/**
 * The job a property's import hangs off: the one in flight if there is one,
 * otherwise the newest. uq_import_jobs_one_active_per_hotel allows at most
 * one in flight, so "in flight" is never ambiguous.
 */
async function currentJob(admin: SupabaseClient, hotelId: string): Promise<JobRow | null> {
  const { data, error } = await admin
    .from("import_jobs")
    .select("id, status, stats, created_at")
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Could not read import jobs: ${error.message}`);
  const rows = (data ?? []).map((r) => ({
    id: String(r.id),
    status: String(r.status),
    stats: (r.stats as Record<string, unknown> | null) ?? null,
  }));
  return rows.find((r) => ACTIVE.has(r.status)) ?? rows[0] ?? null;
}

/** Postgres unique_violation, as PostgREST passes it through. */
function isDuplicate(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === "23505" || /duplicate key/i.test(error.message ?? "")));
}

/**
 * Back into the queue from where it stopped. The error streak is reset so a
 * job that failed on a dead grant gets a full run of retries on the new one.
 * Returns false when the row was no longer in that state.
 */
async function requeue(admin: SupabaseClient, job: JobRow): Promise<boolean> {
  const { data, error } = await admin
    .from("import_jobs")
    .update({
      status: "queued",
      finished_at: null,
      last_error: null,
      lease_expires_at: null,
      stats: { ...(job.stats ?? {}), errorStreak: 0 },
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("status", job.status)
    .select("id");
  if (error) {
    if (isDuplicate(error)) return false;
    throw new Error(`Could not re-queue the import: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

export type PrePaymentQueueResult =
  | { queued: true; jobId: string; resumed: boolean }
  | {
      queued: false;
      reason:
        | "not_found"
        | "live"
        | "deferred"
        | "not_claimed"
        | "no_connection"
        | "disconnected"
        | "in_flight"
        | "imported"
        | "failed_before";
      jobId?: string;
    };

/**
 * Queue the import for an owned, unpaid Marketplace property the owner is
 * being shown. Safe to call on every render of the subscribe screen: a job in
 * flight or finished is left alone, and one that failed waits for payment
 * rather than spending the property's API allowance again for someone who has
 * not paid.
 */
export async function queuePrePaymentImport(
  admin: SupabaseClient,
  hotelId: string,
  requestedBy: string | null,
): Promise<PrePaymentQueueResult> {
  let hotelRes = await admin
    .from("hotels")
    .select("id, is_active, setup_deferred_at")
    .eq("id", hotelId)
    .maybeSingle();
  if (hotelRes.error && (hotelRes.error.code === "42703" || /setup_deferred_at/.test(hotelRes.error.message))) {
    // Ahead of the "Not now" migration nothing can be deferred.
    hotelRes = await admin.from("hotels").select("id, is_active").eq("id", hotelId).maybeSingle();
  }
  if (hotelRes.error) throw new Error(`Could not read the property: ${hotelRes.error.message}`);
  const hotel = hotelRes.data as { is_active?: boolean; setup_deferred_at?: string | null } | null;
  if (!hotel) return { queued: false, reason: "not_found" };
  // Activation owns a paid property's import. A trial that ended unpaid is
  // still is_active, and is imported like any other unpaid property.
  if (await isPaidLiveHotel(admin, hotelId, hotel.is_active)) return { queued: false, reason: "live" };
  if (hotel.setup_deferred_at) return { queued: false, reason: "deferred" };

  const { data: claim, error: claimErr } = await admin
    .from("pms_marketplace_claims")
    .select("pms_type")
    .eq("hotel_id", hotelId)
    .not("claimed_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (claimErr) throw new Error(`Could not read Marketplace claims: ${claimErr.message}`);
  // Flow B's placeholder has the same parked shape and no PMS behind it yet.
  if (!claim) return { queued: false, reason: "not_claimed" };
  const pmsType = String(claim.pms_type);

  const { data: conn, error: connErr } = await admin
    .from("pms_connections")
    .select("status")
    .eq("hotel_id", hotelId)
    .eq("pms_type", pmsType)
    .maybeSingle();
  if (connErr) throw new Error(`Could not read the PMS connection: ${connErr.message}`);
  if (!conn) return { queued: false, reason: "no_connection" };
  if (String(conn.status) === "disconnected") return { queued: false, reason: "disconnected" };

  const job = await currentJob(admin, hotelId);
  if (job && ACTIVE.has(job.status)) return { queued: false, reason: "in_flight", jobId: job.id };
  if (job?.status === "completed") return { queued: false, reason: "imported", jobId: job.id };
  if (job?.status === "failed") return { queued: false, reason: "failed_before", jobId: job.id };

  if (job?.status === "canceled") {
    if (await requeue(admin, job)) {
      kickImportWorker();
      return { queued: true, jobId: job.id, resumed: true };
    }
    const now = await currentJob(admin, hotelId);
    return { queued: false, reason: "in_flight", jobId: now?.id ?? job.id };
  }

  const { data: inserted, error: insertErr } = await admin
    .from("import_jobs")
    .insert({ hotel_id: hotelId, pms_type: pmsType, status: "queued", phase: "discover", requested_by: requestedBy })
    .select("id")
    .single();
  if (insertErr) {
    if (isDuplicate(insertErr)) {
      // A second render or a double-submit got there first.
      const now = await currentJob(admin, hotelId);
      return { queued: false, reason: "in_flight", jobId: now?.id };
    }
    throw new Error(`Could not queue the import: ${insertErr.message}`);
  }
  kickImportWorker();
  return { queued: true, jobId: String(inserted!.id), resumed: false };
}

/**
 * "Not now" on a property whose import is queued or running stops it. The
 * checkpoint stays, and showing the property again carries on from there.
 */
export async function stopPrePaymentImport(admin: SupabaseClient, hotelId: string): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("import_jobs")
    .update({
      status: "canceled",
      finished_at: now,
      lease_expires_at: null,
      last_error: 'Stopped: the owner chose "Not now" for this property.',
      updated_at: now,
    })
    .eq("hotel_id", hotelId)
    .in("status", ["queued", "running"])
    .select("id");
  if (error) throw new Error(`Could not stop the import: ${error.message}`);
  return (data ?? []).length;
}

export type PromotionResult =
  | { ok: true; jobId: string; action: "kept" | "requeued" | "created" }
  | { ok: false; message: string };

/**
 * Payment adopts the import that is already there. Queued, running or
 * finished, the property keeps that job; only one that failed or was stopped
 * goes back in the queue, from its checkpoint. A new job is inserted only when
 * the property has none at all. The paid job then goes ahead of every unpaid
 * one in the queue.
 */
export async function promoteImportJob(
  admin: SupabaseClient,
  hotelId: string,
  pmsType: string,
  requestedBy: string | null,
): Promise<PromotionResult> {
  try {
    const job = await currentJob(admin, hotelId);
    if (job && (ACTIVE.has(job.status) || job.status === "completed")) {
      return { ok: true, jobId: job.id, action: "kept" };
    }
    if (job) {
      if (await requeue(admin, job)) return { ok: true, jobId: job.id, action: "requeued" };
      // Someone moved it between the read and the write; take what is there now.
      const now = await currentJob(admin, hotelId);
      if (now && (ACTIVE.has(now.status) || now.status === "completed")) {
        return { ok: true, jobId: now.id, action: "kept" };
      }
      return { ok: false, message: `import job ${job.id} is ${now?.status ?? "gone"} and could not be re-queued` };
    }

    const { data: inserted, error } = await admin
      .from("import_jobs")
      .insert({ hotel_id: hotelId, pms_type: pmsType, status: "queued", phase: "discover", requested_by: requestedBy })
      .select("id")
      .single();
    if (!error && inserted?.id != null) return { ok: true, jobId: String(inserted.id), action: "created" };
    if (isDuplicate(error)) {
      // The one-active-job index refused a second import, so one was queued
      // between the read and the insert. That job is the import; find it.
      const now = await currentJob(admin, hotelId);
      if (now && ACTIVE.has(now.status)) return { ok: true, jobId: now.id, action: "kept" };
      return { ok: false, message: "a duplicate import job was refused, but no import is queued or running" };
    }
    return { ok: false, message: `could not queue the import: ${error?.message ?? "no row returned"}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A paid property reconnecting picks up an import its disconnect stopped. A
 * finished or failed import is not touched: a reconnect is not a re-import.
 */
export async function resumeStoppedImport(admin: SupabaseClient, hotelId: string): Promise<boolean> {
  const job = await currentJob(admin, hotelId);
  if (job?.status !== "canceled") return false;
  const resumed = await requeue(admin, job);
  if (resumed) kickImportWorker();
  return resumed;
}

/**
 * Ask the import worker to run now. Fire-and-forget: cron picks the job up
 * within a minute regardless, so a failure here costs latency, not the import.
 */
export function kickImportWorker(): void {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.ONBOARDING_CRON_SECRET;
  if (!supabaseUrl || !secret) return;
  fetch(`${supabaseUrl}/functions/v1/onboarding-import-worker`, {
    method: "POST",
    headers: { "x-onboarding-cron-secret": secret },
  }).catch(() => {
    // Cron picks the job up within a minute.
  });
}
