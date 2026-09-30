import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingFunction } from "./product-analytics";
import type { StaffRoleChoice } from "./staff-sections";
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

/**
 * How many logins there are, for the Users tile and the Users page's pages
 * (platform_count_users, 99_supabase_migration_command_center_speed_v1.sql).
 * Null on a database that hasn't had that file run, so the caller can fall
 * back to counting the rows it has.
 */
export async function countPlatformUsers(ssr: SupabaseClient, opts: { search?: string } = {}): Promise<number | null> {
  const { data, error } = await ssr.rpc("platform_count_users", { p_search: opts.search ?? null });
  if (error) {
    if (isMissingFunction(error)) return null;
    throw new Error(`platform_count_users: ${error.message}`);
  }
  return Number(data ?? 0);
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

export type SetStaffRoleResult = {
  role: StaffRoleChoice;
  /** The staff roles the person held before (platform_admin, developer, sales). */
  previous: string[];
  /** False when they already had exactly this role: nothing was written. */
  changed: boolean;
};

/**
 * The Users page's role picker: leaves the person with exactly this staff
 * role, or none (platform_set_staff_role in
 * 99_supabase_migration_staff_roles_v1.sql). Call it with the admin's own
 * session client after requirePlatformAdmin and requireGodMode: the database
 * checks God Mode again, names the admin on the audit line, and refuses to
 * remove the last platform admin with a message that can be shown as it is.
 */
export async function setStaffRole(
  ssr: SupabaseClient,
  userId: string,
  role: StaffRoleChoice,
): Promise<SetStaffRoleResult> {
  const { data, error } = await ssr.rpc("platform_set_staff_role", { p_user_id: userId, p_role: role });
  if (error) throw new Error(error.message);
  const out = (data ?? {}) as Record<string, unknown>;
  return {
    role,
    previous: Array.isArray(out.previous) ? out.previous.filter((r): r is string => typeof r === "string") : [],
    changed: out.changed === true,
  };
}
