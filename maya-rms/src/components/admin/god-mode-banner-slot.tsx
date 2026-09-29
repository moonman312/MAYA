import { GodModeBanner } from "@/components/admin/god-mode-banner";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";

/**
 * Where the God Mode banner goes: the server decides, once per page, whether
 * the signed-in person is a platform admin, and renders the banner only for
 * them. Everyone else gets nothing at all, so no request from the browser and
 * no god_mode_status call. The admin's banner then asks
 * /api/admin/god-mode on each page and counts the window down as before.
 *
 * Mounted by the signed-in areas (the dashboard, /account, /onboarding and
 * the Command Center), never the root layout: reading the session there would
 * stop the docs and support pages being built ahead of time.
 *
 * A page that has already read the role passes it as isPlatformAdmin, so the
 * role is never read twice. Otherwise this reads it with one is_platform_admin
 * call on the caller's own token, and not at all when nobody is signed in.
 */
export async function GodModeBannerSlot({ isPlatformAdmin }: { isPlatformAdmin?: boolean } = {}) {
  const admin = isPlatformAdmin ?? (await signedInIsPlatformAdmin());
  return admin ? <GodModeBanner /> : null;
}

async function signedInIsPlatformAdmin(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = createClient(await cookies());
  // A cookie read, no auth round trip. The RPC below carries the token, and
  // the database checks it, so a made-up cookie only gets a false.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return false;
  const { data, error } = await supabase.rpc("is_platform_admin");
  return !error && data === true;
}
