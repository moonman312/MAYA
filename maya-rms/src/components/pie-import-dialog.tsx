"use client";

/**
 * Import from PIE: the owner drops, chooses or pastes screenshots of PIE's
 * "Rules and Alerts" page, MAYA reads them in the browser (never uploaded,
 * never kept), and shows each PIE rule beside the MAYA rule it becomes, with
 * the floors and ceilings PIE's price limits make. The owner unticks what
 * they don't want, opens any rule in the rule builder first if they like,
 * and adds them: the ones on in PIE through one activation popup for all of
 * them, the ones off created off.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { RuleActivationDialog, type ActivationChoice, type SaveAnswer } from "@/components/rule-activation-dialog";
import { RoomCountHelp } from "@/components/room-type-settings";
import { track } from "@/lib/analytics/track";
import { mergeReads } from "@/lib/pie-import/merge";
import { PIE_COPY, planImport, type ImportDraft, type ImportItem, type LimitChange, type MayaRoomType } from "@/lib/pie-import/map";
import type { ScreenshotRead } from "@/lib/pie-import/read";
import { draftSentence } from "@/lib/pie-import/sentence";
import { browserToday, draftsKind, type PreviewRequest } from "@/lib/rule-activation-client";

/** The most active rules a property may have (enforce_rule_limit). */
const ACTIVE_RULE_CAP = 40;

export const PIE_IMPORT_HELP = {
  label: "How the import works",
  title: "Importing from PIE",
  lines: [
    "Take the screenshot in Cloudbeds, on PIE's Rules and Alerts page, with the column headings in it. For a long list, add one screenshot per screen.",
    "It's read here in your browser. It's never uploaded or kept.",
  ],
};

export const PIE_REVIEW_HELP = {
  label: "How PIE's rules become MAYA's",
  title: "From PIE to MAYA",
  lines: [
    "PIE puts every rule that's true on top of the others, and so does MAYA, so each PIE rule becomes the MAYA rule beside it and prices come out the same.",
    "Rules on in PIE are added on, and the ones off are added off.",
    "Edit opens a rule in the rule builder before it's added.",
    "They add to the MAYA rules you already have on.",
    "Once you're live, turn PIE's rules off, or set MAYA's price wins, so the two don't change the same rates.",
  ],
};

/** Reads screenshots into what the review shows (the browser's OCR; tests hand in their own). */
export type ReadScreenshots = (files: readonly Blob[]) => Promise<ScreenshotRead[]>;

/** How long one screenshot may take to read before the import says it couldn't (a worker that died never answers). */
const SCREENSHOT_TIME_LIMIT_MS = 90_000;

