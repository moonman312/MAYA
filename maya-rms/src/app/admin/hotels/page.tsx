import { PmsStatusPill } from "@/components/admin/status-pill";
import { billingStatusWords, modeWords, planWords, roomsOf } from "@/lib/admin/hotel-words";
import { listHotels } from "@/lib/admin/hotels";
import { requireStaffPage } from "@/lib/admin/staff-page";
import { staffCanSee } from "@/lib/admin/staff-session";
import { formatUsd } from "@/lib/billing/tiers";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";

export const dynamic = "force-dynamic";

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Every property: its PMS and connection, pricing mode, plan, rooms and
 * billing status, for every staff role. MRR only for a role that may read
 * business numbers (the database leaves it empty for anyone else, and for
 * sales on a test property). Creating a hotel is a platform admin's.
 */
export default async function AdminHotelsPage() {
  const session = await requireStaffPage("hotels");
  const showMoney = staffCanSee(session, "business_numbers");
  const canCreate = staffCanSee(session, "hotel_create");
  const ssr = createClient(await cookies());
  const hotels = await listHotels(ssr);
  const columns = showMoney ? 10 : 9;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Hotels</h1>
          <p className="text-sm text-slate-400">{hotels.length} total</p>
        </div>
        {canCreate ? (
          <Link
            href="/admin/hotels/new"
            className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400"
          >
            + New hotel
          </Link>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">PMS</th>
              <th className="px-4 py-3">Mode</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Rooms</th>
              <th className="px-4 py-3">Billing</th>
              {showMoney ? <th className="px-4 py-3">MRR</th> : null}
              <th className="px-4 py-3">Last sync</th>
              <th className="px-4 py-3">Members</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {hotels.map((h) => {
              const mode = modeWords(h);
              const rooms = roomsOf(h);
              return (
                <tr key={h.id} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/hotels/${h.id}`}
                      className="font-medium text-slate-100 hover:text-sky-300"
                    >
                      {h.name}
                    </Link>
                    {!h.is_active && (
                      <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                        inactive
                      </span>
                    )}
                    {h.is_test && (
                      <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">test</span>
                    )}
                    <div className="text-xs text-slate-500">
                      {h.timezone} · {h.currency}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {h.pms_type ? <span className="text-slate-300">{h.pms_type}</span> : null}
                      <PmsStatusPill status={h.pms_status} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{mode ?? "n/a"}</td>
                  <td className="px-4 py-3 text-slate-300">{planWords(h)}</td>
                  <td className="px-4 py-3 text-slate-300">{rooms ?? "n/a"}</td>
                  <td className="px-4 py-3 text-slate-300">{billingStatusWords(h)}</td>
                  {showMoney ? (
                    <td className="px-4 py-3 text-slate-300">
                      {h.list_mrr_cents == null ? "n/a" : formatUsd(h.list_mrr_cents)}
                    </td>
                  ) : null}
                  <td className="px-4 py-3 text-slate-400">{formatRelative(h.pms_last_sync_at)}</td>
                  <td className="px-4 py-3 text-slate-300">{h.membership_count}</td>
                  <td className="px-4 py-3 text-slate-400">{formatRelative(h.created_at)}</td>
                </tr>
              );
            })}
            {hotels.length === 0 && (
              <tr>
                <td colSpan={columns} className="px-4 py-8 text-center text-sm text-slate-400">
                  No hotels yet.{" "}
                  {canCreate ? (
                    <Link href="/admin/hotels/new" className="text-sky-300 hover:underline">
                      Create the first one →
                    </Link>
                  ) : null}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
