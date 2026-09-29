"use client";

/**
 * The activation popup (Jake, 2026-09-28): whenever a rule is about to
 * become active (switched on in the rules list, added on in the builder, or
 * an edit saved to a rule that is on), a small calendar of the months ahead,
 * one 10 x 10 square a day, with the days the rule will change highlighted,
 * "X days will be affected by this rule.", and a choice: apply the price
 * adjustments, skip them, or back out.
 *
 * The days come from the engine itself (POST /api/rules/preview: dry runs of
 * the same code the scheduled sync runs), never an estimate, and the number
 * shows only once every part of the answer is in. Apply and Skip send the
 * fingerprint of what the answer was worked out on; when something changed
 * since, the days are worked out again, and the save goes ahead at once if
 * they are the same, or the new days are shown.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RoomCountHelp } from "@/components/room-type-settings";
import { track } from "@/lib/analytics/track";
import {
  DAYS_NOT_CHECKED,
  addDays,
  affectedSentence,
  browserToday,
  dateRanges,
  dayTitle,
  fetchRulePreview,
  monthBlocks,
  type CalendarPreview,
  type PreviewRequest,
} from "@/lib/rule-activation-client";

export type ActivationChoice = {
  activation: "apply" | "skip";
  fingerprint: string;
  touched: string[];
  days: number;
  refreshed: boolean;
};

export type SaveAnswer = { ok: true; skipped?: boolean } | { ok: false; status: number; code?: string; error: string };

export type ActivationSource = "switch" | "builder_new" | "builder_edit" | "suggestion";

export const ACTIVATION_HELP = {
  label: "What the days mean",
  title: "Which days, and what each button does",
  lines: [
    "A day counts when the rule changes the price of at least one room type that night, after every other rule, typed prices, floors and ceilings.",
    "The days come from a trial run of your rules on your bookings as they are now. Nothing is saved until you choose.",
    "Apply price adjustments: the rule changes those days' prices on the next pricing run.",
    "Skip price adjustments: the rule is on, and those days keep their prices. It acts only on what changes from now on, and a booking speed or pickup rule counts bookings from now.",
    "Nights further ahead than the calendar are priced as they come into it.",
  ],
};

export const DAYS_CHANGED_LINE = "Your bookings changed while this was open, so the days were checked again.";

function title(intent: PreviewRequest["intent"], name: string): string {
  if (intent === "enable") return `Turn on “${name}”?`;
  if (intent === "create") return `Add “${name}”?`;
  return `Save changes to “${name}”?`;
}

export function RuleActivationDialog({
  ruleName,
  request,
  kind,
  source,
  save,
  onSaved,
  onCancel,
  onUnavailable,
  onNotNeeded,
  onRefused,
  fetchImpl,
}: {
  ruleName: string;
  request: PreviewRequest;
  kind: "standard" | "event";
  source: ActivationSource;
  /** Send the save with the owner's choice (POST /api/rules, PUT /api/rules/[id], or the switch). */
  save: (choice: ActivationChoice) => Promise<SaveAnswer>;
  onSaved: (skipped: boolean) => void;
  onCancel: () => void;
  /** No preview here (demo mode): the caller saves the way it did before the popup. */
  onUnavailable?: () => void;
  /** The change can't move a price after all (a new name): the caller saves it as it is. */
  onNotNeeded?: () => void;
  /** The person's role can't change rules: the caller says so where they clicked. */
  onRefused?: (message: string) => void;
  fetchImpl?: typeof fetch;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<CalendarPreview | null>(null);
  const [partial, setPartial] = useState<CalendarPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"apply" | "skip" | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const started = useRef(Date.now());
  const run = useRef(0);

  const check = useCallback(async (): Promise<CalendarPreview | null> => {
    const mine = ++run.current;
    setError(null);
    setPreview(null);
    setPartial(null);
    started.current = Date.now();
    const outcome = await fetchRulePreview(request, kind, (p) => {
      if (run.current === mine) setPartial(p);
    }, fetchImpl);
    if (run.current !== mine) return null;
    if (outcome.status === "unavailable") {
      onUnavailable?.();
      return null;
    }
    if (outcome.status === "not_needed") {
      onNotNeeded?.();
      return null;
    }
    if (outcome.status === "error" && outcome.forbidden && onRefused) {
      onRefused(outcome.message);
      return null;
    }
    if (outcome.status === "error") {
      setError(outcome.message);
      track("rule.preview_failed", { from: source });
      return null;
    }
    setPreview(outcome.preview);
    track("rule.preview_shown", {
      from: source,
      days: outcome.preview.affected.length,
      ms: Date.now() - started.current,
      nights_checked: outcome.preview.nightsChecked,
    });
    return outcome.preview;
  }, [request, kind, source, onUnavailable, onNotNeeded, onRefused, fetchImpl]);

  useEffect(() => {
    track("rule.preview_opened", { from: source, kind });
    void check();
    // One preview per opening; Try again asks for another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc backs out; Tab stays inside the popup.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        e.preventDefault();
        cancel();
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving]);

  function cancel() {
    track("rule.preview_cancelled", { from: source, days: preview?.affected.length ?? 0 });
    onCancel();
  }

  async function choose(activation: "apply" | "skip") {
    if (!preview && activation === "apply") return;
    setSaving(activation);
    setSaveError(null);
    let current: CalendarPreview = preview ?? {
      today,
      lastNight,
      affected: [],
      roomTypesChanged: {},
      touched: [],
      fingerprint: "",
      kind,
      ms: 0,
      nightsChecked: 0,
      done: 0,
      parts: 0,
    };
    let wasRefreshed = refreshed;
    // At most one fresh look: if the days are the same, save; if not, show them.
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await save({
        activation,
        fingerprint: current.fingerprint,
        touched: current.touched,
        days: current.affected.length,
        refreshed: wasRefreshed,
      });
      if (answer.ok) {
        setSaving(null);
        onSaved(answer.skipped ?? activation === "skip");
        return;
      }
      if (answer.code === "stale" && attempt === 0) {
        const again = await check();
        if (!again) {
          setSaving(null);
          return;
        }
        wasRefreshed = true;
        setRefreshed(true);
        if (again.affected.join(",") !== current.affected.join(",")) {
          // Different days: the owner sees them and chooses again.
          setSaving(null);
          return;
        }
        current = again;
        continue;
      }
      setSaving(null);
      setSaveError(answer.error || DAYS_NOT_CHECKED);
      return;
    }
    setSaving(null);
  }

  const shown = preview ?? partial;
  const today = shown?.today || browserToday();
  const lastNight = shown?.lastNight || addDays(today, 395);
  const affected = new Set(preview?.affected ?? partial?.affected ?? []);
  const blocks = monthBlocks(today, lastNight);
  const ready = preview !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/80 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) cancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-2xl rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl outline-none"
      >
        <h3 id={titleId} className="text-lg font-semibold text-slate-100">
          {title(request.intent, ruleName)}
        </h3>

        <div
          className={`mt-4 flex flex-wrap gap-x-4 gap-y-3 ${ready ? "" : "motion-safe:animate-pulse"}`}
          aria-hidden="true"
          data-testid="activation-calendar"
        >
          {blocks.map((b) => (
            <div key={b.key} className="w-[82px]">
              <p className="mb-1 text-[10px] font-medium text-slate-400">{b.label}</p>
              <div className="grid grid-cols-[repeat(7,10px)] gap-[2px]">
                {Array.from({ length: b.lead }, (_, i) => (
                  <span key={`lead-${i}`} className="size-[10px]" />
                ))}
                {b.days.map((d) =>
                  d.inWindow ? (
                    <span
                      key={d.date}
                      data-day={d.date}
                      data-affected={affected.has(d.date) ? "true" : "false"}
                      title={dayTitle(d.date, preview?.roomTypesChanged[d.date])}
                      className={`size-[10px] rounded-[2px] ${affected.has(d.date) ? "bg-sky-400" : "bg-slate-700"} ${
                        d.date === today ? "ring-1 ring-slate-200" : ""
                      }`}
                    />
                  ) : (
                    <span key={d.date} className="size-[10px]" />
                  ),
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-start gap-2" aria-live="polite">
          <p className="text-sm text-slate-200" data-testid="activation-summary">
            {error ? error : ready ? affectedSentence(preview.affected.length) : "Checking your calendar…"}
          </p>
          <span className="mt-0.5">
            <RoomCountHelp {...ACTIVATION_HELP} docs="rule-activation" />
          </span>
        </div>
        {ready && preview.affected.length > 0 ? (
          <p className="sr-only">Days affected: {dateRanges(preview.affected)}</p>
        ) : null}
        {refreshed && ready ? <p className="mt-2 text-sm text-amber-300">{DAYS_CHANGED_LINE}</p> : null}
        {saveError ? <p className="mt-2 text-sm text-rose-400">{saveError}</p> : null}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            disabled={!ready || saving !== null}
            onClick={() => void choose("apply")}
            className="cursor-pointer rounded bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
          >
            {saving === "apply" ? "Applying…" : "Apply price adjustments"}
          </button>
          <button
            type="button"
            // Skip moves no price, so it stays on offer when the days could not be worked out.
            disabled={(!ready && !error) || saving !== null}
            onClick={() => void choose("skip")}
            className="cursor-pointer rounded bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600 disabled:cursor-default disabled:opacity-50"
          >
            {saving === "skip" ? "Saving…" : "Skip price adjustments"}
          </button>
          {error ? (
            <button
              type="button"
              onClick={() => void check()}
              className="cursor-pointer rounded border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              Try again
            </button>
          ) : null}
          <button
            type="button"
            disabled={saving !== null}
            onClick={cancel}
            className="cursor-pointer rounded px-4 py-2 text-sm text-slate-400 hover:text-slate-200 disabled:cursor-default sm:mr-auto"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
