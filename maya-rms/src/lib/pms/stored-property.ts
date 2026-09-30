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

const PAGE = 1000;
const READS_AT_ONCE = 8;

/**
 * The hotels connected from inside MAYA whose credential names one of these
 * properties, by property ID. A Marketplace hotel carries its property on its
 * row (external_enterprise_id) and is found by that, so only the rest have
 * their credential read. Every connection row counts, whatever its status: a
 * disconnected hotel keeps its credential and can reconnect by its property,
 * and two MAYA hotels on one property would both read its bookings and send
 * it prices. (A purged hotel has no connection row or credential left.) The
 * caller names the hotel found in its log so support can clear it. Throws
 * when anything cannot be read: a caller about to add a property must not
 * take an outage for "not in MAYA".
 */
export async function hotelsConnectedInsideMaya(
  admin: SupabaseClient,
  pmsType: PmsType,
  propertyIds: string[],
): Promise<Map<string, { id: string; name: string | null }>> {
  const found = new Map<string, { id: string; name: string | null }>();
  const wanted = new Set(propertyIds);
  if (wanted.size === 0) return found;

  const hotelIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("pms_connections")
      .select("hotel_id")
      .eq("pms_type", pmsType)
      .order("hotel_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`pms_connections: ${error.message}`);
    for (const row of data ?? []) hotelIds.add(String(row.hotel_id));
    if ((data ?? []).length < PAGE) break;
  }

  const ids = [...hotelIds];
  const candidates: { id: string; name: string | null }[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin
      .from("hotels")
      .select("id, name, external_enterprise_id")
      .in("id", ids.slice(i, i + 100));
    if (error) throw new Error(`hotels: ${error.message}`);
    for (const h of data ?? []) {
      if (String(h.external_enterprise_id ?? "").startsWith(`${pmsType}:`)) continue;
      candidates.push({ id: String(h.id), name: h.name != null ? String(h.name) : null });
    }
  }

  for (let i = 0; i < candidates.length; i += READS_AT_ONCE) {
    const batch = candidates.slice(i, i + READS_AT_ONCE);
    const stored = await Promise.all(batch.map((h) => storedPropertyId(admin, h.id, pmsType)));
    batch.forEach((hotel, k) => {
      const propertyId = stored[k];
      if (propertyId && wanted.has(propertyId) && !found.has(propertyId)) found.set(propertyId, hotel);
    });
  }
  return found;
}
