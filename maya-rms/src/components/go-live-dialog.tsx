"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * The confirm step every go-live switch shows before it calls the server.
 * Going live is the one change that starts MAYA writing to the hotel's PMS,
 * so the owner's onboarding button and the platform admin's Live switch both
 * say, in the same words, what happens next.
 *
 * What it claims is what the code does: the scheduled push sends the nights
 * of the pricing window (pricingHorizonDays, passed in as `windowDays`) on
 * the sync cycle, about every 5 minutes, writing over the rate those nights
 * have in the PMS, and after that sends a night again when its price changes.
 * Only Cloudbeds and Think have a rate push; for anything else the dialog
 * says nothing is sent. Nor is anything sent without a connection the sync
 * picks up (none, disconnected, or pending payment), and the admin switch,
 * which can see the connection, says so.
 */

/** The PMSes with a rate push adapter (_shared/cloudbeds/rate-push.ts, _shared/think/rate-push.ts). */
const PMS_WITH_RATE_PUSH = new Set(["cloudbeds", "think"]);

const PMS_NAMES: Record<string, string> = {
  cloudbeds: "Cloudbeds",
  think: "Think Reservations",
  mews: "Mews",
  opera: "Opera",
};

/** Connection statuses the scheduled sync does not pick up (claim_pms_sync_batch). */
const NOT_SYNCED = new Set(["disconnected", "pending"]);

/**
 * Whether the scheduled sync picks up a hotel's connection, from what the
 * admin hotel row says: its PMS and that connection's status.
 */
export function pmsConnected(pmsType: string | null, pmsStatus: string | null): boolean {
  return pmsType != null && pmsStatus != null && !NOT_SYNCED.has(pmsStatus);
}

/**
 * The dialog's sentences. `connected` is whether the hotel has a connection
 * the sync picks up; left out, it is taken as yes. Exported for tests.
 */
export function goLiveCopy(p: { pmsType: string | null; windowDays: number | null; connected?: boolean }): {
  title: string;
  lines: string[];
} {
  if (p.connected === false) {
    return { title: "Go live?", lines: ["No PMS is connected, so nothing is sent until one is."] };
  }
  const known = p.pmsType ? PMS_NAMES[p.pmsType] : undefined;
  const pms = known ?? "your PMS";
  // Without `connected`, a PMS that could not be read (null) is taken as one
  // MAYA sends to: that is the owner's onboarding screen, which only goes live
  // after onboarding connected one, and onboarding only connects those.
  if (p.pmsType && !PMS_WITH_RATE_PUSH.has(p.pmsType)) {
    return {
      title: "Go live?",
      lines: [`MAYA doesn't send rates to ${pms} yet, so nothing is sent. The hotel only shows as live.`],
    };
  }
  const nights = p.windowDays != null && p.windowDays > 0 ? ` for the next ${p.windowDays} nights` : "";
  return {
    title: `Send prices to ${pms}?`,
    lines: [
      `MAYA starts sending its prices${nights} to ${pms} on the next cycle, in about 5 minutes.`,
      `Each price it sends replaces that night's rate in ${pms}, and a night is sent again whenever its price changes.`,
    ],
  };
}

export function GoLiveDialog({
  open,
  pmsType,
  connected,
  windowDays,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  /** pms_connections.pms_type of the hotel's connection; null when not known. */
  pmsType: string | null;
  /** Whether the sync picks that connection up (pmsConnected); left out when not known. */
  connected?: boolean;
  /** The push window in nights (pricingHorizonDays); null leaves the number out. */
  windowDays: number | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** Anything the confirming press also means, shown above the buttons. */
  children?: ReactNode;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;
  const copy = goLiveCopy({ pmsType, windowDays, connected });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-5 text-left shadow-xl">
        <h3 id={titleId} className="text-lg font-semibold text-slate-100">
          {copy.title}
        </h3>
        {copy.lines.map((line) => (
          <p key={line} className="mt-3 text-sm leading-relaxed text-slate-300">
            {line}
          </p>
        ))}
        {children}
        {error ? <p className="mt-3 text-xs text-rose-300">{error}</p> : null}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="cursor-pointer rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
          >
            {busy ? "Switching…" : "Go live"}
          </button>
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="cursor-pointer rounded px-4 py-2 text-sm text-slate-400 hover:text-slate-200 disabled:opacity-60 sm:mr-auto"
          >
            Not yet
          </button>
        </div>
      </div>
    </div>
  );
}
