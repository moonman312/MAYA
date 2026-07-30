import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TeamManager } from "@/components/account/team-manager";
import { hasHotelRank } from "@/lib/require-supabase-hotel";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Who else can get into this property.
 *
 * Gated at General Manager, the same bar as billing and the PMS connection —
 * deciding who may change rates is the same weight of decision as deciding what
 * they cost. Checked here as well as in the routes so somebody below it gets an
 * explanation rather than a screen of controls that all fail.
 */
export default async function TeamPage() {
  const supabase = createClient(await cookies());

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) redirect("/onboarding");

  const canManage = await hasHotelRank(supabase, hotelId, "general_manager");

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-6 py-10 text-slate-200">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your team</h1>
        <div className="flex items-center gap-4">
          <Link href="/account/billing" className="text-sm text-slate-400 hover:text-slate-200">
            Billing
          </Link>
          <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">
            ← Back to MAYA
          </Link>
        </div>
      </div>

      {canManage ? (
        <TeamManager />
      ) : (
        <p className="rounded border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
          Who can access this property is managed by its General Manager or Hotel Admin. Ask one of
          them if you need someone added or removed.
        </p>
      )}
    </main>
  );
}
