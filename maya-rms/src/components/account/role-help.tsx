"use client";

import { useEffect, useId, useRef, useState } from "react";
import { HOTEL_ROLES } from "@/lib/roles";

/**
 * What each role can actually do, next to the control that grants it.
 *
 * The role names are the wrong length to be self-explanatory — "General
 * Manager" and "Revenue Manager" both sound like they can do everything — and
 * the person choosing is deciding who may change their rates. Guessing is the
 * expensive option.
 *
 * Opens on hover AND on click, because those are different users: a mouse
 * hovers, a touch device cannot, and a keyboard does neither. Click toggles and
 * latches so the panel can be read at leisure; hover is a preview that closes
 * when the pointer leaves.
 */
export function RoleHelp() {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const open = pinned || hovered;

  useEffect(() => {
    if (!pinned) return;
    // A pinned panel has to be dismissable without hunting for the button
    // again — Escape, or a click anywhere else.
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
        aria-label="What each role can do"
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onClick={() => setPinned((p) => !p)}
        // Focus opens it too, so tabbing to the icon reveals the same thing
        // hovering does rather than requiring a guess that Enter will help.
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className="flex size-4 cursor-pointer items-center justify-center rounded-full border border-slate-600 text-[10px] font-semibold leading-none text-slate-400 transition-colors hover:border-slate-400 hover:text-slate-200 focus-visible:border-sky-400 focus-visible:text-sky-200 focus-visible:outline-none"
      >
        ?
      </button>

      {open && (
        <span
          id={panelId}
          role="tooltip"
          className="absolute left-1/2 top-6 z-20 w-80 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-950 p-3 text-left shadow-xl"
        >
          <span className="block text-xs font-semibold text-slate-200">What each role can do</span>
          <span className="mt-2 block space-y-2">
            {HOTEL_ROLES.map((r) => (
              <span key={r.key} className="block">
                <span className="block text-xs font-medium text-slate-100">{r.label}</span>
                <span className="block text-xs leading-snug text-slate-400">{r.description}</span>
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}
