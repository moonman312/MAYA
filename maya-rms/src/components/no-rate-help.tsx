"use client";

/**
 * The line on a day card for a night MAYA does not price because of the
 * property system's rates, with its "?": the why and the what-to-do sit
 * behind the same hover-and-click "?" the manual price editor uses.
 *
 *   NoRateLine       the system has no rate for the night, and nobody typed
 *                    a price (engine/base-price.ts, audit A6).
 *   RemovedRateLine  the system removed the rate after MAYA sent its price,
 *                    and the property keeps changes made there
 *                    (pms-edits.ts): MAYA stops pricing the night until the
 *                    system has a rate again.
 *
 * Both end on what a typed price does. While the property is simulating a
 * typed price is sent nowhere until it goes live, and the line says so.
 */

/** What a price typed on this night does, in the property's mode. */
export function typedPriceLine(simulating: boolean): string {
  return simulating
    ? "Or type a price here. Once you go live, a price you type is sent as it is."
    : "Or type a price here. A price you type is sent as it is.";
}

import { HOVER_BRIDGE, LearnMore } from "@/components/deep-links/help-links";
import type { HelpPanel } from "@/lib/deep-links";
import { useEffect, useId, useRef, useState } from "react";

export function NoRateLine({ pmsName, simulating = false }: { pmsName: string; simulating?: boolean }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-amber-300" data-testid="no-rate-line">
      <span>No rate in {pmsName} for this night yet</span>
      <RateHelp
        button="Why this night has no price"
        title="A night with no rate"
        panel="no-rate"
        lines={[
          `${pmsName} has no rate for this night, so your rules have nothing to start from. Nothing is priced or sent for it.`,
          `Load a rate for it in ${pmsName} and it is priced within the hour, on that rate.`,
          typedPriceLine(simulating),
        ]}
      />
    </p>
  );
}

export function RemovedRateLine({ pmsName, simulating = false }: { pmsName: string; simulating?: boolean }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-amber-300" data-testid="removed-rate-line">
      <span>Rate removed in {pmsName}, so MAYA isn&apos;t pricing this night</span>
      <RateHelp
        button="Why MAYA isn't pricing this night"
        title="A rate removed"
        panel="pms-removed"
        lines={[
          `${pmsName} no longer has a rate for this night, after MAYA sent its price. You keep changes made in ${pmsName}, so nothing is priced or sent for it.`,
          `Load a rate in ${pmsName} and MAYA reads it within the hour. If it isn't MAYA's last price, it is kept as your price.`,
          typedPriceLine(simulating),
        ]}
      />
    </p>
  );
}

function RateHelp({ button, title, lines, panel }: { button: string; title: string; lines: string[]; panel: HelpPanel }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const open = pinned || hovered;
  const blurOut = (e: React.FocusEvent) => {
    if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setHovered(false);
  };

  useEffect(() => {
    if (!pinned) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPinned(false);
    }
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setPinned(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [pinned]);

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={button}
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHovered(true)}
        onBlur={blurOut}
        className="flex size-4 cursor-pointer items-center justify-center rounded-full border border-slate-600 text-[0.625rem] font-semibold leading-none text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-200 focus-visible:border-sky-400 focus-visible:text-sky-200 focus-visible:outline-none"
      >
        ?
      </button>

      {open && (
        <span className={HOVER_BRIDGE}>
          <span
            id={panelId}
            role="group"
            aria-label={title}
            className="block w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-slate-700 bg-slate-950 p-3 text-left shadow-xl"
          >
            <span className="block text-xs font-semibold text-slate-200">{title}</span>
            <span className="mt-2 block space-y-1.5 text-xs leading-snug text-slate-400">
              {lines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </span>
            <LearnMore panel={panel} onBlurOut={blurOut} />
          </span>
        </span>
      )}
    </span>
  );
}
