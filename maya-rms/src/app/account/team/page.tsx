import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TeamManager } from "@/components/account/team-manager";
import { MayaLockup } from "@/components/brand/logo";
import { hasHotelRank } from "@/lib/require-supabase-hotel";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { links } from "@/lib/deep-links";
import { memberRole, queryOf } from "@/lib/deep-links/member-role";
import { rolesAssignableBy } from "@/lib/roles";
import { ArrivalFlash } from "@/components/deep-links/arrival-bits";
import { HelpLink } from "@/components/deep-links/help-links";

export const dynamic = "force-dynamic";

/**
 * Who else can get into this property.
 *
 * Gated at General Manager, the same bar as billing and the PMS connection —
 * deciding who may change rates is the same weight of decision as deciding what
 * they cost. Checked here as well as in the routes so somebody below it gets an
 * explanation rather than a screen of controls that all fail.
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = createClient(await cookies());

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) redirect("/onboarding");

  const canManage = await hasHotelRank(supabase, hotelId, "general_manager", user.id);

  // A link can pick the invite's role (never the email). Only a role this
  // person may hand out is taken; anything else leaves the form's default.
  const arrival = links.readArrival(queryOf(await searchParams));
  let inviteRole: string | null = null;
  if (canManage && arrival.dest === "team.invite" && arrival.params.role) {
    const { data: isAdmin } = await supabase.rpc("is_platform_admin");
    const grantable = rolesAssignableBy(await memberRole(supabase, user.id, hotelId), { isPlatformAdmin: Boolean(isAdmin) });
    if (grantable.some((r) => r.key === arrival.params.role)) inviteRole = arrival.params.role;
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-6 py-10 text-slate-200">
      <MayaLockup height={32} />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your team</h1>
        <div className="flex items-center gap-4">
          <HelpLink screen="team" className="text-sm text-slate-400 hover:text-slate-200" />
          <Link href="/account/billing" className="text-sm text-slate-400 hover:text-slate-200">
            Billing
          </Link>
          <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">
            ← Back to MAYA
          </Link>
        </div>
      </div>

      <ArrivalFlash flashIds={{ invite: "team.invite" }} />
      {canManage ? (
        <TeamManager initialInviteRole={inviteRole} />
      ) : (
        <p className="rounded border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
          Who can access this property is managed by its General Manager or Hotel Admin. Ask one of
          them if you need someone added or removed.
        </p>
      )}
    </main>
  );
}
