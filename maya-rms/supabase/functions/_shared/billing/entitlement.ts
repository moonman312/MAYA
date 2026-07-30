/**
 * Whether a hotel's subscription should keep MAYA working for it.
 *
 * Canonical copy — the scheduled sync functions run under Deno and cannot
 * import from src/, so the predicate lives here and src/lib/billing/entitlement.ts
 * re-exports it. There must be exactly one answer to "are they paid up", because
 * the sweep that stops work and the UI that explains why have to agree.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Statuses where MAYA should be doing its job.
 *
 * `past_due` counts on purpose: Stripe retries a failed card for about two
 * weeks, and cutting a hotel's pricing off on the first failed charge (an
 * expired card, a bank's fraud hold) is a worse outcome than carrying them
 * through the retry window with a banner. `unpaid` and `canceled` — after those
 * retries have run out — is where it stops.
 */
const ENTITLED = new Set(["trialing", "active", "past_due"]);

export function isEntitledStatus(status: string | null | undefined): boolean {
  return ENTITLED.has(String(status));
}

export type BlockedHotel = { hotelId: string; status: string };

export type EntitlementSplit = {
  /** Hotels the caller should go on to process. */
  allowed: string[];
  /** Hotels skipped, with the status that stopped them — for logging. */
  blocked: BlockedHotel[];
};

/**
 * Split a batch of hotels into the ones still owed service and the ones not.
 *
 * A hotel with NO subscription row is ALLOWED, and that default matters more
 * than the check itself: the sandbox property, anything an admin created by
 * hand, and every deployment with no Stripe keys have never had a row and must
 * keep working. Only an explicit lapsed subscription stops anything.
 *
 * That means this is NOT the paywall and must not be mistaken for one. It cannot
 * tell a sandbox property from one that reached production without paying, so
 * what protects the business is that no unpaid hotel gets created in the first
 * place: lib/pms/oauth-flow.ts refuses to start a PMS connect unless
 * resolveOnboardingStep says payment is done, and lib/onboarding/connect.ts will
 * only ever ADOPT a row checkout already paid for when Stripe is configured.
 * Weaken either of those and this function will happily serve the result
 * forever.
 *
 * Fails OPEN. If the lookup itself errors, every hotel is allowed through: a
 * database blip must not silently stop pricing for the entire customer base,
 * which is a far worse outcome than briefly serving someone who stopped paying.
 */
export async function splitByEntitlement(
  supabase: SupabaseClient,
  hotelIds: string[],
): Promise<EntitlementSplit> {
  if (hotelIds.length === 0) return { allowed: [], blocked: [] };

  const { data, error } = await supabase
    .from("hotel_subscriptions")
    .select("hotel_id, status")
    .in("hotel_id", hotelIds);

  if (error) {
    console.error(
      JSON.stringify({ fn: "splitByEntitlement", error: error.message, failedOpen: hotelIds.length }),
    );
    return { allowed: [...hotelIds], blocked: [] };
  }

  const statusByHotel = new Map((data ?? []).map((r) => [String(r.hotel_id), String(r.status)]));

  const allowed: string[] = [];
  const blocked: BlockedHotel[] = [];
  for (const hotelId of hotelIds) {
    const status = statusByHotel.get(hotelId);
    if (status === undefined || isEntitledStatus(status)) allowed.push(hotelId);
    else blocked.push({ hotelId, status });
  }
  return { allowed, blocked };
}

/** One hotel's answer, for the routes that act on a single property. */
export async function isHotelEntitled(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<boolean> {
  const { allowed } = await splitByEntitlement(supabase, [hotelId]);
  return allowed.length === 1;
}
