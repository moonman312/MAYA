import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { roleRank } from "@/lib/roles";

/**
 * The signed-in person's best role on a property, or null. Filtered on their
 * own user id: the select policy lets a member read the whole hotel's list.
 */
export async function memberRole(supabase: SupabaseClient, userId: string, hotelId: string): Promise<string | null> {
  const { data } = await supabase
    .from("hotel_memberships")
    .select("role")
    .eq("hotel_id", hotelId)
    .eq("user_id", userId)
    .eq("status", "active");
  const roles = (data ?? []).map((r) => String(r.role));
  return roles.sort((a, b) => roleRank(b) - roleRank(a))[0] ?? null;
}

/** The query string a server page was opened with, for readArrival. */
export function queryOf(searchParams: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) q.append(key, v);
  }
  return q.toString();
}
