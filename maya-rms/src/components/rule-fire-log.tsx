"use client";

/**
 * The rules list's fire count ("12×") as a button, and the fire log it
 * opens: that rule's fires in the last 90 days, newest first, the same fires
 * the count counts (src/lib/rule-fire-log.ts). Each row is when it fired in
 * the property's time, the night it changed and the adjustment; a click opens
 * the room type, the price before and after its run, why it fired, where the
 * price went and what ended it later, worded by GET /api/rules/:id/fires for
 * the mode the property was in at the time. "Older" reads the next page.
 *
 * Nothing is fetched until the popup opens, so the rules list stays as fast
 * as it was. The popup only reads, so every role that sees the rules list
 * (a Viewer, a platform admin viewing the property) sees the same log.
 */

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OlderButton } from "@/components/older-button";
import { SEND_TONE } from "@/components/pricing-run-item";
import { RoomCountHelp } from "@/components/room-type-settings";
import { RULE_FIRES_HELP } from "@/lib/rule-form";
import type { RuleFireItem, RuleFireLogResponse } from "@/lib/rule-fire-log";

/** The count in the rules list, as the button that opens the rule's fire log. */
export function RuleFireCount({
  ruleId,
  ruleName,
  count,
  onCount,
}: {
  ruleId: string;
  ruleName: string;
  count: number;
  /** The rule's count as the log read it, to put the list right if a fire landed since it loaded. */
  onCount?: (count: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-label={`${ruleName} fired ${count} ${count === 1 ? "time" : "times"}. See each one.`}
        onClick={() => setOpen(true)}
        className="cursor-pointer font-semibold text-sky-300 underline decoration-sky-300/40 decoration-dotted underline-offset-4 hover:text-sky-200"
      >
        {count}×
      </button>
      {open
        ? createPortal(
            <RuleFireLogDialog
              ruleId={ruleId}
              ruleName={ruleName}
              onCount={onCount}
              onClose={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

async function readPage(ruleId: string, older: string | null): Promise<RuleFireLogResponse> {
  const url = `/api/rules/${encodeURIComponent(ruleId)}/fires${older ? `?older=${encodeURIComponent(older)}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return (await res.json()) as RuleFireLogResponse;
}

export function RuleFireLogDialog({
  ruleId,
  ruleName,
  onClose,
  onCount,
}: {
  ruleId: string;
  ruleName: string;
  onClose: () => void;
  onCount?: (count: number) => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  // The caller's callbacks change every render; the reads must not.
  const onCountRef = useRef(onCount);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCountRef.current = onCount;
    onCloseRef.current = onClose;
  });

  const [fires, setFires] = useState<RuleFireItem[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [older, setOlder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [pagedBack, setPagedBack] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await readPage(ruleId, null);
      setFires(page.fires);
      setOlder(page.older);
      setEnabled(page.rule.enabled);
      if (page.total != null) {
        setTotal(page.total);
        onCountRef.current?.(page.total);
      }
    } catch {
      setError("Couldn't load this rule's fires.");
    }
  }, [ruleId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const loadOlder = async () => {
    if (!older) return;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await readPage(ruleId, older);
      setFires((list) => [...(list ?? []), ...page.fires]);
      setOlder(page.older);
      setPagedBack(true);
    } catch {
      setOlderError("Couldn't load older fires.");
    } finally {
      setOlderBusy(false);
    }
  };

  const toggle = (id: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-slate-700 bg-slate-900 text-left shadow-xl">
        <div className="border-b border-slate-800 px-4 pb-3 pt-4">
          <div className="flex items-start justify-between gap-3">
            <h3 id={titleId} className="text-base font-semibold text-slate-100">
              {ruleName}
            </h3>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded px-2 text-lg leading-none text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
            {total != null ? `${total} ${total === 1 ? "fire" : "fires"} in the last 90 days` : "Fires in the last 90 days"}
            <RoomCountHelp {...RULE_FIRES_HELP} docs="rule-fires" />
          </p>
          {!enabled ? <p className="mt-1 text-xs text-amber-200/90">This rule is off. Its changes stay where they are.</p> : null}
        </div>
        <div className="overflow-y-auto px-4 pb-4 pt-1">
          {error ? (
            <p className="py-3 text-sm text-rose-300">
              {error}{" "}
              <button type="button" onClick={() => void load()} className="cursor-pointer text-sky-400 underline decoration-dotted hover:text-sky-300">
                Try again
              </button>
            </p>
          ) : fires === null ? (
            <p className="py-3 text-sm text-slate-400">Loading…</p>
          ) : fires.length === 0 ? (
            <p className="py-3 text-sm text-slate-400">No fires in the last 90 days.</p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {fires.map((fire) => (
                <FireRow key={fire.id} fire={fire} open={expanded.has(fire.id)} onToggle={() => toggle(fire.id)} />
              ))}
            </ul>
          )}
          {fires && fires.length > 0 ? (
            <OlderButton
              hasOlder={older != null}
              busy={olderBusy}
              error={olderError}
              endLine={pagedBack ? "Nothing older. Fires are kept for 90 days." : null}
              onOlder={() => void loadOlder()}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FireRow({ fire, open, onToggle }: { fire: RuleFireItem; open: boolean; onToggle: () => void }) {
  const detailId = useId();
  return (
    <li data-fire={fire.id}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        className="grid w-full cursor-pointer grid-cols-[1fr_auto_auto_auto] items-center gap-x-2 py-2 text-left text-[0.8125rem] hover:bg-slate-800/40 sm:gap-x-3 sm:text-sm"
      >
        <time dateTime={fire.fired_at} title={fire.when_exact} className="whitespace-nowrap text-slate-300">
          {fire.when}
        </time>
        <span className="whitespace-nowrap text-slate-400">{fire.night}</span>
        {/* On a phone the Simulation tag sits over the amount, so the row stays one line of text. */}
        <span className="flex flex-col items-end gap-0.5 font-medium tabular-nums text-sky-300 sm:flex-row sm:items-center sm:gap-1.5">
          {fire.mode === "simulation" ? (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[0.625rem] font-medium text-amber-300">
              Simulation
            </span>
          ) : null}
          {fire.adjustment}
        </span>
        <ChevronDown aria-hidden className={`size-3.5 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div id={detailId} className="space-y-1 pb-3 text-[0.8125rem] leading-relaxed">
          {fire.price_line ? (
            <p className="font-medium text-slate-200">{fire.price_line}</p>
          ) : (
            <>
              <p className="font-medium text-slate-200">{fire.room_type}</p>
              <p className="text-slate-500">The prices for this run aren&apos;t on record.</p>
            </>
          )}
          {fire.price_note ? <p className="text-slate-400">{fire.price_note}</p> : null}
          {fire.send_line ? <p className={`text-xs ${SEND_TONE[fire.send_state ?? "waiting"]}`}>{fire.send_line}</p> : null}
          {fire.why.map((line) => (
            <p key={`why-${line}`} className="text-slate-400">
              {line}
            </p>
          ))}
          {fire.later.map((line) => (
            <p key={`later-${line}`} className="text-slate-400">
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </li>
  );
}
