"use client";

import { useState } from "react";

/**
 * The Marketplace properties an owner said "not now" to, each with the way
 * back. "Set up" clears the flag and lands on /onboarding, which offers the
 * property again the same way it did the first time. Renders nothing when the
 * list is empty; the page decides whether to show the section at all.
 */
export type DeferredPropertyItem = {
  hotelId: string;
  name: string;
  /** Already formatted for display — the server has the owner's locale in hand. */
  deferredOn: string;
};

export function DeferredProperties({ items }: { items: DeferredPropertyItem[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setUp(hotelId: string) {
    setError(null);
    setBusyId(hotelId);
    try {
      const res = await fetch("/api/onboarding/defer", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not pick that property back up.");
        setBusyId(null);
        return;
      }
      // Hard navigation on purpose: /onboarding re-reads the queue server-side
      // and this property is now at the front of it.
      window.location.assign("/onboarding");
    } catch {
      setError("Could not reach MAYA. Try again.");
      setBusyId(null);
    }
  }

  if (items.length === 0) return null;

  return (
    <ul className="divide-y divide-slate-800">
      {items.map((item) => (
        <li key={item.hotelId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-slate-100">{item.name}</div>
            <div className="text-xs text-slate-400">Set aside {item.deferredOn}</div>
          </div>
          <button
            type="button"
            onClick={() => void setUp(item.hotelId)}
            disabled={busyId !== null}
            className="rounded border border-slate-600 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-400 disabled:opacity-40"
          >
            {busyId === item.hotelId ? "Opening…" : "Set up"}
          </button>
        </li>
      ))}
      {error && (
        <li className="px-4 py-3">
          <p role="alert" className="text-xs text-rose-300">
            {error}
          </p>
        </li>
      )}
    </ul>
  );
}
