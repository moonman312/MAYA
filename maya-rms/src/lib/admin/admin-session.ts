import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";

export type AdminSession =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "signed_out" | "not_admin" };

/**
 * Who is looking at a Command Center page, worked out once per request: the
 * admin layout and the page both ask, and React's cache makes it one check.
 *
 * The session is read with getClaims, which checks the access token's
 * signature here against the project's published keys instead of asking the
 * Auth server every time (with a shared-secret project it asks, exactly as
 * getUser did). Whether the person is a platform admin is still the
 * database's answer: is_platform_admin reads the caller from the token
 * PostgREST verifies, never from anything this sends, so a made-up cookie gets
 * a no. One round trip in all, where getUser and the role check took two.
 *
 * For pages that only read. The /api/admin routes that change things keep
 * requirePlatformAdmin, which asks the Auth server on every call.
 */
export const getAdminSession = cache(async (): Promise<AdminSession> => {
  const supabase = createClient(await cookies());
  // getClaims throws, rather than answering with an error, on some broken
  // tokens (an expired one behind a cookie that says otherwise): signed out.
  const { data, error } = await supabase.auth.getClaims().catch((e: unknown) => ({ data: null, error: e }));
  const claims = data?.claims;
  const userId = typeof claims?.sub === "string" ? claims.sub : null;
  if (error || !userId) return { ok: false, reason: "signed_out" };

  const { data: isAdmin, error: roleError } = await supabase.rpc("is_platform_admin", { p_user_id: userId });
  if (roleError || isAdmin !== true) return { ok: false, reason: "not_admin" };
  return { ok: true, userId, email: typeof claims?.email === "string" ? claims.email : "" };
});
