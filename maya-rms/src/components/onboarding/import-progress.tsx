"use client";

import { useEffect, useState } from "react";

export type OnboardingStatus = {
  connected: boolean;
  hotelId?: string;
  hotelName?: string | null;
  currency?: string | null;
  state?: {
    questions: Record<string, unknown>;
    questions_completed_at: string | null;
    review_completed_at: string | null;
  } | null;
  job?: {
    status: string;
    phase: string;
    windows_completed: number;
    rows_upserted: number;
    oldest_stay_date: string | null;
    newest_stay_date: string | null;
    last_error: string | null;
    finished_at: string | null;
    stats?: {
      starterRules?: Array<{ name: string; explanation: string }>;
      [key: string]: unknown;
    };
  } | null;
  proposedFindings?: number;
  simulationMode?: boolean;
};

export function useOnboardingStatus(pollMs = 4000): OnboardingStatus | null {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const res = await fetch("/api/onboarding/status");
        if (res.ok && alive) setStatus((await res.json()) as OnboardingStatus);
      } catch {
        // transient — keep last status
      }
    }
    tick();
    const id = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);

  return status;
}

const PHASE_LABELS: Record<string, string> = {
  discover: "Reading your property setup",
  sync_current: "Importing the last year in detail",
  historical: "Importing older history",
  analyze: "Analyzing your data",
  done: "Import complete",
};

/** Slim progress strip shown under the questions and on the progress page. */
export function ImportProgressBar({ status }: { status: OnboardingStatus | null }) {
  const job = status?.job;
  if (!job) return null;

  const finished = job.status === "completed";
  const failed = job.status === "failed";
  // "failed" is where the worker gave up, not where it is still trying —
  // promising more retries there leaves someone waiting on a thing that has
  // already stopped. Everything before it (queued, running) genuinely does
  // retry, and says so by simply continuing to show progress.
  const label = failed
    ? "Import stopped — we've been told, and we'll pick it up"
    : finished
      ? "Import complete"
      : PHASE_LABELS[job.phase] ?? "Working…";

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {!finished && !failed ? (
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-sky-500" />
            </span>
          ) : (
            <span
              className={`inline-flex size-2.5 rounded-full ${finished ? "bg-emerald-500" : "bg-amber-500"}`}
            />
          )}
          <span className="text-xs font-medium text-slate-300">{label}</span>
        </div>
        <span className="text-[11px] tabular-nums text-slate-500">
          {job.rows_upserted.toLocaleString()} room-nights
          {job.oldest_stay_date ? ` · back to ${job.oldest_stay_date.slice(0, 7)}` : ""}
        </span>
      </div>
    </div>
  );
}