async function withinTimeLimit<T>(ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no answer in time")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The default: tesseract.js in this browser, started once, the headings carried from one screenshot to the next. */
function browserReader(): { read: ReadScreenshots; warm: () => void; close: () => void } {
  let started: Promise<import("@/lib/pie-import/browser-ocr").ScreenshotReader> | null = null;
  // The last headings seen, for a screenshot added later that scrolled past them.
  let carry: ScreenshotRead["columns"] = null;
  // Started once; a start that failed (offline) is tried again next time.
  const start = () => {
    started ??= import("@/lib/pie-import/browser-ocr")
      .then(({ startScreenshotReader }) => startScreenshotReader())
      .catch((e: unknown) => {
        started = null;
        throw e;
      });
    return started;
  };
  return {
    warm: () => void start().catch(() => {}),
    read: async (files) => {
      const { readScreenshot } = await import("@/lib/pie-import/read");
      const reader = await start();
      const out: ScreenshotRead[] = [];
      for (const file of files) {
        const read = await withinTimeLimit(SCREENSHOT_TIME_LIMIT_MS, async () => {
          const { image, pass } = await reader.open(file);
          return readScreenshot(image, pass, carry);
        });
        if (read.columns?.headerBottom != null) carry = read.columns;
        out.push(read);
      }
      return out;
    },
    // Stops the worker; the next read starts a fresh one.
    close: () => {
      const was = started;
      started = null;
      carry = null;
      void was?.then((r) => r.close()).catch(() => {});
    },
  };
}

export type PieEdit = { key: string; index: number; draft: ImportDraft };

type Phase = "pick" | "reading" | "review" | "saving" | "done";

type Result = { created: { id: string; on: boolean }[]; failed: { id: string; error: string }[]; limits: number };

/** "Garden Room: $110 to $520" */
function money(n: number, symbol: string): string {
  return `${symbol}${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function PieImportDialog({
  hidden = false,
  from,
  currencySymbol = "$",
  activeRules,
  edited,
  onEdit,
  onClose,
  onCreated,
  read: readProp,
  fetchImpl = fetch,
}: {
  /** Kept open but out of sight while a rule is in the rule builder. */
  hidden?: boolean;
  from: "rules" | "link";
  currencySymbol?: string;
  /** Rules on now, for the 40-rule cap. */
  activeRules: number;
  /** A rule the owner changed in the rule builder, back for the review. */
  edited?: PieEdit | null;
  /** Open one of the MAYA rules in the rule builder. */
  onEdit?: (edit: PieEdit) => void;
  onClose: () => void;
  /** Something was added: reload the rules. */
  onCreated?: () => void;
  read?: ReadScreenshots;
  fetchImpl?: typeof fetch;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reader = useRef<{ read: ReadScreenshots; warm?: () => void; close: () => void } | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [reads, setReads] = useState<ScreenshotRead[]>([]);
  const [roomTypes, setRoomTypes] = useState<MayaRoomType[] | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [limitTicks, setLimitTicks] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, ImportDraft[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [activation, setActivation] = useState<{ request: PreviewRequest; name: string; kind: "standard" | "event" } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const lastSave = useRef<{ rules: Record<string, unknown>[]; limits: { roomTypeId: string; floor: number; ceiling: number }[] } | null>(null);

  useEffect(() => {
    track("pie.import_opened", { from });
    // The reader starts loading as the import opens, so the first screenshot reads sooner.
    if (!readProp) {
      reader.current ??= browserReader();
      reader.current.warm?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    fetchImpl("/api/room-types")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: MayaRoomType[]) => {
        if (alive) setRoomTypes(Array.isArray(rows) ? rows : []);
      })
      .catch(() => alive && setRoomTypes([]));
    return () => {
      alive = false;
    };
  }, [fetchImpl]);

  useEffect(() => () => reader.current?.close(), []);

  const plan = useMemo(
    () => (roomTypes && reads.length > 0 ? planImport(mergeReads(reads), roomTypes, { today: browserToday() }) : null),
    [reads, roomTypes],
  );

  // A rule or limit is ticked as the review first shows it until the owner ticks or unticks it.
  const ticked = (item: ImportItem) => ticks[item.key] ?? item.ticked;
  const limitTicked = (c: LimitChange) => c.problem === null && (limitTicks[c.roomTypeId] ?? true);

  // A rule back from the rule builder.
  const editSeen = useRef<PieEdit | null>(null);
  useEffect(() => {
    if (!edited || edited === editSeen.current) return;
    editSeen.current = edited;
    setEdits((prev) => {
      const item = plan?.items.find((i) => i.key === edited.key);
      const base = prev[edited.key] ?? item?.drafts ?? [];
      const next = [...base];
      next[edited.index] = edited.draft;
      return { ...prev, [edited.key]: next };
    });
    setTicks((prev) => ({ ...prev, [edited.key]: true }));
  }, [edited, plan]);

  const draftsOf = useCallback(
    (item: ImportItem): ImportDraft[] => (edits[item.key] ? edits[item.key].map((d, i) => ({ ...d, id: item.drafts[i]?.id ?? d.id })) : item.drafts),
    [edits],
  );
  const usable = (item: ImportItem) => item.status === "ready" || (item.status === "needs_edit" && !!edits[item.key] && item.drafts.length > 0);

  async function readFiles(files: Blob[]) {
    const images = files.filter((f) => f.type === "" || f.type.startsWith("image/"));
    if (images.length === 0) {
      setError("Add a screenshot (an image file).");
      return;
    }
    setError(null);
    setPhase("reading");
    const started = Date.now();
    let fresh: ScreenshotRead[];
    try {
      if (readProp) fresh = await readProp(images);
      else {
        reader.current ??= browserReader();
        fresh = await reader.current.read(images);
      }
    } catch {
      // A fresh worker for the next try.
      reader.current?.close();
      track("pie.read_failed", { stage: reads.length === 0 ? "start" : "read" });
      setError("That screenshot couldn't be read. Check your connection and try again.");
      setPhase(reads.length > 0 ? "review" : "pick");
      return;
    }
    readMs.current = Date.now() - started;
    setReads((prev) => [...prev, ...fresh]);
    setPhase("review");
  }

  // What was found, once the review has it: counts only, never anything read.
  const readMs = useRef<number | null>(null);
  useEffect(() => {
    if (!plan || readMs.current === null) return;
    track("pie.screenshots_read", {
      screenshots: reads.length,
      unread: mergeReads(reads).unread.length,
      rules: plan.items.length,
      ready: plan.items.filter((i) => i.status === "ready").length,
      needs_edit: plan.items.filter((i) => i.status === "needs_edit").length,
      not_imported: plan.items.filter((i) => i.status === "not_imported").length,
      limits: plan.limits.changes.length,
      ms: readMs.current,
    });
    readMs.current = null;
  }, [plan, reads]);

  // Paste anywhere while the import is open.
  useEffect(() => {
    if (hidden || (phase !== "pick" && phase !== "review")) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      void readFiles(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  // Esc closes, unless something is saving or the popup is open.
  useEffect(() => {
    if (hidden) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !activation && phase !== "saving" && phase !== "reading") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hidden, activation, phase, onClose]);

  const items = plan?.items ?? [];
  const chosen = items.filter((i) => ticked(i) && usable(i));
  const rulesBody = chosen.flatMap((i) => draftsOf(i).map((d) => ({ ...d, on: i.on })));
  const limitChanges = (plan?.limits.changes ?? []).filter(limitTicked);
  const limitsBody = limitChanges.map((c) => ({ roomTypeId: c.roomTypeId, floor: c.floor, ceiling: c.ceiling }));
  const onCount = rulesBody.filter((r) => r.on).length;
  const over = activeRules + onCount - ACTIVE_RULE_CAP;
  const nothing = rulesBody.length === 0 && limitsBody.length === 0;

  async function send(body: Record<string, unknown>): Promise<SaveAnswer> {
    try {
      const res = await fetchImpl("/api/rules/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await res.json().catch(() => ({}))) as Partial<Result> & { error?: string; code?: string; skipped?: boolean };
      if (res.ok) {
        setResult({ created: answer.created ?? [], failed: answer.failed ?? [], limits: answer.limits ?? 0 });
        return { ok: true, skipped: answer.skipped === true };
      }
      return { ok: false, status: res.status, code: answer.code, error: answer.error ?? "That didn't save. Try again." };
    } catch {
      return { ok: false, status: 0, error: "That didn't save. Check your connection and try again." };
    }
  }

  function finished() {
    setActivation(null);
    setPhase("done");
    onCreated?.();
  }

  async function create(retry?: { rules: Record<string, unknown>[]; limits: typeof limitsBody }) {
    const rules = retry?.rules ?? rulesBody;
    const limits = retry?.limits ?? limitsBody;
    lastSave.current = { rules, limits };
    setError(null);
    const on = rules.filter((r) => r.on);
    if (on.length > 0) {
      const total = rules.length;
      setActivation({
        request: { intent: "import", ruleId: String(on[0].id), rules, limits },
        name: `${total} ${total === 1 ? "rule" : "rules"} from PIE`,
        kind: draftsKind(on),
      });
      return;
    }
    setPhase("saving");
    const answer = await send({ rules, limits });
    if (answer.ok) finished();
    else {
      setPhase("review");
      setError(answer.error);
    }
  }

  const shown = !hidden;
  return (
    <>
      {activation ? (
        <RuleActivationDialog
          ruleName={activation.name}
          request={activation.request}
          kind={activation.kind}
          source="pie_import"
          save={(choice: ActivationChoice) => send({ rules: activation.request.rules, limits: activation.request.limits, ...choice })}
          onSaved={finished}
          onCancel={() => setActivation(null)}
          onRefused={(message) => {
            setActivation(null);
            setError(message);
          }}
          onUnavailable={() => {
            setActivation(null);
            setError("Importing needs a connected property.");
          }}
          onNotNeeded={async () => {
            const current = activation;
            setActivation(null);
            setPhase("saving");
            const answer = await send({ rules: current.request.rules, limits: current.request.limits });
            if (answer.ok) finished();
            else {
              setPhase("review");
              setError(answer.error);
            }
          }}
          fetchImpl={fetchImpl}
        />
      ) : null}
      <div
        hidden={!shown || !!activation}
        className={`fixed inset-0 z-40 items-center justify-center overflow-y-auto bg-slate-950/80 p-4 ${shown && !activation ? "flex" : "hidden"}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && phase !== "saving" && phase !== "reading") onClose();
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl outline-none"
        >
          <div className="flex items-center gap-2">
            <h3 id={titleId} className="text-lg font-semibold text-slate-100">
              Import from PIE
            </h3>
            <RoomCountHelp {...(phase === "review" ? PIE_REVIEW_HELP : PIE_IMPORT_HELP)} docs="pie-import" />
          </div>

          {phase === "pick" || phase === "reading" ? (
            <div
              data-testid="pie-drop"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void readFiles([...e.dataTransfer.files]);
              }}
              className={`mt-4 flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm ${
                dragging ? "border-sky-400 bg-sky-500/10" : "border-slate-700"
              }`}
            >
              {phase === "reading" ? (
                <p className="text-slate-200 motion-safe:animate-pulse" aria-live="polite">
                  Reading your screenshot…
                </p>
              ) : (
                <>
                  <p className="text-slate-300">A screenshot of PIE&apos;s Rules and Alerts page.</p>
                  <p className="text-slate-500">
                    Drop it here, paste it, or{" "}
                    <button type="button" onClick={() => fileRef.current?.click()} className="cursor-pointer text-sky-400 underline hover:text-sky-300">
                      choose a file
                    </button>
                    .
                  </p>
                </>
              )}
            </div>
          ) : null}

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            data-testid="pie-file"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void readFiles(files);
            }}
          />

          {phase === "review" || phase === "saving" ? (
            <Review
              items={items}
              limits={plan?.limits ?? { changes: [], unmatched: [] }}
              roomTypes={roomTypes ?? []}
              symbol={currencySymbol}
              ticked={ticked}
              limitTicked={limitTicked}
              edited={(key) => !!edits[key]}
              draftsOf={draftsOf}
              usable={usable}
              onTick={(key, on) => setTicks((t) => ({ ...t, [key]: on }))}
              onLimitTick={(id, on) => setLimitTicks((t) => ({ ...t, [id]: on }))}
              onEdit={onEdit ? (item, index) => onEdit({ key: item.key, index, draft: draftsOf(item)[index] }) : undefined}
              unread={plan ? mergeReads(reads).unread.length : 0}
            />
          ) : null}

          {phase === "done" && result ? (
            <div className="mt-4 space-y-2 text-sm" aria-live="polite">
              <p className="text-emerald-300" data-testid="pie-done">
                {doneSentence(result)}
              </p>
              {result.failed.length > 0 ? (
                <ul className="space-y-1 text-rose-300">
                  {result.failed.map((f) => (
                    <li key={f.id}>
                      {nameOf(items, draftsOf, f.id)}: {f.error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
          {phase === "review" && over > 0 ? (
            <p className="mt-3 text-sm text-amber-300" data-testid="pie-cap">
              That makes {activeRules + onCount} rules on, and a property can have {ACTIVE_RULE_CAP}. Untick {over} to fit.
            </p>
          ) : null}

          <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse sm:items-center">
            {phase === "review" || phase === "saving" ? (
              <button
                type="button"
                disabled={nothing || over > 0 || phase === "saving"}
                onClick={() => void create()}
                className="cursor-pointer rounded bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
              >
                {phase === "saving" ? "Adding…" : addLabel(rulesBody.length, limitsBody.length)}
              </button>
            ) : null}
            {phase === "done" && result && result.failed.length > 0 && lastSave.current ? (
              <button
                type="button"
                onClick={() => {
                  setPhase("review");
                  void create(lastSave.current!);
                }}
                className="cursor-pointer rounded bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400"
              >
                Try again
              </button>
            ) : null}
            {phase === "review" ? (
              <button type="button" onClick={() => fileRef.current?.click()} className="cursor-pointer rounded px-3 py-2 text-sm text-sky-400 hover:text-sky-300">
                Add a screenshot
              </button>
            ) : null}
            <button
              type="button"
              disabled={phase === "saving" || phase === "reading"}
              onClick={onClose}
              className="cursor-pointer rounded px-4 py-2 text-sm text-slate-400 hover:text-slate-200 disabled:cursor-default sm:mr-auto"
            >
              {phase === "done" ? "Close" : "Cancel"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function addLabel(rules: number, limits: number): string {
  const r = `${rules} ${rules === 1 ? "rule" : "rules"}`;
  const l = `${limits} ${limits === 1 ? "limit" : "limits"}`;
  if (rules > 0 && limits > 0) return `Add ${r} and ${l}`;
  if (limits > 0) return `Set ${l}`;
  return `Add ${r}`;
}

function doneSentence(r: Result): string {
  const on = r.created.filter((c) => c.on).length;
  const off = r.created.length - on;
  const parts: string[] = [];
  if (r.created.length > 0) {
    const split = on > 0 && off > 0 ? ` (${on} on, ${off} off)` : off > 0 ? " (off)" : "";
    parts.push(`Added ${r.created.length} ${r.created.length === 1 ? "rule" : "rules"}${split}`);
  }
  if (r.limits > 0) parts.push(`${parts.length ? "set" : "Set"} ${r.limits} ${r.limits === 1 ? "floor and ceiling" : "floors and ceilings"}`);
  return parts.length ? `${parts.join(" and ")}.` : "Nothing was added.";
}

function nameOf(items: ImportItem[], draftsOf: (i: ImportItem) => ImportDraft[], id: string): string {
  for (const item of items) for (const d of draftsOf(item)) if (d.id === id) return d.rule_name;
  return "A rule";
}

function Review({
  items,
  limits,
  roomTypes,
  symbol,
  ticked,
  limitTicked,
  edited,
  draftsOf,
  usable,
  onTick,
  onLimitTick,
  onEdit,
  unread,
}: {
  items: ImportItem[];
  limits: { changes: LimitChange[]; unmatched: string[] };
  roomTypes: MayaRoomType[];
  symbol: string;
  ticked: (item: ImportItem) => boolean;
  limitTicked: (c: LimitChange) => boolean;
  edited: (key: string) => boolean;
  draftsOf: (item: ImportItem) => ImportDraft[];
  usable: (item: ImportItem) => boolean;
  onTick: (key: string, on: boolean) => void;
  onLimitTick: (roomTypeId: string, on: boolean) => void;
  onEdit?: (item: ImportItem, index: number) => void;
  unread: number;
}) {
  if (items.length === 0 && limits.changes.length === 0) {
    return (
      <p className="mt-4 text-sm text-amber-300" data-testid="pie-nothing">
        No PIE rules or price limits found. Use a screenshot of PIE&apos;s Rules and Alerts page with its column headings.
      </p>
    );
  }
  const anyRead = items.some((i) => i.drafts.length > 0);
  return (
    <div className="mt-4 space-y-5">
      {items.length > 0 ? (
        <ul className="space-y-2" data-testid="pie-rules">
          {items.map((item) => {
            const ok = usable(item);
            const drafts = draftsOf(item);
            return (
              <li key={item.key} className={`rounded border border-slate-800 p-3 ${ok ? "" : "opacity-80"}`} data-testid="pie-rule">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Add ${item.pie.name}`}
                    className="mt-1 size-4 shrink-0 cursor-pointer accent-sky-500 disabled:cursor-default"
                    disabled={!ok}
                    checked={ok && ticked(item)}
                    onChange={(e) => onTick(item.key, e.target.checked)}
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-slate-200">{item.pie.name}</span>
                      <span className="text-xs text-slate-500">{item.pie.description || item.pie.typeText}</span>
                    </div>
                    {drafts.length > 0 && item.status !== "not_imported" ? (
                      <ul className="space-y-1">
                        {drafts.map((d, i) => (
                          <li key={d.id} className="flex flex-wrap items-baseline gap-x-2 text-sm text-slate-300">
                            <span aria-hidden className="text-slate-600">
                              →
                            </span>
                            <span>{draftSentence(d, { symbol, roomTypes })}</span>
                            {i === 0 ? (
                              <span className={`rounded px-1.5 text-[0.6875rem] font-medium ${item.on ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700 text-slate-300"}`}>
                                {item.on ? "On" : "Off"}
                              </span>
                            ) : null}
                            {onEdit ? (
                              <button type="button" onClick={() => onEdit(item, i)} className="cursor-pointer text-xs text-sky-400 underline hover:text-sky-300">
                                Edit
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {item.reason && !(item.status === "needs_edit" && edited(item.key)) ? (
                      <p className={`text-xs ${item.status === "not_imported" ? "text-slate-400" : "text-amber-300"}`}>{item.reason}</p>
                    ) : null}
                    {item.notes.map((n) => (
                      <p key={n} className="text-xs text-amber-300">
                        {n}
                      </p>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {limits.changes.length > 0 || limits.unmatched.length > 0 ? (
        <div data-testid="pie-limits">
          <p className="mb-2 text-xs font-medium text-slate-400">Floors and ceilings</p>
          <ul className="space-y-1">
            {limits.changes.map((c) => (
              <li key={c.roomTypeId} className="flex items-start gap-3 text-sm text-slate-300">
                <input
                  type="checkbox"
                  aria-label={`Set ${c.name}'s floor and ceiling`}
                  className="mt-1 size-4 shrink-0 cursor-pointer accent-sky-500 disabled:cursor-default"
                  disabled={c.problem !== null}
                  checked={limitTicked(c)}
                  onChange={(e) => onLimitTick(c.roomTypeId, e.target.checked)}
                />
                <span>
                  {c.name}: {money(c.floor, symbol)} to {money(c.ceiling, symbol)}
                  {c.current.floor !== null && c.current.ceiling !== null ? (
                    <span className="text-slate-500">
                      {" "}
                      (now {money(c.current.floor, symbol)} to {money(c.current.ceiling, symbol)})
                    </span>
                  ) : null}
                  {c.problem ? <span className="block text-xs text-amber-300">{c.problem}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {limits.unmatched.length > 0 ? (
            <p className="mt-2 text-xs text-slate-400">No room type called {limits.unmatched.map((n) => `"${n}"`).join(", ")} in MAYA.</p>
          ) : null}
        </div>
      ) : null}

      {unread > 0 ? <p className="text-xs text-amber-300">{unread === 1 ? "One screenshot" : `${unread} screenshots`} had no PIE rules or limits in them.</p> : null}
      {anyRead ? <p className="text-xs text-slate-500">{PIE_COPY.rounding}</p> : null}
    </div>
  );
}
