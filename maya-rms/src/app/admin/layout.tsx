import { AdminTopNav } from "@/components/admin/admin-top-nav";
import { createClient } from "@/utils/supabase/server";
import { isAdminConfigured } from "@/utils/supabase/admin";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
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

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/admin");
  }
  const { data: isAdmin } = await supabase.rpc("is_platform_admin", {
    p_user_id: user.id,
  });
  if (!isAdmin) {
    redirect("/");
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <AdminTopNav userEmail={user.email ?? ""} />
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
