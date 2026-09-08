"use client";

import { InviteStatusPill } from "@/components/admin/status-pill";
import type {
  AdminHotelUserRow,
  AdminPendingInviteRow,
  HotelRole,
} from "@/lib/admin/types";
import { HOTEL_ROLES } from "@/lib/roles";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

export function HotelMembershipsCard({
  hotelId,
  memberships,
  pendingInvites,
}: {
  hotelId: string;
  memberships: AdminHotelUserRow[];
  pendingInvites: AdminPendingInviteRow[];
}) {
  const router = useRouter();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<HotelRole>("hotel_admin");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function invite() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/hotels/${hotelId}/memberships/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Invite failed");
        return;
      }
      setMessage(
        body.existingUser
          ? `${inviteEmail} already existed — added to the hotel.`
          : `Invite email sent to ${inviteEmail}.`,
      );
      setInviteEmail("");
      router.refresh();
    });
  }

  function changeRole(membershipId: string, userId: string, role: HotelRole) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/admin/hotels/${hotelId}/memberships/${membershipId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, role }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to change role");
        return;
      }
      router.refresh();
    });
  }

  function remove(membershipId: string, userId: string) {
    if (!confirm("Remove this user from the hotel?")) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/admin/hotels/${hotelId}/memberships/${membershipId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to remove");
        return;
      }
      router.refresh();
    });
  }

  function revokeInvite(pendingId: string) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/pending-invites/${pendingId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to revoke");
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="rounded border border-slate-800 bg-slate-900">
      <header className="border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Members
        </h2>
      </header>

      <div className="grid gap-3 border-b border-slate-800 p-4 sm:grid-cols-[1fr_auto_auto]">
        <input
          type="email"
          placeholder="email@customer.com"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          className="rounded bg-slate-950 p-2 text-sm text-slate-100"
        />
        <select
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value as HotelRole)}
          className="rounded bg-slate-950 p-2 text-sm text-slate-100"
        >
          {HOTEL_ROLES.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={invite}
          disabled={pending || !inviteEmail}
          className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-60"
        >
          Invite
        </button>
        {message && (
          <p className="sm:col-span-3 text-xs text-emerald-300">{message}</p>
        )}
        {error && <p className="sm:col-span-3 text-xs text-rose-300">{error}</p>}
      </div>

      <table className="w-full text-left text-sm">
        <thead className="bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2">Email</th>
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2">Role</th>
            <th className="px-4 py-2">Since</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {memberships.map((m) => (
            <tr key={m.membership_id} className="hover:bg-slate-800/40">
              <td className="px-4 py-3 font-medium text-slate-100">{m.email}</td>
              <td className="px-4 py-3 text-slate-300">{m.full_name ?? "—"}</td>
              <td className="px-4 py-3">
                <select
                  value={m.role}
                  onChange={(e) => changeRole(m.membership_id, m.user_id, e.target.value as HotelRole)}
                  disabled={pending}
                  className="rounded bg-slate-950 p-1 text-xs text-slate-100"
                >
                  {HOTEL_ROLES.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3 text-slate-400">{formatDate(m.created_at)}</td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  onClick={() => remove(m.membership_id, m.user_id)}
                  disabled={pending}
                  className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:border-rose-400 disabled:opacity-60"
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {memberships.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-400">
                No active members.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {pendingInvites.length > 0 && (
        <>
          <h3 className="border-t border-slate-800 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Outstanding invites ({pendingInvites.length})
          </h3>
          <ul className="divide-y divide-slate-800">
            {pendingInvites.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div>
                  <div className="font-medium text-slate-100">{inv.email}</div>
                  <div className="text-xs text-slate-400">
                    {inv.role.replace("_", " ")} · invited{" "}
                    {new Date(inv.invited_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <InviteStatusPill status={inv.status} />
                  <button
                    type="button"
                    onClick={() => revokeInvite(inv.id)}
                    disabled={pending}
                    className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:border-rose-400 disabled:opacity-60"
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
