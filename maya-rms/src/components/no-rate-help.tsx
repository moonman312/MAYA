"use client";

/**
 * The line on a day card for a night the property system has no rate for:
 * MAYA does not price such a night or send to it (engine/base-price.ts,
 * audit A6). One short line on the card; the why and the what-to-do sit
 * behind the same hover-and-click "?" the manual price editor uses.
 */

import { HOVER_BRIDGE, LearnMore } from "@/components/deep-links/help-links";
import { useEffect, useId, useRef, useState } from "react";

export function NoRateLine({ pmsName }: { pmsName: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-amber-300" data-testid="no-rate-line">
      <span>No rate in {pmsName} for this night yet</span>
      <NoRateHelp pmsName={pmsName} />
    </p>
  );
}

function NoRateHelp({ pmsName }: { pmsName: string }) {
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
        aria-label="Why this night has no price"
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHovered(true)}
        onBlur={blurOut}
        className="flex size-4 cursor-pointer items-center justify-center rounded-full border border-slate-600 text-[10px] font-semibold leading-none text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-200 focus-visible:border-sky-400 focus-visible:text-sky-200 focus-visible:outline-none"
      >
        ?
      </button>

      {open && (
        <span className={HOVER_BRIDGE}>
          <span
            id={panelId}
            role="group"
            aria-label="A night with no rate"
            className="block w-72 rounded-lg border border-slate-700 bg-slate-950 p-3 text-left shadow-xl"
          >
            <span className="block text-xs font-semibold text-slate-200">A night with no rate</span>
            <span className="mt-2 block space-y-1.5 text-xs leading-snug text-slate-400">
              <span className="block">
                {pmsName} has no rate for this night, so your rules have nothing to start from. Nothing is priced or
                sent for it.
              </span>
              <span className="block">
                Load a rate for it in {pmsName} and it is priced within the hour, on that rate.
              </span>
              <span className="block">Or type a price here. A price you type is sent as it is.</span>
            </span>
            <LearnMore panel="no-rate" onBlurOut={blurOut} />
          </span>
        </span>
      )}
    </span>
  );
}
