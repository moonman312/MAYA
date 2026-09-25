"use client";

import { useEffect, useRef } from "react";
import { links, type Arrival } from "@/lib/deep-links";
import { NOTE_TEXT } from "@/lib/deep-links/notes";
import { track } from "@/lib/analytics/track";
import { setDashboardQuery } from "./use-dashboard-url";
import { flashWhenReady } from "./flash";

/** The one quiet line a link can leave (only from the fixed list), with a way to close it. */
export function ArrivalNote({ note, onClose }: { note: string | null; onClose: () => void }) {
  const text = note ? NOTE_TEXT[note] : undefined;
  if (!text) return null;
  return (
    <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm text-slate-300">
      <span>{text}</span>
      <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer text-slate-500 hover:text-slate-300">
        ×
      </button>
    </div>
  );
}

/** Beside a form a link filled in, until it is sent, cleared or closed. */
export function FilledChip({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
      Filled in from a link
    </span>
  );
}

/**
 * For the Team, Billing and review pages: reads what a link brought once,
 * takes everything that applies once out of the address, notes the arrival,
 * and highlights the place. What the page fills in (an invite role, a review
 * step) the server already passed down, checked the same way.
 */
export function ArrivalFlash({ flashIds }: { flashIds: Partial<Record<string, string>> }) {
  const arrived = useRef<Arrival | null>(null);
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = readArrivalOnce();
      const a = arrived.current;
      if (a.dest) track("deeplink.opened", { dest: a.dest, filled: links.fills(a.params), noted: Boolean(a.note) });
    }
    const a = arrived.current;
    if (!a.dest) return;
    const target = (a.focus && flashIds[a.focus]) ?? flashIds[a.dest];
    if (target) return flashWhenReady(target);
  }, [flashIds]);
  return null;
}

/**
 * Reads what a link brought, then rewrites the address to the place alone,
 * so a refresh, the back button or a copied address never fills anything again.
 */
export function readArrivalOnce(): Arrival {
  const arrival = links.readArrival(window.location.search);
  const before = window.location.search.replace(/^\?/, "");
  if (before !== arrival.keep) setDashboardQuery(arrival.keep, "replace");
  return arrival;
}
