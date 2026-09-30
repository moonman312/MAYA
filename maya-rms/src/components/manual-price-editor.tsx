"use client";

import { HOVER_BRIDGE, LearnMore } from "@/components/deep-links/help-links";
import { links } from "@/lib/deep-links";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Type a price for one room type on one night (or a run of nights) and it is
 * what goes to the PMS. Sits inside the calendar's day card, one per room
 * type, so it has to stay small: an amount, an optional end date, Save, Clear.
 *
 * What a manual price actually does (pauses rules that already fired, later
 * rules still apply on top, clearing hands the night back to your rules) lives
 * behind the "?" — it matters, but not on every card, every time.
 *
 * The line under the box tells the truth about sending. The save's own
 * verdict comes first; then, on a live Cloudbeds or Think property, the
 * night's send status (/api/manual-price/send-status, read from the push's
 * ledger with the push's own retry rules) takes over once it says more: sent,
 * still being retried with the real count left, or stopped, with Try again
 * and a link to the sending problem in the change log, or the reason itself
 * when the change log does not show one yet. Read a few times after a save
 * and once on opening a night with a typed price, never on a loop, and no
 * more once the answer is final.
 */

type Pushed =
  | "nudged"
  | "next_cycle"
  | "simulation"
  | "beyond_window"
  | "zero_not_sent"
  | "billing_paused"
  | "reconnect"
  | "connection_error"
  | "saved";

/** What /api/manual-price/send-status says about the night (lib/pms/send-status.ts). */
export type SendStatus = {
  applicable: boolean;
  state: "pending" | "sending" | "sent" | "retrying" | "failed" | "skipped" | null;
  retriesLeft: number | null;
  attempts: number | null;
  lastAttemptAt: string | null;
  retryRequested: boolean;
  pmsType: string | null;
  pmsName: string | null;
  incidentId: string | null;
  /** Why the night is stopped, when no sending problem in the change log says so yet. */
  cause?: { title: string; action: string | null } | null;
  /** For a skipped night: MAYA's own hold, or no rate in the PMS to send to. */
  skipReason?: "maya_hold" | "no_rate_target" | null;
  maxAttempts: number;
  canRetry: boolean;
};

/** When the status is read again after a save whose price is being sent now. Then it stops. */
export const REFRESH_AFTER_SAVE_MS = [20_000, 60_000, 180_000];
/**
 * After a save whose price waits for the next cycle (about 5 minutes) or for
 * the connection to answer: the same reads, then two past the next cycles.
 */
export const REFRESH_AFTER_WAIT_MS = [...REFRESH_AFTER_SAVE_MS, 360_000, 660_000];
/** After Try again: closer together, until the answer is final. */
export const REFRESH_AFTER_RETRY_MS = [5_000, 15_000, 40_000, 90_000];
/** Save verdicts after which the status is worth reading, and how often. */
const REFRESH_AFTER_VERDICT: Partial<Record<Pushed, readonly number[]>> = {
  nudged: REFRESH_AFTER_SAVE_MS,
  next_cycle: REFRESH_AFTER_WAIT_MS,
  connection_error: REFRESH_AFTER_WAIT_MS,
};

/** Nothing more will change on its own: sent, stopped, not sent at all, or nothing is sent here. */
export function isFinalSendStatus(s: Pick<SendStatus, "applicable" | "state">): boolean {
  return !s.applicable || s.state === "sent" || s.state === "failed" || s.state === "skipped";
}

/** Stopped where the owner can act: refused and no longer retried, or no rate in the PMS to send to. */
function isStopped(s: Pick<SendStatus, "state" | "skipReason">): boolean {
  return s.state === "failed" || (s.state === "skipped" && s.skipReason === "no_rate_target");
}

type SaveResponse = {
  ok: boolean;
  cells: number;
  suppressedRules: number;
  retiredPickups: number;
  /** Rules paused, counted once each. Older responses don't carry it. */
  pausedRules?: number;
  pushed: Pushed;
  /** With billing_paused: the subscription's status, which decides the way back. */
  billingStatus?: string;
  /**
   * Nights inside the push window today vs. past it, and the window's length.
   * Older servers omit it, or omit `days` (their window was 60 days).
   */
  pushWindow?: { now: number; later: number; days?: number };
  preview: { stay_date: string; base: number; final: number; clamped_by: string | null }[];
};

/** What servers sent before the window's length was in the response. */
const DEFAULT_WINDOW_DAYS = 60;

/**
 * The way back when a stopped subscription holds everything, by status, as
 * the Billing page tells it (billing/account.ts headlineFor): a card revives
 * an unpaid one, one on hold is a word with us, and any other has ended and
 * needs a restart. No status (an older server) reads as unpaid.
 */
