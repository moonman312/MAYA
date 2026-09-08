/**
 * Active hotel for the signed-in user: validated cookie, then first accessible
 * property, then MAYA_DEFAULT_HOTEL_ID when there are no memberships
 * (non-production only).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export const MAYA_ACTIVE_HOTEL_COOKIE = "maya_active_hotel";

export type AccessibleHotel = { id: string; name: string };

// The env fallback exists so a fresh clone with seed data works before any
// membership rows do. In production it would hand this hotel to every
// signed-in user who has none: a brand-new customer's first checkout runs
// against a property they have never seen, and a membership-less platform
// admin could attach a live subscription to it. No membership, no hotel.
function envDefaultHotelId(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  return process.env.MAYA_DEFAULT_HOTEL_ID?.trim() || null;
}

export async function listAccessibleHotels(
  supabase: SupabaseClient,
): Promise<AccessibleHotel[]> {
  // getSession reads the cookie without a network hop. The real validation
  // already happened twice for this request: middleware ran getUser() against
  // the auth service, and every query below carries the JWT to PostgREST,
  // which verifies its signature before RLS runs — a forged or expired token
  // returns zero rows, not someone else's hotels. Calling getUser() here as
  // well was a third auth round-trip per API request, and under bursts
  // (calendar prefetching) it tripped Supabase Auth's rate limiter, stalling
  // random requests for tens of seconds.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const user = session?.user;
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
  const envHotelId = envDefaultHotelId();

  // Cookie read only — see the note in listAccessibleHotels for why this
  // deliberately skips the auth-service round-trip.
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
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
