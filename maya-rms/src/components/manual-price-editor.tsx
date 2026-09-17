"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Type a price for one room type on one night (or a run of nights) and it is
 * what goes to the PMS. Sits inside the calendar's day card, one per room
 * type, so it has to stay small: an amount, an optional end date, Save, Clear.
 *
 * What a manual price actually does (pauses rules that already fired, later
 * rules still apply on top, clearing hands the night back to MAYA) lives
 * behind the "?" — it matters, but not on every card, every time.
 */

type Pushed = "nudged" | "next_cycle" | "simulation" | "beyond_window" | "zero_not_sent";

type SaveResponse = {
  ok: boolean;
  cells: number;
  suppressedRules: number;
  retiredPickups: number;
  pushed: Pushed;
  /**
   * Nights inside the push window today vs. past it, and the window's length.
   * Older servers omit it, or omit `days` (their window was 60 days).
   */
  pushWindow?: { now: number; later: number; days?: number };
  preview: { stay_date: string; base: number; final: number; clamped_by: string | null }[];
};

/** What servers sent before the window's length was in the response. */
const DEFAULT_WINDOW_DAYS = 60;

function pushedCopy(pushed: Pushed, pmsName: string, pushWindow?: SaveResponse["pushWindow"]): string {
  const days = pushWindow?.days ?? DEFAULT_WINDOW_DAYS;
  // A range across the edge of the window gets the honest per-night version:
  // what leaves now, and what waits. Only when both sides have something in
  // them — otherwise the single-state sentence below already tells the truth.
  if (pushWindow && pushWindow.now > 0 && pushWindow.later > 0 && (pushed === "nudged" || pushed === "next_cycle")) {
    const { now, later } = pushWindow;
    const when = pushed === "nudged" ? "now" : "on the next cycle (about 5 min)";
    return `Saved. ${now} night${now === 1 ? "" : "s"} sending to ${pmsName} ${when}; ${later} more will be sent as ${
      later === 1 ? "it enters" : "they enter"
    } the ${days}-day window.`;
  }
  switch (pushed) {
    case "nudged":
      return `Saved. Sending to ${pmsName} now.`;
    case "next_cycle":
      return `Saved. Sending to ${pmsName} on the next cycle (about 5 min).`;
    case "simulation":
      return `Saved (simulation: not sent to ${pmsName}).`;
    case "beyond_window":
      return `Saved. It will be sent when the date enters the ${days}-day push window.`;
    case "zero_not_sent":
      return `Saved. MAYA doesn't send a price of 0 to ${pmsName}, so set the night to 0 there yourself.`;
    default:
      return "Saved.";
  }
}

function nightsWord(cells: number | undefined): string {
  return cells != null && cells > 1 ? `these ${cells} nights` : "this night";
}

/** The one-line confirmation after a save, in house voice. Exported for tests. */
export function describeSave(
  res: Pick<SaveResponse, "pushed" | "suppressedRules" | "retiredPickups" | "pushWindow"> & { cells?: number },
  pmsName: string,
): string {
  const paused = (res.suppressedRules ?? 0) + (res.retiredPickups ?? 0);
  const base = pushedCopy(res.pushed, pmsName, res.pushWindow);
  if (paused <= 0) return base;
  return `${base} Paused ${paused} rule${paused === 1 ? "" : "s"} on ${nightsWord(res.cells)} for this room; new rules will apply on top.`;
}

/** An open manual price as the day card and the editor see it. */
export type ManualPriceShown = { price: number; set_at: string; source?: "maya" | "pms"; pms_type?: string | null };

/**
 * The day card's badge: "Manual" for a price typed in MAYA, "Changed in
 * Cloudbeds" for a rate the hotel changed in its PMS on a night MAYA had
 * sent. `pmsName` is where that change was made. Exported for tests.
 */
export function manualPriceBadge(manual: Pick<ManualPriceShown, "price" | "source">, pmsName: string): string {
  const amount = `$${manual.price.toFixed(2)}`;
  return manual.source === "pms" ? `Changed in ${pmsName} · ${amount}` : `Manual · ${amount}`;
}

/** The line after a clear. Exported for tests. */
export function describeClear(cells: number | undefined): string {
  return cells != null && cells > 1
    ? `Cleared ${cells} nights. MAYA is pricing them again.`
    : "Cleared. MAYA is pricing this night again.";
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // Not JSON — fall through to the generic line.
  }
  return fallback;
}