function billingPausedCopy(status: string | undefined): string {
  const lead = "Saved. Nothing is sent while MAYA's work is paused.";
  if (status === undefined || status === "unpaid") return `${lead} Update your card on the Billing page.`;
  if (status === "paused") return `${lead} Email us and we'll get it running again.`;
  return `${lead} Restart your subscription on the Billing page.`;
}

function pushedCopy(
  pushed: Pushed,
  pmsName: string,
  pushWindow?: SaveResponse["pushWindow"],
  billingStatus?: string,
): string {
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
    case "billing_paused":
      return billingPausedCopy(billingStatus);
    case "reconnect":
      return "Saved. It will be sent once you reconnect.";
    case "connection_error":
      return `Saved. ${pmsName} isn't answering MAYA right now. MAYA keeps trying to reach it and sends this price as soon as it answers.`;
    case "saved":
    default:
      return "Saved.";
  }
}

function nightsWord(cells: number | undefined): string {
  return cells != null && cells > 1 ? `these ${cells} nights` : "this night";
}

/** The one-line confirmation after a save, in house voice. Exported for tests. */
export function describeSave(
  res: Pick<
    SaveResponse,
    "pushed" | "suppressedRules" | "retiredPickups" | "pausedRules" | "pushWindow" | "billingStatus"
  > & {
    cells?: number;
    preview?: SaveResponse["preview"];
  },
  pmsName: string,
): string {
  // Rules, not rows: one rule can hold several fires on a night since
  // stacking, so adding the row counts said "Paused 3 rules" for one rule
  // that had cut the night three times. The sum is the fallback for a
  // response from before the count was sent.
  const paused = res.pausedRules ?? (res.suppressedRules ?? 0) + (res.retiredPickups ?? 0);
  const base = pushedCopy(res.pushed, pmsName, res.pushWindow, res.billingStatus);
  // 0 is a comp night: the engine lets no rule raise it, so "new rules will
  // apply on top" would not be true of the one direction that matters.
  const comp = res.preview?.[0]?.base === 0;
  if (paused <= 0) return comp ? `${base} No rule raises a night set to 0.` : base;
  const after = comp ? "no rule raises a night set to 0." : "new rules will apply on top.";
  return `${base} Paused ${paused} rule${paused === 1 ? "" : "s"} on ${nightsWord(res.cells)} for this room; ${after}`;
}

/** An open manual price as the day card and the editor see it. */
export type ManualPriceShown = { price: number; set_at: string; source?: "maya" | "pms"; pms_type?: string | null };

/**
 * The day card's badge: "Manual" for a price typed in MAYA, "Changed in
 * Cloudbeds" for a rate the hotel changed in its PMS on a night MAYA had
 * sent. `pmsName` is where that change was made, and `currencySymbol` the
 * property's own (currencySymbolFor). Exported for tests.
 */
export function manualPriceBadge(
  manual: Pick<ManualPriceShown, "price" | "source">,
  pmsName: string,
  currencySymbol = "$",
): string {
  const amount = `${currencySymbol}${manual.price.toFixed(2)}`;
  return manual.source === "pms" ? `Changed in ${pmsName} · ${amount}` : `Manual · ${amount}`;
}

/**
 * The line after a clear. `passed`: every night named has passed, so there
 * was nothing to clear (rules only price tonight onwards). Exported for tests.
 */
export function describeClear(cells: number | undefined, passed?: boolean): string {
  if (passed) return "This night has passed, so there is nothing to clear.";
  return cells != null && cells > 1
    ? `Cleared ${cells} nights. Your rules price them again.`
    : "Cleared. Your rules price this night again.";
}

/**
 * The line the night's send status puts under the box, or null when the
 * save's own line should stay: nothing is sent to this property, the push
 * has not reached the price yet, or MAYA's own check held it back (the save
 * already says so for a 0). The count is the server's, never a guess here.
 * Exported for tests.
 */
export function sendStatusLine(
  status: Pick<SendStatus, "applicable" | "state" | "retriesLeft" | "pmsName" | "skipReason">,
  pmsName: string,
): string | null {
  if (!status.applicable) return null;
  const pms = status.pmsName ?? pmsName;
  switch (status.state) {
    case "sent":
      return `Sent to ${pms}.`;
    case "sending":
      return `Sending to ${pms} now.`;
    case "retrying": {
      const n = status.retriesLeft ?? 1;
      return `Saved. It couldn't be sent yet. MAYA will retry ${n} more time${n === 1 ? "" : "s"}.`;
    }
    case "failed":
      return `This price couldn't be sent to ${pms}.`;
    case "skipped":
      // No rate in the PMS to send to is the owner's to fix there; MAYA's own
      // holds are not.
      return status.skipReason === "no_rate_target" ? `This price couldn't be sent to ${pms}.` : null;
    default:
      return null;
  }
}

