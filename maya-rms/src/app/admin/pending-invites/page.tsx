import { InviteStatusPill } from "@/components/admin/status-pill";
import { InviteRowActions } from "@/components/admin/invite-row-actions";
import { listPendingInvites } from "@/lib/admin/memberships";
import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";

export const dynamic = "force-dynamic";

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default async function AdminPendingInvitesPage() {
  const ssr = createClient(await cookies());
  const invites = await listPendingInvites(ssr);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Pending invites</h1>
        <p className="text-sm text-slate-400">{invites.length} total</p>
      </div>

      <div className="overflow-hidden rounded border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Hotel</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Invited by</th>
              <th className="px-4 py-3">Invited</th>
              <th className="px-4 py-3">Accepted</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {invites.map((inv) => (
              <tr key={inv.id} className="hover:bg-slate-800/40">
                <td className="px-4 py-3 font-medium text-slate-100">{inv.email}</td>
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/hotels/${inv.hotel_id}`}
                    className="text-sky-300 hover:underline"
                  >
                    {inv.hotel_name}
                  </Link>
                </td>
                <td className="px-4 py-3 capitalize text-slate-300">{inv.role.replace("_", " ")}</td>
                <td className="px-4 py-3">
                  <InviteStatusPill status={inv.status} />
                </td>
                <td className="px-4 py-3 text-slate-400">{inv.invited_by_email ?? "—"}</td>
                <td className="px-4 py-3 text-slate-400">{formatDateTime(inv.invited_at)}</td>
                <td className="px-4 py-3 text-slate-400">{formatDateTime(inv.accepted_at)}</td>
                <td className="px-4 py-3">
                  {inv.status === "pending" ? (
                    <InviteRowActions pendingId={inv.id} email={inv.email} />
                  ) : (
                    <span className="text-xs text-slate-600">—</span>
                  )}
                </td>
              </tr>
            ))}
            {invites.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">
                  No pending invites.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