export function ManualPriceEditor({
  hotelId,
  roomTypeId,
  roomTypeName,
  stayDate,
  currentPrice,
  manualPrice,
  pmsName,
  onSaved,
}: {
  hotelId: string;
  roomTypeId: string;
  roomTypeName: string;
  /** Where the price goes, by name ("Cloudbeds", "Think Reservations"), for the copy. */
  pmsName: string;
  /** YYYY-MM-DD, the hotel's calendar date for the selected day. */
  stayDate: string;
  /** What the night is asking today; pre-fills the input when no manual price exists. */
  currentPrice: number | null;
  manualPrice: ManualPriceShown | null;
  /** Fired after a successful save or clear so the calendar can refetch. */
  onSaved: () => void;
}) {
  const prefill = manualPrice?.price ?? currentPrice;
  const [value, setValue] = useState<string>(prefill != null ? String(prefill) : "");
  const [rangeOpen, setRangeOpen] = useState(false);
  const [through, setThrough] = useState(stayDate);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // A save or a live refresh can change what the night is worth; follow it,
  // but only when the number itself moves so a refresh mid-typing doesn't
  // wipe what someone is entering.
  useEffect(() => {
    setValue(prefill != null ? String(prefill) : "");
  }, [prefill]);

  const parsed = Number(value);
  const valueOk = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const throughOk = !rangeOpen || (through >= stayDate && /^\d{4}-\d{2}-\d{2}$/.test(through));

  async function save() {
    if (!valueOk || !throughOk || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/manual-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelId,
          roomTypeId,
          dateFrom: stayDate,
          ...(rangeOpen && through !== stayDate ? { dateTo: through } : {}),
          price: parsed,
        }),
      });
      if (!res.ok) {
        setMessage({ kind: "error", text: await readError(res, "Couldn't save that price.") });
        return;
      }
      const body = (await res.json()) as SaveResponse;
      setMessage({ kind: "ok", text: describeSave(body, pmsName) });
      onSaved();
    } catch {
      setMessage({ kind: "error", text: "Couldn't reach MAYA. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/manual-price", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelId,
          roomTypeId,
          dateFrom: stayDate,
          ...(rangeOpen && through !== stayDate ? { dateTo: through } : {}),
        }),
      });
      if (!res.ok) {
        setMessage({ kind: "error", text: await readError(res, "Couldn't clear that price.") });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { cells?: number };
      setMessage({ kind: "ok", text: describeClear(body.cells) });
      onSaved();
    } catch {
      setMessage({ kind: "error", text: "Couldn't reach MAYA. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 border-t border-slate-800 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-400">
          $
          <input
            type="number"
            step="any"
            min="0"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            className="w-24 rounded border border-slate-700 bg-slate-950 p-1 text-sm text-slate-200"
            aria-label={`Manual price for ${roomTypeName}`}
          />
        </label>
        {rangeOpen ? (
          <label className="flex items-center gap-1 text-xs text-slate-400">
            through
            <input
              type="date"
              value={through}
              min={stayDate}
              disabled={busy}
              onChange={(e) => setThrough(e.target.value)}
              className="rounded border border-slate-700 bg-slate-950 p-1 text-sm text-slate-200"
              aria-label="Last night this price applies to"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRangeOpen(false);
                setThrough(stayDate);
              }}
              className="cursor-pointer text-xs text-slate-500 hover:text-slate-300"
              aria-label="Back to a single night"
            >
              ×
            </button>
          </label>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setRangeOpen(true)}
            className="cursor-pointer text-xs text-slate-500 hover:text-slate-300"
          >
            through…
          </button>
        )}
        <ManualPriceHelp pmsName={pmsName} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !valueOk || !throughOk}
          onClick={() => void save()}
          className="cursor-pointer rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
        >
          Save
        </button>
        {manualPrice ? (
          <button
            type="button"
            disabled={busy}
            title={manualPrice.source === "pms" ? `Changed in ${pmsName}. Clear hands the night back to MAYA.` : undefined}
            onClick={() => void clear()}
            className="cursor-pointer rounded border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 hover:border-slate-500 disabled:opacity-60"
          >
            Clear
          </button>
        ) : null}
      </div>
      {message ? (
        <p
          className={`mt-2 text-xs ${message.kind === "ok" ? "text-emerald-300" : "text-rose-300"}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Same hover-and-click "?" as the team tab's RoleHelp, with this control's
 * explanation in it. Kept local rather than generalised: two copies of a
 * twenty-line popover beat a helper component with a content prop nobody
 * else needs yet.
 */
function ManualPriceHelp({ pmsName }: { pmsName: string }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const open = pinned || hovered;

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
        aria-label="What a manual price does"
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onClick={() => setPinned((p) => !p)}
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
          className="absolute left-1/2 top-6 z-20 w-72 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-950 p-3 text-left shadow-xl"
        >
          <span className="block text-xs font-semibold text-slate-200">Setting a price yourself</span>
          <span className="mt-2 block space-y-1.5 text-xs leading-snug text-slate-400">
            <span className="block">
              The number you type is what goes to {pmsName}, except 0, which you set there yourself.
            </span>
            <span className="block">
              Rules that had already moved this night are paused for this room type. Rules that
              fire later still apply on top of your price.
            </span>
            <span className="block">
              A rate changed in {pmsName} is kept the same way, once MAYA&apos;s own price has been there
              for an hour.
            </span>
            <span className="block">Clear hands the night back to MAYA&apos;s own pricing.</span>
          </span>
        </span>
      )}
    </span>
  );
}
