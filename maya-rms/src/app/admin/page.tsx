import { DocsTallyTile } from "@/components/admin/docs-tally-panels";
import { SignupsFeedTestButton } from "@/components/admin/signups-feed-test-button";
import { TestAlertButton } from "@/components/admin/test-alert-button";
import { loadTallyTotals, type TallyTotals } from "@/lib/admin/docs-tally";
import { listHotels } from "@/lib/admin/hotels";
import { listPendingInvites } from "@/lib/admin/memberships";
import { countSignupCodes } from "@/lib/admin/signup-codes";
import { requireStaffPage } from "@/lib/admin/staff-page";
import type { StaffSection } from "@/lib/admin/staff-sections";
import { staffCanSee } from "@/lib/admin/staff-session";
import { testAlertProblem } from "@/lib/admin/test-alert";
import type { AdminPendingInviteRow } from "@/lib/admin/types";
import { countPlatformUsers } from "@/lib/admin/users";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * The Command Center's first page. Each tile shows only when the role may
 * read what it counts, and nothing is asked of the database for a tile that
 * is not shown (a function a role may not call refuses, it does not answer
 * empty). No money here for anyone.
 */
export default async function AdminOverviewPage() {
  const session = await requireStaffPage("home");
  const can = (section: StaffSection) => staffCanSee(session, section);
  const ssr = createClient(await cookies());
  // The docs helper's count is reported in its tile, never fatal to the page.
  const docsTally: Promise<{ totals: TallyTotals | null; error: string | null }> = can("docs_questions")
    ? loadTallyTotals(ssr, new Date().toISOString().slice(0, 10)).then(
        (totals) => ({ totals, error: null }),
        (e: unknown) => ({ totals: null, error: e instanceof Error ? e.message : String(e) }),
      )
    : Promise.resolve({ totals: null, error: null });
  const [hotels, userCount, pending, signupCodes, docs] = await Promise.all([
    can("hotels") ? listHotels(ssr) : Promise.resolve([]),
    can("users") ? countPlatformUsers(ssr) : Promise.resolve(null),
    can("pending_invites") ? listPendingInvites(ssr) : Promise.resolve([] as AdminPendingInviteRow[]),
    can("signup_codes") ? countSignupCodes(ssr) : Promise.resolve(0),
    docsTally,
  ]);

  const nowMs = new Date().getTime();
  const outstandingInvites = pending.filter((p) => p.status === "pending");
  // Checkout leaves a placeholder row behind until the PMS connect adopts it.
  // Counting those pads the hotel number and drags down the connected rate, so
  // the tiles only count properties that finished starting.
  const properties = hotels.filter((h) => !h.setup_pending_at);
  const connectedPms = properties.filter((h) => h.pms_status === "connected").length;
  const staleSync = properties.filter((h) => {
    if (!h.pms_last_sync_at) return h.pms_status === "connected";
    return nowMs - new Date(h.pms_last_sync_at).getTime() > 30 * 60 * 1000;
  }).length;

  const stats: { section: StaffSection; label: string; value: string | number; href: string }[] = [
    { section: "hotels", label: "Hotels", value: properties.length, href: "/admin/hotels" },
    { section: "hotels", label: "PMS connected", value: `${connectedPms} / ${properties.length}`, href: "/admin/hotels" },
    // Null only on a database the speed migration hasn't reached yet.
    { section: "users", label: "Users", value: userCount ?? "n/a", href: "/admin/users" },
    {
      section: "pending_invites",
      label: "Pending invites",
      value: outstandingInvites.length,
      href: "/admin/pending-invites",
    },
    { section: "hotels", label: "Stale syncs", value: staleSync, href: "/admin/hotels" },
    { section: "signup_codes", label: "Signup codes", value: signupCodes, href: "/admin/signup-codes" },
  ];
  const shownStats = stats.filter((s) => can(s.section));

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Command Center</h1>
          <p className="text-sm text-slate-400">
            {session.isPlatformAdmin ? "Provision and manage hotels, users, and PMS connections." : "Read only."}
          </p>
        </div>
        {can("hotel_create") ? (
          <Link
            href="/admin/hotels/new"
            className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400"
          >
            + New hotel
          </Link>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {shownStats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="rounded border border-slate-800 bg-slate-900 p-4 transition hover:border-slate-700"
          >
            <div className="text-xs uppercase tracking-wide text-slate-500">{s.label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-100">{s.value}</div>
          </Link>
        ))}
      </div>

      {can("docs_questions") ? <DocsTallyTile totals={docs.totals} error={docs.error} /> : null}

      {/* Sends a test alert: a platform admin's action (the route refuses anyone else). */}
      {session.isPlatformAdmin ? <TestAlertButton problem={testAlertProblem()} /> : null}
      {/* The same for the #maya-signups feed, which the database posts. */}
      {session.isPlatformAdmin ? <SignupsFeedTestButton /> : null}

      {can("hotels") ? (
        <section className="rounded border border-slate-800 bg-slate-900">
          <header className="flex items-center justify-between border-b border-slate-800 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Recent hotels
            </h2>
            <Link href="/admin/hotels" className="text-xs text-sky-300 hover:underline">
              View all →
            </Link>
          </header>
          <ul className="divide-y divide-slate-800">
            {hotels.slice(0, 5).map((h) => (
              <li key={h.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <Link
                    href={`/admin/hotels/${h.id}`}
                    className="text-sm font-medium text-slate-100 hover:text-sky-300"
                  >
                    {h.name}
                  </Link>
                  <div className="text-xs text-slate-400">
                    {h.timezone} · {h.currency} · {h.membership_count} member
                    {h.membership_count === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="text-xs text-slate-400">
                  {h.pms_status ? (
                    <span className="rounded bg-slate-800 px-2 py-1">
                      {h.pms_type} · {h.pms_status}
                    </span>
                  ) : (
                    <span className="text-slate-600">no PMS</span>
                  )}
                </div>
              </li>
            ))}
            {hotels.length === 0 && (
              <li className="p-4 text-sm text-slate-400">
                No hotels yet.{" "}
                {can("hotel_create") ? (
                  <Link href="/admin/hotels/new" className="text-sky-300 hover:underline">
                    Create the first one →
                  </Link>
                ) : null}
              </li>
            )}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
