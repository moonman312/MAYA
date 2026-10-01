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

/** The other MAYA hotel a property already belongs to, for the admin log. */
export type PropertyElsewhere = {
  propertyId: string;
  hotelId: string;
  name: string | null;
  /** How the hotel holds the property: on its row (Marketplace) or with its credential (connected inside MAYA). */
  via: "marketplace" | "credential";
  /** That hotel's connection status for this PMS, when it has a connection row. */
  connectionStatus: string | null;
};

/**
 * The first of these PMS properties that is already some other MAYA
 * hotel's, or null: a Marketplace hotel carries its property on its row and
 * counts once someone is a member of it (an unclaimed parked row is nobody's
 * yet); a hotel connected from inside MAYA keeps its property with its
 * credential, whatever its connection's status (a disconnected hotel can
 * reconnect by its property, so it still holds it). `hotelId` is the hotel
 * asking, never counted against itself; null when it has no row yet. Throws
 * when anything cannot be read, so an outage is never "not in MAYA".
 *
 * Asked by a reconnect of a hotel with no property on record (oauth-flow.ts)
 * and by the sign-up connect (onboarding/connect.ts), before either stores
 * anything: two MAYA hotels on one property would both read its bookings,
 * both send prices to its rates and take each other's prices for the
 * hotel's own changes, and both be billed.
 */
export async function propertyBelongsElsewhere(
  admin: SupabaseClient,
  hotelId: string | null,
  pmsType: PmsType,
  propertyIds: string[],
): Promise<PropertyElsewhere | null> {
  if (propertyIds.length === 0) return null;
  const { data: keyed, error } = await admin
    .from("hotels")
    .select("id, name, external_enterprise_id")
    .in(
      "external_enterprise_id",
      // marketplace-connect.ts enterpriseKey, which imports this file.
      propertyIds.map((p) => `${pmsType}:${p}`),
    );
  if (error) throw new Error(`hotels: ${error.message}`);
  for (const h of keyed ?? []) {
    if (String(h.id) === hotelId) continue;
    const { data: members, error: memberErr } = await admin
      .from("hotel_memberships")
      .select("user_id")
      .eq("hotel_id", String(h.id))
      .limit(1);
    if (memberErr) throw new Error(`hotel_memberships: ${memberErr.message}`);
    if ((members ?? []).length > 0) {
      const key = String(h.external_enterprise_id ?? "");
      return {
        propertyId: key.startsWith(`${pmsType}:`) ? key.slice(pmsType.length + 1) : key,
        hotelId: String(h.id),
        name: h.name != null ? String(h.name) : null,
        via: "marketplace",
        connectionStatus: await connectionStatusOf(admin, String(h.id), pmsType),
      };
    }
  }
  const inside = await hotelsConnectedInsideMaya(admin, pmsType, propertyIds);
  for (const [propertyId, hotel] of inside) {
    if (hotel.id === hotelId) continue;
    return { propertyId, hotelId: hotel.id, name: hotel.name, via: "credential", connectionStatus: await connectionStatusOf(admin, hotel.id, pmsType) };
  }
  return null;
}

/** A hotel's connection status for this PMS, for the log; null when it has none or it cannot be read (the log is not worth a refusal). */
async function connectionStatusOf(admin: SupabaseClient, hotelId: string, pmsType: PmsType): Promise<string | null> {
  const { data, error } = await admin.from("pms_connections").select("status").eq("hotel_id", hotelId).eq("pms_type", pmsType).maybeSingle();
  if (error || data?.status == null) return null;
  return String(data.status);
}
