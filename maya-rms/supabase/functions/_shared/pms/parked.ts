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
 * waiting to be paid for.
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

  const { data, error } = await supabase
    .from("pms_connections")
    .select("hotel_id, status")
    .eq("pms_type", pmsType)
    .in("hotel_id", hotelIds);

  if (error) {
    console.error(
      JSON.stringify({ fn: "splitByParked", error: error.message, failedClosed: hotelIds.length }),
    );
    return { allowed: [], parked: hotelIds.map((hotelId) => ({ hotelId, status: "unknown" })) };
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
    else allowed.push(hotelId);
  }
  return { allowed, parked };
}
