"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { TERMS_URL, TERMS_VERSION } from "@/lib/legal/versions";
import { PMS_SENDS_PRICES, pmsLabel } from "@/lib/price-mode";

/**
 * The confirm step every go-live switch shows before it calls the server.
 * Going live is the one change that starts MAYA writing to the hotel's PMS,
 * so the owner's two ways in (the simulation strip's Go live on every
 * property screen, and the review card's button) and the platform admin's
 * Live switch all say, in the same words, what happens next. The owner's two
 * confirm with requestGoLive, the one route that takes a property live.
 *
 * What it claims is what the code does: the scheduled push sends the nights
 * of the pricing window (pricingHorizonDays, passed in as `windowDays`) on
 * the sync cycle, about every 5 minutes, writing over the rate those nights
 * have in the PMS, and after that sends a night again when its price changes.
 * Only Cloudbeds and Think have a rate push; for anything else the dialog
 * says nothing is sent. Each has its own sending switch (audit A25), and
 * ThinkReservations' starts off: while a system's switch is off
 * (`sendingOn` false, from what its sync last reported), the dialog says
 * going live sends nothing yet. Nor is anything sent without a connection
 * the sync picks up (none, disconnected, or pending payment), and the admin
 * switch, which can see the connection, says so. The owner's confirm names the
 * property it takes live, and the call carries that property's id, so a tab
 * left on one property never takes another live.
 */

/** The PMSes with a rate push adapter (_shared/cloudbeds/rate-push.ts, _shared/think/rate-push.ts). */
const PMS_WITH_RATE_PUSH = PMS_SENDS_PRICES;

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
 * the sync picks up; left out, it is taken as yes. `propertyName`, when
 * given, names the property in the title. Exported for tests.
 */
export function goLiveCopy(p: {
  pmsType: string | null;
  windowDays: number | null;
  connected?: boolean;
  propertyName?: string | null;
  /** Whether sending to that system is switched on (simulation-strip.ts sendingSwitchOn); left out, taken as on. */
  sendingOn?: boolean;
}): {
  title: string;
  lines: string[];
} {
  const name = p.propertyName?.trim() || null;
  const goLive = name ? `Take ${name} live?` : "Go live?";
  if (p.connected === false) {
    return { title: goLive, lines: ["No PMS is connected, so nothing is sent until one is."] };
  }
  const known = p.pmsType ? PMS_NAMES[p.pmsType] : undefined;
  const pms = known ?? "your PMS";
  // Without `connected`, a PMS that could not be read (null) is taken as one
  // MAYA sends to: that is the owner's onboarding screen, which only goes live
  // after onboarding connected one, and onboarding only connects those.
  if (p.pmsType && !PMS_WITH_RATE_PUSH.has(p.pmsType)) {
    return {
      title: goLive,
      lines: [`MAYA doesn't send prices to ${pms} yet, so nothing is sent. The hotel only shows as live.`],
    };
  }
  // A system MAYA sends to whose switch is off (ThinkReservations until MAYA switches it on).
  if (p.sendingOn === false && p.pmsType && PMS_WITH_RATE_PUSH.has(p.pmsType)) {
    return {
      title: goLive,
      lines: [
        `Sending to ${pms} isn't on yet, so nothing is sent until MAYA switches it on. Your prices wait until then.`,
        `Once it's on, each price MAYA sends replaces that night's rate in ${pms}, and a night is sent again whenever its price changes.`,
      ],
    };
  }
  const nights = p.windowDays != null && p.windowDays > 0 ? ` for the next ${p.windowDays} nights` : "";
  return {
    title: name ? `Send ${name}'s prices to ${pms}?` : `Send prices to ${pms}?`,
    lines: [
      `MAYA starts sending its prices${nights} to ${pms} on the next cycle, in about 5 minutes.`,
      `Each price it sends replaces that night's rate in ${pms}, and a night is sent again whenever its price changes.`,
    ],
  };
}

/** Fired on window once a property went live from this tab, so every way in shows it at once. */
export const WENT_LIVE_EVENT = "maya:went-live";

