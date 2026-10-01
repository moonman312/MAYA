/**
 * PMS properties that are vendors' sandboxes, never a customer's.
 *
 * A MAYA hotel connected to one is a test property: hotels.is_test is set
 * when it connects (from the Marketplace, signing up, or reconnecting), when
 * its Marketplace claim lands, and by the Cloudbeds sync if it was connected
 * before this list existed. Flagged hotels drop out of business analytics,
 * and their product events follow the flag
 * (99_supabase_migration_signups_feed_v1.sql, hotels_test_flag_follows).
 *
 * The one list. Add a property id here, by PMS, and every one of those paths
 * picks it up. Nothing ever clears the flag on its own: a hotel set back to
 * a real customer by hand in the Command Center stays as it was set unless it
 * connects to a sandbox property again.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const SANDBOX_PMS_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  // The Cloudbeds developer sandbox MAYA is certified against.
  cloudbeds: ["320691"],
};

/** Whether this PMS property is a vendor sandbox. */
export function isSandboxProperty(pmsType: string, propertyId: string | number | null | undefined): boolean {
  if (propertyId == null) return false;
  const id = String(propertyId).trim();
  return id !== "" && (SANDBOX_PMS_PROPERTIES[pmsType] ?? []).includes(id);
}

/**
 * Flags the hotel as a test property when it is connected to a sandbox.
 * True when it is (flagged now or already). One write, and only for a
 * sandbox. Never throws: a failed write is logged and the next connect or
 * sync tries again.
 */
export async function markSandboxHotel(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  propertyId: string | number | null | undefined,
): Promise<boolean> {
  if (!isSandboxProperty(pmsType, propertyId)) return false;
  try {
    const { error } = await supabase.from("hotels").update({ is_test: true }).eq("id", hotelId).eq("is_test", false);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "markSandboxHotel",
        hotelId,
        pmsType,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      }),
    );
  }
  return true;
}

/**
 * Flags those of these hotels whose Marketplace key (external_enterprise_id,
 * `cloudbeds:320691`) names a sandbox property. For the claim, which knows
 * the hotels and not their properties. Never throws.
 */
export async function markSandboxHotelsByKey(supabase: SupabaseClient, hotelIds: string[]): Promise<string[]> {
  if (hotelIds.length === 0) return [];
  const { data, error } = await supabase.from("hotels").select("id, external_enterprise_id").in("id", hotelIds);
  if (error) {
    console.error(JSON.stringify({ fn: "markSandboxHotelsByKey", error: error.message.slice(0, 300) }));
    return [];
  }
  const flagged: string[] = [];
  for (const h of (data ?? []) as { id: unknown; external_enterprise_id?: unknown }[]) {
    const key = h.external_enterprise_id != null ? String(h.external_enterprise_id) : "";
    const at = key.indexOf(":");
    if (at <= 0) continue;
    if (await markSandboxHotel(supabase, String(h.id), key.slice(0, at), key.slice(at + 1))) flagged.push(String(h.id));
  }
  return flagged;
}
