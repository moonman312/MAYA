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

  const { data: memberships, error: mErr } = await supabase
    .from("hotel_memberships")
    .select("hotel_id")
    .eq("user_id", user.id)
    .eq("status", "active");

  if (mErr || !memberships?.length) return [];

  const ids = [...new Set(memberships.map((r) => String(r.hotel_id)))];

  const { data: hotels, error: hErr } = await supabase
    .from("hotels")
    .select("id, name")
    .in("id", ids)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (hErr || !hotels) return [];

  return hotels.map((h) => ({ id: String(h.id), name: String(h.name) }));
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