/**
 * The owner's go-live: POST /api/onboarding/activate, which takes the active
 * property live for a General Manager or Hotel Admin (the database refuses
 * anyone else) and records the press with the Terms version shown here.
 * `hotelId` is the property the page shows: the route refuses when the
 * active property is another one by now (a switch in another tab). Resolves
 * to null once live, or to the reason it didn't switch.
 */
export async function requestGoLive(hotelId?: string | null): Promise<string | null> {
  try {
    const res = await fetch("/api/onboarding/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ termsVersion: TERMS_VERSION, ...(hotelId ? { hotelId } : {}) }),
    });
    if (res.ok) {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(WENT_LIVE_EVENT, { detail: { hotelId: hotelId ?? null } }));
      return null;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? "Couldn't switch to live. Try again.";
  } catch (e) {
    return e instanceof Error ? e.message : "Couldn't switch to live. Try again.";
  }
}

/**
 * What pressing go-live means, said where it is pressed: in the confirm
 * dialog, above its Go live button. Terms 3.3 treats that press as confirming
 * the rules and limits were reviewed, so the confirmation is stated beside the
 * button rather than left to Terms accepted weeks earlier, possibly by someone
 * else. A line, not a checkbox: the dialog is the one extra click.
 */
export function GoLiveConfirmation({ pmsType = null, sendingOn }: { pmsType?: string | null; sendingOn?: boolean }) {
  return (
    <p className="mt-2 text-[0.6875rem] leading-relaxed text-slate-400">
      Going live sends MAYA&apos;s prices to {pmsLabel(pmsType)} automatically
      {sendingOn === false && pmsType && PMS_WITH_RATE_PUSH.has(pmsType) ? " once sending is on" : ""}. You&apos;re confirming you&apos;ve
      reviewed your rules and limits (
      <a
        href={TERMS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-slate-600 underline-offset-2 hover:text-slate-200"
      >
        Terms
      </a>{" "}
      3.3).
    </p>
  );
}

/**
 * The confirm's count of nights whose own rate in the PMS sits outside a
 * room type's floor or ceiling, or null when there are none to mention (Jake,
 * 2026-09-30, audit A21). Going live sends those nights at the limit with no
 * rule behind it. Exported for tests.
 */
export function outsideLimitsLine(nights: number | null | undefined): string | null {
  if (nights == null || !Number.isFinite(nights) || nights <= 0) return null;
  const n = Math.floor(nights);
  return n === 1
    ? "1 night has a rate outside your floor or ceiling; MAYA will move it inside when it sends."
    : `${n.toLocaleString("en-US")} nights have a rate outside your floor or ceiling; MAYA will move them inside when it sends.`;
}

/**
 * outsideLimitsLine for the property on screen, read when the confirm opens
 * (GET /api/property/outside-limits). Only where MAYA sends prices and a
 * connection is there to send them; nothing shows while it reads or when the
 * count can't be had, and the confirm never waits on it.
 */
export function OutsideLimitsLine({
  hotelId,
  pmsType,
  connected,
}: {
  hotelId: string | null | undefined;
  pmsType: string | null;
  connected?: boolean;
}) {
  const [nights, setNights] = useState<number | null>(null);
  const sends = connected !== false && (pmsType == null || PMS_WITH_RATE_PUSH.has(pmsType));
  useEffect(() => {
    if (!sends) return;
    let alive = true;
    const query = hotelId ? `?hotelId=${encodeURIComponent(hotelId)}` : "";
    fetch(`/api/property/outside-limits${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { nights?: unknown } | null) => {
        if (alive) setNights(typeof body?.nights === "number" ? body.nights : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hotelId, sends]);
  const line = sends ? outsideLimitsLine(nights) : null;
  if (!line) return null;
  return <p className="mt-3 text-sm leading-relaxed text-amber-200">{line}</p>;
}

export function GoLiveDialog({
  open,
  pmsType,
  connected,
  windowDays,
  propertyName = null,
  sendingOn,
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
  /** The property being taken live, named in the title; null leaves it out. */
  propertyName?: string | null;
  /** Whether sending to that system is switched on; left out, taken as on. */
  sendingOn?: boolean;
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
  const copy = goLiveCopy({ pmsType, windowDays, connected, propertyName, sendingOn });

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
