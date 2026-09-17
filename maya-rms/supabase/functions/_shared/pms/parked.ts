/**
 * Properties that are connected but not paid for yet, dropped before the
 * scheduler makes any PMS call for them.
 *
 * A Marketplace arrival sits at `pms_connections.status = 'pending'` from the
 * moment the PMS hands over the grant until its subscription lands. While it
 * waits it has no `hotel_subscriptions` row at all, and the entitlement check
 * reads a missing row as "no opinion" and lets the hotel through — deliberately,
 * because a hotel created by hand must not be cut off for lacking a Stripe
 * subscription. `claim_pms_sync_batch` is what is supposed to leave a pending
 * connection alone, but that filter arrived in a migration, so a deploy landing
 * ahead of it would put a property nobody has paid for on the five-minute cycle.
 *
 * The recurring sync, the engine and rate pushes are what payment buys. A
 * claimed property's history is read once before that, by the onboarding
 * import through its own queue (claim_import_job), and that is the only
 * reading an unpaid property gets. So this gets a second guard that does not
 * depend on which half shipped first. Once the migration is in, the claim
 * never returns these rows and this costs one small query per tick.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Connection states that must never be worked on by the scheduler. */
const PARKED = new Set(["pending"]);

export type ParkedSplit = {
  /** Hotels the caller should go on to sync. */
  allowed: string[];
  /** Hotels left alone, with the status that parked them. */
  parked: { hotelId: string; status: string }[];
};

/**
 * Splits a claimed batch into the hotels worth syncing and the ones still
 * waiting to be paid for, or waiting for their history to come back.
 *
 * A never-paid property the retention sweep emptied (hotels.data_purged_at)
 * is held until an import queued after the purge has completed, so nothing
 * prices it off the recent window alone. claim_pms_sync_batch holds it too,
 * but a manual price save asks for one hotel's sync directly and never goes
 * through the claim, so the hold lives here as well.
 *
 * Fails CLOSED on a read error, unlike the entitlement check: that one protects
 * a paying customer's pricing from a database blip, while this one keeps a
 * property nobody has paid for off the sync, the engine and its rates. When in
 * doubt, do nothing.
 */
export async function splitByParked(
  supabase: SupabaseClient,
  pmsType: string,
  hotelIds: string[],
): Promise<ParkedSplit> {
  if (hotelIds.length === 0) return { allowed: [], parked: [] };

  const failClosed = (message: string): ParkedSplit => {
    console.error(JSON.stringify({ fn: "splitByParked", error: message, failedClosed: hotelIds.length }));
    return { allowed: [], parked: hotelIds.map((hotelId) => ({ hotelId, status: "unknown" })) };
  };

  const { data, error } = await supabase
    .from("pms_connections")
    .select("hotel_id, status")
    .eq("pms_type", pmsType)
    .in("hotel_id", hotelIds);
  if (error) return failClosed(error.message);

  let importing: Set<string>;
  try {
    importing = await purgedAwaitingImport(supabase, hotelIds);
  } catch (e) {
    return failClosed(e instanceof Error ? e.message : String(e));
  }

  const statusByHotel = new Map((data ?? []).map((r) => [String(r.hotel_id), String(r.status)]));

  const allowed: string[] = [];
  const parked: { hotelId: string; status: string }[] = [];
  for (const hotelId of hotelIds) {
    const status = statusByHotel.get(hotelId);
    // A claimed hotel with no connection row is the same "do nothing" case: the
    // row was deleted between the claim and here, and there is nothing to sync.
    if (status === undefined) parked.push({ hotelId, status: "missing" });
    else if (PARKED.has(status)) parked.push({ hotelId, status });
    else if (importing.has(hotelId)) parked.push({ hotelId, status: "purged_importing" });
    else allowed.push(hotelId);
  }
  return { allowed, parked };
}

/** PostgREST's "column does not exist": the retention migration has not run. */
function isMissingColumn(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || (error.message ?? "").includes("data_purged_at");
}

/**
 * The hotels whose data was purged and that have no completed import created
 * since. Throws on a read error. Before the column exists nothing was purged.
 */
async function purgedAwaitingImport(supabase: SupabaseClient, hotelIds: string[]): Promise<Set<string>> {
  const { data: hotels, error } = await supabase
    .from("hotels")
    .select("id, data_purged_at")
    .in("id", hotelIds);
  if (error) {
    if (isMissingColumn(error)) return new Set();
    throw new Error(`hotels read failed: ${error.message}`);
  }
  const purgedAt = new Map<string, string>();
  for (const h of (hotels ?? []) as { id: unknown; data_purged_at?: unknown }[]) {
    if (h.data_purged_at) purgedAt.set(String(h.id), String(h.data_purged_at));
  }
  if (purgedAt.size === 0) return new Set();

  const { data: jobs, error: jobsErr } = await supabase
    .from("import_jobs")
    .select("hotel_id, created_at")
    .eq("status", "completed")
    .in("hotel_id", [...purgedAt.keys()]);
  if (jobsErr) throw new Error(`import_jobs read failed: ${jobsErr.message}`);

  const held = new Set(purgedAt.keys());
  for (const j of (jobs ?? []) as { hotel_id: unknown; created_at: unknown }[]) {
    const hotelId = String(j.hotel_id);
    const since = purgedAt.get(hotelId);
    if (since && Date.parse(String(j.created_at)) > Date.parse(since)) held.delete(hotelId);
  }
  return held;
}

/**
 * Hotels whose onboarding import is refreshing the current window right now,
 * under a live lease.
 *
 * The import worker and the scheduled sync both call the PMS with the same
 * credential, and their rate limiting is per isolate, so running both at once
 * spends the property's allowance twice as fast. Only the worker's
 * sync_current phase reads the recent window, and it keeps these hotels'
 * reservations fresh while it runs, so the scheduled run skips only its PMS
 * read for them and still evaluates and pushes prices. Every other phase
 * (discover, historical, analyze) can run for hours on a big property and
 * reads nothing current, so those hotels keep syncing: a refresh import must
 * never freeze a live hotel's pricing on stale bookings.
 *
 * Fails open: on a read error nobody is skipped, which is how every tick ran
 * before this existed.
 */
export async function hotelsImportingNow(
  supabase: SupabaseClient,
  hotelIds: string[],
  nowIso: string = new Date().toISOString(),
): Promise<Set<string>> {
  if (hotelIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("import_jobs")
    .select("hotel_id")
    .in("hotel_id", hotelIds)
    .eq("status", "running")
    .eq("phase", "sync_current")
    .gt("lease_expires_at", nowIso);
  if (error) {
    console.error(JSON.stringify({ fn: "hotelsImportingNow", error: error.message, failedOpen: hotelIds.length }));
    return new Set();
  }
  return new Set((data ?? []).map((r) => String((r as { hotel_id: unknown }).hotel_id)));
}
