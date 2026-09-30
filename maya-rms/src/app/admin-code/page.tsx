import { MayaMark } from "@/components/brand/logo";
import { StaffCodeStep } from "@/components/admin/staff-code-step";
import { STAFF_ROLE_LABELS } from "@/lib/admin/staff-sections";
import { getStaffSession } from "@/lib/admin/staff-session";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The code step before the Command Center, for a developer or sales login
 * whose session is not aal2 yet (the admin layout sends them here). Outside
 * /admin, so that layout never sends it to itself. Anyone else is sent on:
 * past the code (or a platform admin) to the Command Center, signed out to
 * sign in, not staff to the app.
 */
export default async function AdminCodePage() {
  if (!isSupabaseConfigured()) redirect("/login");
  const session = await getStaffSession();
  if (session.ok) redirect("/admin");
  if (session.reason === "signed_out") redirect("/login?next=/admin");
  if (session.reason === "not_staff") redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <div className="w-full max-w-sm space-y-5 rounded-lg border border-slate-800 bg-slate-900 p-6">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-sky-300">
          <MayaMark size={24} />
          Command Center
        </div>
        <div>
          <h1 className="text-xl font-semibold">Enter your code</h1>
          <p className="mt-1 text-xs text-slate-500">
            {session.email} · {STAFF_ROLE_LABELS[session.role]}
          </p>
        </div>
        <StaffCodeStep />
        <form action="/auth/logout" method="post">
          <button type="submit" className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
