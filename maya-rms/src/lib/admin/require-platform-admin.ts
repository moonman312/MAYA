import "server-only";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient as createSSRClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export type CookieStore = Awaited<ReturnType<typeof cookies>>;

export type PlatformAdminContext = {
  user: User;
  /** Authenticated SSR client. RLS still applies but grants access to everything for platform admins. */
  ssr: SupabaseClient;
  /** Service-role client. Bypasses RLS. Use for auth.admin.* and cross-hotel mutations. */
  admin: SupabaseClient;
};

export type RequirePlatformAdminResult =
  | ({ ok: true } & PlatformAdminContext)
  | { ok: false; response: NextResponse };

/**
 * Guard for /admin routes and API handlers. Verifies the caller is signed in
 * and holds the platform_admin app_role. Returns both the SSR client (for
 * RLS-scoped reads) and the service-role client (for privileged mutations
 * like auth.admin.inviteUserByEmail).
 *
 * Prefer calling this at the top of every /api/admin/* route.
 */
export async function requirePlatformAdmin(
  cookieStore: CookieStore,
): Promise<RequirePlatformAdminResult> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Supabase is not configured." },
        { status: 503 },
      ),
    };
  }
  if (!isAdminConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Command Center is not configured on this deployment. Set SUPABASE_SERVICE_ROLE_KEY.",
        },
        { status: 503 },
      ),
    };
  }

  const ssr = createSSRClient(cookieStore);
  const {
    data: { user },
  } = await ssr.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const { data: isAdmin, error } = await ssr.rpc("is_platform_admin", {
    p_user_id: user.id,
  });
  if (error) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Authorization check failed: ${error.message}` },
        { status: 500 },
      ),
    };
  }
  if (!isAdmin) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { ok: true, user, ssr, admin: createAdminClient() };
}
