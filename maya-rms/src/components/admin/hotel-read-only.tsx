import { PmsStatusPill } from "@/components/admin/status-pill";
import type { AdminHotelUserRow, PmsConnectionStatus, PmsType } from "@/lib/admin/types";
import { roleLabel } from "@/lib/roles";

/**
 * A property's page as a developer or sales login sees it: the same facts as
 * a platform admin's cards, with no control on them. Server components, so
 * nothing here can send a change; the routes behind the admin's controls
 * refuse anyone but a platform admin anyway, and the database refuses them
 * too.
 */

export function ReadOnlyPricingMode({ simulationMode, isTest }: { simulationMode: boolean; isTest: boolean }) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900">
      <header className="border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Pricing mode</h2>
      </header>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Mode</dt>
          <dd className="text-slate-200">{simulationMode ? "Simulation" : "Live"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Test property</dt>
          <dd className="text-slate-200">{isTest ? "Yes" : "No"}</dd>
        </div>
      </dl>
    </section>
  );
}

export function ReadOnlyPmsCard({
  pmsType,
  pmsStatus,
  lastSyncAt,
}: {
  pmsType: PmsType | null;
  pmsStatus: PmsConnectionStatus | null;
  lastSyncAt: string | null;
}) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">PMS connection</h2>
        <div className="flex items-center gap-2 text-sm">
          {pmsType ? <span className="text-slate-300">{pmsType}</span> : null}
          <PmsStatusPill status={pmsStatus} />
        </div>
      </header>
      <p className="p-4 text-sm text-slate-400">
        Last sync {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "never"}.
      </p>
    </section>
  );
}

export function ReadOnlyMembersCard({ memberships }: { memberships: AdminHotelUserRow[] }) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900">
      <header className="border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Members</h2>
      </header>
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Email</th>
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2">Role</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Since</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {memberships.map((m) => (
            <tr key={m.membership_id}>
              <td className="px-4 py-3 font-medium text-slate-100">{m.email}</td>
              <td className="px-4 py-3 text-slate-300">{m.full_name ?? "n/a"}</td>
              <td className="px-4 py-3 text-slate-300">{roleLabel(m.role)}</td>
              <td className="px-4 py-3 capitalize text-slate-400">{m.status}</td>
              <td className="px-4 py-3 text-slate-400">{new Date(m.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
          {memberships.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-400">
                No members.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
