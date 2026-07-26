import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminPlatformUserRow, AppRole } from "./types";

export async function listPlatformUsers(
  ssr: SupabaseClient,
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<AdminPlatformUserRow[]> {
  const { data, error } = await ssr.rpc("platform_list_users", {
    p_search: opts.search ?? null,
    p_limit: opts.limit ?? 100,
    p_offset: opts.offset ?? 0,
  });
  if (error) throw new Error(`platform_list_users: ${error.message}`);
  return (data ?? []) as AdminPlatformUserRow[];
}

export async function grantAppRole(
  admin: SupabaseClient,
  userId: string,
  role: AppRole,
): Promise<void> {
  const { error } = await admin.rpc("platform_grant_role", {
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw new Error(`platform_grant_role: ${error.message}`);
}

export async function revokeAppRole(
  admin: SupabaseClient,
  userId: string,
  role: AppRole,
): Promise<void> {
  const { error } = await admin.rpc("platform_revoke_role", {
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw new Error(`platform_revoke_role: ${error.message}`);
}
