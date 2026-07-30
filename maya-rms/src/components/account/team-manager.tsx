"use client";

import { useCallback, useEffect, useState } from "react";
import { HOTEL_ROLES } from "@/lib/roles";
import type { TeamView } from "@/lib/account/team";

/**
 * Adding and removing the people who can see a property's rates.
 *
 * One form, one list, no modals. The seat count is stated up front rather than
 * discovered on submit — running out after typing someone's name and choosing
 * their role is the version of this that makes people email us, which is the
 * thing the screen exists to prevent.
 */

const ROLE_HELP = Object.fromEntries(HOTEL_ROLES.map((r) => [r.key, r.description]));

export function TeamManager() {
  const [team, setTeam] = useState<TeamView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("revenue_manager");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account/team", { cache: "no-store" });
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      setTeam((await res.json()) as TeamView);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite() {
    setBusy("invite");
    setError(null);
    setSent(null);
    try {
      const res = await fetch("/api/account/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not send that invitation.");
      setSent(email.trim());
      setEmail("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send that invitation.");
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, init: RequestInit, label: string) {
    setBusy(id);
    setError(null);
    setSent(null);
    try {
      const res = await fetch(`/api/account/team/${id}`, init);
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? label);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : label);
    } finally {
      setBusy(null);
    }
  }

  if (loadFailed) {
    return (
      <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="text-sm text-amber-100">We couldn&apos;t load your team just now.</p>
        <button
          type="button"
          onClick={() => {
            setLoadFailed(false);
            void load();
          }}
          className="mt-3 rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition hover:bg-amber-400"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!team) return <div className="h-32 animate-pulse rounded-lg bg-slate-900" />;

  const { seats } = team;

  return (
    <div className="space-y-6">
      <section className="rounded border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-200">Add someone</h2>
          <p className="text-xs text-slate-400">
            {Number.isFinite(seats.limit)
              ? `${seats.used} of ${seats.limit} ${seats.limit === 1 ? "seat" : "seats"} used${team.rooms > 0 ? ` · ${team.rooms} rooms` : ""}`
              : `${seats.used} ${seats.used === 1 ? "person" : "people"}`}
          </p>
        </div>

        {seats.full ? (
          <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-100">
            You&apos;ve used every seat your plan includes. Remove someone below, or raise your room
            count on the billing page if the property has grown.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="invite-email" className="block text-xs text-slate-400">
                Their email
              </label>
              <input
                id="invite-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@yourhotel.com"
                className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="invite-role" className="block text-xs text-slate-400">
                What they can do
              </label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="mt-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              >
                {HOTEL_ROLES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={invite}
              disabled={!email.trim().includes("@") || busy !== null}
              className="rounded bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
            >
              {busy === "invite" ? "Sending…" : "Send invitation"}
            </button>
          </div>
        )}

        {!seats.full && <p className="mt-2 text-xs text-slate-400">{ROLE_HELP[role]}</p>}
        {sent && (
          <p className="mt-3 text-sm text-emerald-300">
            Invitation sent to {sent}. They&apos;ll get an email with a link to join.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-rose-300">
            {error}
          </p>
        )}
      </section>

      <section className="rounded border border-slate-800 bg-slate-900">
        <h2 className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-slate-200">
          On this property
        </h2>
        <ul className="divide-y divide-slate-800">
          {team.members.map((m) => (
            <li key={m.membershipId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-100">{m.email}</div>
                <div className="text-xs text-slate-400">
                  {HOTEL_ROLES.find((r) => r.key === m.role)?.label ?? m.role}
                  {m.status !== "active" ? ` · ${m.status}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Role for ${m.email}`}
                  value={m.role}
                  disabled={busy !== null}
                  onChange={(e) =>
                    act(
                      m.membershipId,
                      {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ role: e.target.value }),
                      },
                      "Could not change that role.",
                    )
                  }
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200"
                >
                  {HOTEL_ROLES.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => act(m.membershipId, { method: "DELETE" }, "Could not remove them.")}
                  className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-rose-500/60 hover:text-rose-300 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}

          {team.invites.map((i) => (
            <li key={i.pendingId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-300">{i.email}</div>
                <div className="text-xs text-slate-400">
                  Invited · {HOTEL_ROLES.find((r) => r.key === i.role)?.label ?? i.role} · not
                  accepted yet
                </div>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  act(
                    `${i.pendingId}?kind=invite`,
                    { method: "DELETE" },
                    "Could not cancel that invitation.",
                  )
                }
                className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-50"
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
