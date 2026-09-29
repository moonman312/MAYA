import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PmsType } from "@/lib/pms/registry";

/**
 * The PMS property a hotel's stored credential is for.
 *
 * A property connected from inside MAYA keeps its Cloudbeds property ID with
 * its tokens and nowhere else: onboarding stores it there, and a sync that had
 * to look it up writes it back. Null when there is no credential or it names
 * no property. A credential that cannot be read throws, so a caller checking
 * something never takes an outage for "no property".
 */
export async function storedPropertyId(
  admin: SupabaseClient,
  hotelId: string,
  pmsType: PmsType,
): Promise<string | null> {
  const { data, error } = await admin.rpc("pms_secret_get", { p_hotel_id: hotelId, p_pms_type: pmsType });
  if (error) throw new Error(`pms_secret_get: ${error.message}`);
  let secret: unknown = data;
  if (typeof secret === "string") {
    try {
      secret = JSON.parse(secret);
    } catch {
      return null;
    }
  }
  if (!secret || typeof secret !== "object") return null;
  const raw = (secret as Record<string, unknown>).propertyId ?? (secret as Record<string, unknown>).property_id;
  return raw != null && String(raw) !== "" ? String(raw) : null;
}
