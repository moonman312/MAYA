import { AdminTopNav } from "@/components/admin/admin-top-nav";
import { GodModeBannerSlot } from "@/components/admin/god-mode-banner-slot";
import { staffSessionRedirect } from "@/lib/admin/staff-page";
import { getStaffSession } from "@/lib/admin/staff-session";
import { isAdminConfigured } from "@/utils/supabase/admin";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  if (!isSupabaseConfigured()) {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <div className="mx-auto max-w-3xl rounded border border-amber-500/40 bg-amber-500/10 p-6 text-sm text-amber-200">
          Supabase is not configured. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and a
          publishable key before using /admin.
        </div>
      </main>
    );
  }
  if (!isAdminConfigured()) {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <div className="mx-auto max-w-3xl rounded border border-amber-500/40 bg-amber-500/10 p-6 text-sm text-amber-200">
          Command Center is not configured on this deployment.
          Set <code>SUPABASE_SERVICE_ROLE_KEY</code> in the server env, redeploy, and try again.
        </div>
      </main>
    );
  }

  // MAYA staff only: a platform admin at any sign-in, a developer or sales
  // login after the code from its authenticator app (the code step is
  // outside /admin, so this never sends it to itself). Shared with the page
  // through React's cache: one check per request. Each page also asks for its
  // own section (requireStaffPage), since a layout cannot see which page it
  // wraps and is not re-run on every navigation.
  const session = await getStaffSession();
  if (!session.ok) {
    redirect(staffSessionRedirect(session));
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AdminTopNav userEmail={session.email} role={session.role} sections={session.sections} />
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      <GodModeBannerSlot isPlatformAdmin={session.isPlatformAdmin} />
    </div>
  );
}
