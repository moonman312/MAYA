"use client";

/**
 * The explainability drill-down behind a changelog entry, plus the
 * corrections panel that shows every challenge on file.
 *
 * Levels reveal progressively — most owners stop at the changelog sentence
 * (level one); each step deeper is one click, down to the raw list of
 * comparable nights. Every night in that list can be challenged in place:
 * "that week was our renovation" removes it from future comparisons
 * immediately, and recurring patterns only generalize after reports from
 * multiple distinct years (see observations/reinforcement.ts).
 */

import { useCallback, useState } from "react";
import {
  CHALLENGE_REASONS,
  type ChallengeScope,
} from "@/lib/observations/reinforcement";
import { humanDate, type ExplainView } from "@/lib/explain";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok) {
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

/* ── Shared shapes (mirror the API responses) ─────────────────── */

type ChallengeSummary = {
  challenges: {
    id: string;
    date: string;
    reason_key: string;
    reason_label: string;
    other_text: string | null;
    scope: ChallengeScope;
    description: string;
  }[];
  pending: { description: string; dates: string[] }[];
  promoted: { description: string; supporting_dates: string[] }[];
};

const SCOPE_LABELS: Record<ChallengeScope, string> = {
  this_date: "Just set aside this one date (recommended)",
  annual: "This happens every year around this time",
  improve_future: "This should also change how our seasons are read (advanced)",
};

const SCOPE_HINTS: Record<ChallengeScope, string> = {
  this_date:
    "This date stops feeding comparisons and seasonal calculations from the next pricing run. It is not treated as a yearly pattern — pick one of the options below if you believe it repeats.",
  annual:
    "The date is set aside now. Treating it as a yearly pattern needs pattern reports like this one from 2 different years first.",
  improve_future:
    "The date is set aside now, and this report also counts toward the yearly pattern. Reshaping the season model itself needs a report at this level from 3 different years first — one correction should never bend the whole model.",
};

/* ── Challenge form (inline, per comparable night) ────────────── */

function ChallengeForm({
  date,
  onDone,
  onCancel,
}: {
  date: string;
  onDone: (summary: ChallengeSummary | null) => void;
  onCancel: () => void;
}) {
  const [reasonKey, setReasonKey] = useState("");
  const [scope, setScope] = useState<ChallengeScope>("this_date");
  const [otherText, setOtherText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reason = CHALLENGE_REASONS.find((r) => r.key === reasonKey) ?? null;
  const scopes = reason?.suggestedScopes ?? ["this_date"];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const summary = await api<ChallengeSummary>("/api/challenges", {
        method: "POST",
        body: JSON.stringify({
          date,
          reason_key: reasonKey,
          scope,
          other_text: otherText.trim() || undefined,
        }),
      });
      onDone(summary?.challenges ? summary : null);
    } catch (e) {
      // 409: this exact flag already exists — the goal is already achieved,
      // so refresh and land in the flagged state instead of a dead end.
      if (e instanceof ApiError && e.status === 409) {
        const summary = await api<ChallengeSummary>("/api/challenges").catch(() => null);
        onDone(summary);
        return;
      }
      setError(e instanceof Error ? e.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 rounded border border-slate-700 bg-slate-950 p-3">
      <p className="text-xs text-slate-300">
        What made {humanDate(date)} not a fair comparison?
      </p>
      <select
        value={reasonKey}
        className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm"
        onChange={(e) => {
          setReasonKey(e.target.value);
          setScope("this_date");
        }}
      >
        <option value="">Choose a reason…</option>
        {CHALLENGE_REASONS.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
      {reason?.key === "other" ? (
        <input
          type="text"
          value={otherText}
          placeholder="Tell us in a few words what happened"
          className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm"
          onChange={(e) => setOtherText(e.target.value)}
        />
      ) : null}
      {reason && scopes.length > 1 ? (
        <div className="space-y-1">
          {scopes.map((s) => (
            <label key={s} className="flex cursor-pointer items-start gap-2 text-xs text-slate-300">
              <input
                type="radio"
                name={`scope-${date}`}
                checked={scope === s}
                className="mt-0.5"
                onChange={() => setScope(s)}
              />
              <span>
                {SCOPE_LABELS[s]}
                {scope === s ? (
                  <span className="mt-0.5 block text-[11px] text-slate-500">{SCOPE_HINTS[s]}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-xs text-rose-300">{error}</p> : null}
      <div className="flex gap-2">
        <button
          disabled={busy || !reason || (reason.key === "other" && !otherText.trim())}
          className="cursor-pointer rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Set this date aside"}
        </button>
        <button
          className="cursor-pointer rounded bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700"
          onClick={onCancel}
        >
          Never mind
        </button>
      </div>
    </div>
  );
}

/* ── One observation, rendered as its levels ──────────────────── */

function ObservationView({
  view,
  challengedDates,
  onChallenged,
}: {
  view: ExplainView;
  challengedDates: Set<string>;
  onChallenged: (summary: ChallengeSummary | null) => void;
}) {
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [challenging, setChallenging] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <div className="space-y-1 text-[13px] leading-relaxed text-slate-300">
        <p>{view.observed}</p>
        <p>{view.expected}</p>
        <p className="font-medium text-slate-200">{view.verdict}</p>
        {view.guard_note ? <p className="text-slate-400">{view.guard_note}</p> : null}
      </div>

      {!showAssumptions ? (
        <button
          className="cursor-pointer text-xs text-sky-400 hover:text-sky-300"
          onClick={() => setShowAssumptions(true)}
        >
          Why did you expect that?
        </button>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-400">
          {view.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
          {view.momentum_notes.map((m, i) => (
            <li key={`m-${i}`}>{m}</li>
          ))}
        </ul>
      )}

      {showAssumptions && view.comparables.length > 0 && !showEvidence ? (
        <button
          className="cursor-pointer text-xs text-sky-400 hover:text-sky-300"
          onClick={() => setShowEvidence(true)}
        >
          Show me the nights you compared
        </button>
      ) : null}

      {showEvidence ? (
        <ul className="space-y-1.5">
          {view.comparables.map((c) => {
            const flagged = challengedDates.has(c.date);
            return (
              <li key={c.date} className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-slate-200">
                    {humanDate(c.date)}
                    <span className="ml-2 font-normal text-slate-400">{c.summary}</span>
                  </span>
                  {flagged ? (
                    <span className="text-[11px] text-amber-300">
                      Set aside — not used from the next run onward
                    </span>
                  ) : challenging !== c.date ? (
                    <button
                      className="cursor-pointer text-[11px] text-slate-400 underline decoration-dotted hover:text-slate-200"
                      onClick={() => setChallenging(c.date)}
                    >
                      Not a fair comparison?
                    </button>
                  ) : null}
                </div>
                {c.reasons.length > 0 ? (
                  <p className="mt-0.5 text-[11px] text-slate-500">{c.reasons.join("; ")}</p>
                ) : null}
                {challenging === c.date ? (
                  <ChallengeForm
                    date={c.date}
                    onCancel={() => setChallenging(null)}
                    onDone={(summary) => {
                      setChallenging(null);
                      onChallenged(summary);
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/* ── The per-entry expander ───────────────────────────────────── */

export function ExplainDrilldown({
  runId,
  stayDate,
  roomTypeId,
}: {
  runId: string;
  stayDate: string;
  roomTypeId: string;
}) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<ExplainView[] | null>(null);
  const [challenged, setChallenged] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [explain, summary] = await Promise.all([
        api<{ views: ExplainView[] }>(
          `/api/explain?run_id=${encodeURIComponent(runId)}&stay_date=${stayDate}&room_type_id=${encodeURIComponent(roomTypeId)}`,
        ),
        api<ChallengeSummary>("/api/challenges").catch(() => null),
      ]);
      setViews(explain.views);
      if (summary) setChallenged(new Set(summary.challenges.map((c) => c.date)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the details");
    }
  }, [runId, stayDate, roomTypeId]);

  if (!open) {
    return (
      <button
        className="mt-1 cursor-pointer text-xs text-sky-400 hover:text-sky-300"
        onClick={() => {
          setOpen(true);
          if (views === null) void load();
        }}
      >
        How did we know?
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-3 rounded border border-slate-800 bg-slate-950/60 p-3">
      {error ? (
        <p className="text-xs text-rose-300">
          {error}{" "}
          <button
            className="cursor-pointer text-sky-400 underline decoration-dotted hover:text-sky-300"
            onClick={() => void load()}
          >
            Try again
          </button>
        </p>
      ) : views === null ? (
        <p className="text-xs text-slate-400">Pulling up what we knew at the time…</p>
      ) : views.length === 0 ? (
        <p className="text-xs text-slate-400">
          No booking-speed observation was recorded for this change.
        </p>
      ) : (
        views.map((v, i) => (
          <ObservationView
            key={i}
            view={v}
            challengedDates={challenged}
            onChallenged={(summary) => {
              if (summary) setChallenged(new Set(summary.challenges.map((c) => c.date)));
            }}
          />
        ))
      )}
      <button
        className="cursor-pointer text-xs text-slate-500 hover:text-slate-300"
        onClick={() => setOpen(false)}
      >
        Close
      </button>
    </div>
  );
}

/* ── Corrections panel (changelog tab header) ─────────────────── */

export function CorrectionsPanel() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<ChallengeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSummary(await api<ChallengeSummary>("/api/challenges"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load corrections");
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && summary === null) void load();
  };

  const retract = async (id: string) => {
    setRemoving(id);
    setError(null);
    try {
      await api<{ ok: boolean }>(`/api/challenges/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="rounded border border-slate-800 p-3">
      <button
        className="flex w-full cursor-pointer items-center justify-between text-left"
        onClick={toggle}
      >
        <span className="text-sm font-medium text-slate-200">Your corrections</span>
        <span className="text-xs text-slate-500">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="mt-2 space-y-3">
          {error ? (
            <p className="text-xs text-rose-300">
              {error}{" "}
              <button
                className="cursor-pointer text-sky-400 underline decoration-dotted hover:text-sky-300"
                onClick={() => void load()}
              >
                Try again
              </button>
            </p>
          ) : null}
          {summary === null && !error ? (
            <p className="text-xs text-slate-400">Loading…</p>
          ) : null}
          {summary && summary.challenges.length === 0 ? (
            <p className="text-xs leading-relaxed text-slate-400">
              When a price explanation leans on a night that was not normal — a
              renovation week, a festival, a group buyout — open the evidence
              behind the change and flag it. Flagged nights stop being used in
              comparisons, and your corrections collect here.
            </p>
          ) : null}
          {summary && summary.challenges.length > 0 ? (
            <ul className="space-y-1.5">
              {summary.challenges.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-slate-800 bg-slate-900/60 px-3 py-2"
                >
                  <span className="text-xs text-slate-300">
                    <span className="font-medium text-slate-200">{humanDate(c.date)}</span>
                    {" — "}
                    {c.description}
                  </span>
                  <button
                    disabled={removing === c.id}
                    className="cursor-pointer text-[11px] text-slate-500 underline decoration-dotted hover:text-slate-300 disabled:opacity-60"
                    onClick={() => void retract(c.id)}
                  >
                    {removing === c.id ? "Removing…" : "Undo"}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {summary && summary.pending.length > 0 ? (
            <div className="space-y-1">
              {summary.pending.map((p, i) => (
                <p key={i} className="text-[11px] leading-relaxed text-slate-500">
                  {p.description}
                </p>
              ))}
            </div>
          ) : null}
          {summary && summary.promoted.length > 0 ? (
            <div className="space-y-1">
              {summary.promoted.map((p, i) => (
                <p key={i} className="text-[11px] leading-relaxed text-amber-300/80">
                  {p.description}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
