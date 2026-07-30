import { listHotels } from "@/lib/admin/hotels";
import { listPendingInvites } from "@/lib/admin/memberships";
import { countSignupCodes } from "@/lib/admin/signup-codes";
import { listPlatformUsers } from "@/lib/admin/users";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const ssr = createClient(await cookies());
  const [hotels, users, pending, signupCodes] = await Promise.all([
    listHotels(ssr),
    listPlatformUsers(ssr),
    listPendingInvites(ssr),
    countSignupCodes(ssr),
  ]);

  const nowMs = new Date().getTime();
  const outstandingInvites = pending.filter((p) => p.status === "pending");
  const connectedPms = hotels.filter((h) => h.pms_status === "connected").length;
  const staleSync = hotels.filter((h) => {
    if (!h.pms_last_sync_at) return h.pms_status === "connected";
    return nowMs - new Date(h.pms_last_sync_at).getTime() > 30 * 60 * 1000;
  }).length;

  const stats = [
    { label: "Hotels", value: hotels.length, href: "/admin/hotels" },
    { label: "PMS connected", value: `${connectedPms} / ${hotels.length}`, href: "/admin/hotels" },
    { label: "Users", value: users.length, href: "/admin/users" },
    {
      label: "Pending invites",
      value: outstandingInvites.length,
      href: "/admin/pending-invites",
    },
    { label: "Stale syncs", value: staleSync, href: "/admin/hotels" },
    { label: "Signup codes", value: signupCodes, href: "/admin/signup-codes" },
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Command Center</h1>
          <p className="text-sm text-slate-400">
            Provision and manage hotels, users, and PMS connections.
          </p>
        </div>
        <Link
          href="/admin/hotels/new"
          className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400"
        >
          + New hotel
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {stats.map((s) => (
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
              <Link href="/admin/hotels/new" className="text-sky-300 hover:underline">
                Create the first one →
              </Link>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
