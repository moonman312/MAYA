/**
 * Resolve the hotel ID the current user has access to.
 *
 * Checks hotel_memberships for the authenticated user, falling back
 * to the MAYA_DEFAULT_HOTEL_ID env var when no membership is found.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveAccessibleHotelId(
  supabase: SupabaseClient,
): Promise<string | null> {
  // Check the env-var override first
  const envHotelId = process.env.MAYA_DEFAULT_HOTEL_ID;

  // Get the authenticated user
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return envHotelId ?? null;

  // Look up memberships via the profile -> hotel_memberships join
  const { data: memberships } = await supabase
    .from("hotel_memberships")
    .select("hotel_id")
    .eq("profile_id", user.id)
    .eq("status", "active")
    .limit(1);

  if (memberships && memberships.length > 0) {
    return String(memberships[0].hotel_id);
  }

  return envHotelId ?? null;
}