/**
 * Where "See the error log" goes: the sending problem this night is filed
 * under in the change log. The editor offers the link only with one; without
 * it, it shows the reason itself. A full navigation, so the dashboard reads
 * the arrival and highlights it. Exported for tests.
 */
export function errorLogHref(incidentId: string | null): string {
  return incidentId
    ? links.internalHref({ dest: "changelog.problem", params: { problem: incidentId } })
    : links.internalHref({ dest: "changelog", params: {} });
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
  initialThrough,
  currencySymbol = "$",
  hotelToday = null,
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
  /**
   * A link opened this night with "through..." already set to this last
   * night. Only the range: the price is never filled in or focused, because
   * Enter in it saves.
   */
  initialThrough?: string | null;
  /** The property's currency symbol, shown beside the box. Display only: the price sent is the number typed. */
  currencySymbol?: string;
  /**
   * Today on the property's calendar (YYYY-MM-DD). A night before it has
   * passed: rules never price it again, so there is no Clear.
   */
  hotelToday?: string | null;
}) {
  const prefill = manualPrice?.price ?? currentPrice;
  const linkedThrough = initialThrough && /^\d{4}-\d{2}-\d{2}$/.test(initialThrough) && initialThrough > stayDate ? initialThrough : null;
  const [value, setValue] = useState<string>(prefill != null ? String(prefill) : "");
  const [rangeOpen, setRangeOpen] = useState(Boolean(linkedThrough));
  const [through, setThrough] = useState(linkedThrough ?? stayDate);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [status, setStatus] = useState<SendStatus | null>(null);
  const [retrying, setRetrying] = useState(false);
  const passed = hotelToday != null && stayDate < hotelToday;

  // A save or a live refresh can change what the night is worth; follow it,
  // but only when the number itself moves so a refresh mid-typing doesn't
  // wipe what someone is entering.
  useEffect(() => {
    setValue(prefill != null ? String(prefill) : "");
  }, [prefill]);

  // The status reads that are still to come, and the newest one started:
  // only its answer is shown, so a slow early read never overwrites a later one.
  const timers = useRef<number[]>([]);
  const statusSeq = useRef(0);
  const retryInFlight = useRef(false);
  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const refreshStatus = useCallback(async (): Promise<SendStatus | null> => {
    const seq = ++statusSeq.current;
    try {
      const q = new URLSearchParams({ hotelId, roomTypeId, date: stayDate });
      const res = await fetch(`/api/manual-price/send-status?${q.toString()}`);
      if (!res.ok) return null;
      const body = (await res.json()) as SendStatus;
      if (seq !== statusSeq.current) return null;
      setStatus(body);
      return body;
    } catch {
      return null;
    }
  }, [hotelId, roomTypeId, stayDate]);

  /** Reads the status at each delay, stopping early once `done` says the answer is final. */
  function scheduleRefreshes(delaysMs: readonly number[], done?: (s: SendStatus) => boolean) {
    clearTimers();
    for (const ms of delaysMs) {
      timers.current.push(
        window.setTimeout(() => {
          void refreshStatus().then((s) => {
            if (s && done?.(s)) clearTimers();
          });
        }, ms),
      );
    }
  }

  // Once, on opening a night that already has a typed price: what became of
  // it. Not for a rate the hotel changed in its PMS, which MAYA never sent.
  const openedWith = useRef(manualPrice);
  useEffect(() => {
    if (openedWith.current && openedWith.current.source !== "pms") void refreshStatus();
  }, [refreshStatus]);

  const parsed = Number(value);
  const valueOk = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const throughOk = !rangeOpen || (through >= stayDate && /^\d{4}-\d{2}-\d{2}$/.test(through));

  async function save() {
    if (!valueOk || !throughOk || busy) return;
    setBusy(true);
    setMessage(null);
    // A new price: whatever the last one's status was, it is not this one's.
    clearTimers();
    setStatus(null);
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
      const delays = REFRESH_AFTER_VERDICT[body.pushed];
      if (delays) scheduleRefreshes(delays, isFinalSendStatus);
      onSaved();
    } catch {
      setMessage({ kind: "error", text: "Couldn't reach MAYA. Try again." });
    } finally {
      setBusy(false);
    }
  }

  /**
   * One more send of a price the PMS refused. The server stamps the request
   * once, so a second press while one is pending sends nothing twice; here
   * the button is held while the request is out, and a click that lands
   * anyway is dropped.
   */
  async function retry() {
    if (retryInFlight.current || !status?.canRetry) return;
    retryInFlight.current = true;
    setRetrying(true);
    setMessage(null);
    try {
      const res = await fetch("/api/manual-price/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelId, roomTypeId, date: stayDate }),
      });
      if (res.status === 409) {
        // The night moved on since the line was read: show where it is now.
        await refreshStatus();
        return;
      }
      if (!res.ok) {
        setMessage({ kind: "error", text: await readError(res, "Couldn't ask for another try.") });
        return;
      }
      setStatus((s) => (s ? { ...s, state: "retrying", retriesLeft: 1, retryRequested: true } : s));
      // Through "sending" and back to "retrying", until the try has an answer.
      scheduleRefreshes(REFRESH_AFTER_RETRY_MS, isFinalSendStatus);
    } catch {
      setMessage({ kind: "error", text: "Couldn't reach MAYA. Try again." });
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    clearTimers();
    setStatus(null);
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
      const body = (await res.json().catch(() => ({}))) as { cells?: number; passed?: boolean };
      setMessage({ kind: "ok", text: describeClear(body.cells, body.passed) });
      onSaved();
    } catch {
      setMessage({ kind: "error", text: "Couldn't reach MAYA. Try again." });
    } finally {
      setBusy(false);
    }
  }

  // The status speaks once it says more than the save did; an error of the
  // save or clear itself always shows.
  const statusLine = status ? sendStatusLine(status, pmsName) : null;

  return (
    <div className="mt-2 border-t border-slate-800 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-400">
          {currencySymbol.trim()}
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
        <ManualPriceHelp pmsName={pmsName} retries={status?.applicable ? { max: status.maxAttempts, canRetry: status.canRetry } : null} />
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
        {manualPrice && !passed ? (
          <button
            type="button"
            disabled={busy}
            title={manualPrice.source === "pms" ? `Changed in ${pmsName}. Clear hands the night back to your rules.` : undefined}
            onClick={() => void clear()}
            className="cursor-pointer rounded border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 hover:border-slate-500 disabled:opacity-60"
          >
            Clear
          </button>
        ) : null}
      </div>
      {statusLine && message?.kind !== "error" ? (
        <div className="mt-2 text-xs">
          <p className={status?.state === "sent" || status?.state === "sending" ? "text-emerald-300" : "text-amber-300"} role="status">
            {statusLine}
          </p>
          {status && isStopped(status) ? (
            <>
              {/* Why, when no sending problem in the change log says so yet. */}
              {!status.incidentId && status.cause ? (
                <p className="mt-1 text-slate-300">
                  {status.cause.title}.{status.cause.action ? ` ${status.cause.action}` : ""}
                </p>
              ) : null}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {status.state === "failed" && status.canRetry ? (
                  <button
                    type="button"
                    disabled={retrying}
                    onClick={() => void retry()}
                    className="cursor-pointer rounded border border-amber-500/60 px-2 py-0.5 text-xs font-medium text-amber-200 hover:border-amber-400 disabled:opacity-60"
                  >
                    Try again
                  </button>
                ) : null}
                {status.incidentId ? (
                  <a href={errorLogHref(status.incidentId)} className="text-xs text-sky-400 underline decoration-dotted hover:text-sky-300">
                    See the error log
                  </a>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : message ? (
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
function ManualPriceHelp({
  pmsName,
  retries,
}: {
  pmsName: string;
  /** How sending is retried, once the night's status has been read (the count is the server's). Null before that. */
  retries: { max: number; canRetry: boolean } | null;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const open = pinned || hovered;
  // Tabbing from the "?" to its Learn more keeps the panel open.
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
        aria-label="What a manual price does"
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
        // See-through top padding bridges the "?" and the panel, so the pointer
        // can reach Learn more without the panel closing on the way.
        <span className={HOVER_BRIDGE}>
          <span
            id={panelId}
            role="group"
            aria-label="Setting a price yourself"
            className="block w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-slate-700 bg-slate-950 p-3 text-left shadow-xl"
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
              <span className="block">A night set to 0 is a comp night, and no rule raises it.</span>
              <span className="block">
                A rate changed in {pmsName} is kept the same way, once MAYA&apos;s own price has been there
                for an hour.
              </span>
              <span className="block">Clear hands the night back to your rules.</span>
              {retries ? (
                <span className="block">
                  A price {pmsName} doesn&apos;t take is sent again, up to {retries.max} times at that price, then once a day.
                  {retries.canRetry ? " Try again sends it once more now." : ""}
                </span>
              ) : null}
            </span>
            <LearnMore panel="manual-price" onBlurOut={blurOut} />
          </span>
        </span>
      )}
    </span>
  );
}
