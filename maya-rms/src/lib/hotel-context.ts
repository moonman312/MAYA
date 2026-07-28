/**
 * Active hotel for the signed-in user: validated cookie, then first accessible
 * property, then MAYA_DEFAULT_HOTEL_ID when there are no memberships (dev).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export const MAYA_ACTIVE_HOTEL_COOKIE = "maya_active_hotel";

export type AccessibleHotel = { id: string; name: string };

export async function listAccessibleHotels(
  supabase: SupabaseClient,
): Promise<AccessibleHotel[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  // Single round-trip: memberships joined to hotels (was two sequential
  // queries — this path runs on nearly every API request, so it adds up).
  const { data: rows, error } = await supabase
    .from("hotel_memberships")
    .select("hotel_id, hotels!inner(id, name, is_active)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .eq("hotels.is_active", true);

  if (error || !rows?.length) return [];

  const byId = new Map<string, AccessibleHotel>();
  for (const r of rows) {
    const h = (Array.isArray(r.hotels) ? r.hotels[0] : r.hotels) as
      | { id: string; name: string }
      | undefined;
    if (h?.id) byId.set(String(h.id), { id: String(h.id), name: String(h.name) });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolves the hotel ID to use for API/data scope.
 * Prefers HTTP-only cookie when it matches an active membership.
 */
export async function resolveAccessibleHotelId(
  supabase: SupabaseClient,
): Promise<string | null> {
  const envHotelId = process.env.MAYA_DEFAULT_HOTEL_ID?.trim() || null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return envHotelId;
  }

  const hotels = await listAccessibleHotels(supabase);
  const allowed = new Set(hotels.map((h) => h.id));

  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(MAYA_ACTIVE_HOTEL_COOKIE)?.value ?? null;
  if (fromCookie && allowed.has(fromCookie)) {
    return fromCookie;
  }

  if (hotels.length > 0) {
    return hotels[0].id;
  }

  return envHotelId;
}
