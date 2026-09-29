"use client";

import Link from "next/link";
import { useState } from "react";
import { stoppedLabel, useOnboardingStatus, type OnboardingStatus } from "@/components/onboarding/import-progress";
import { LearnMore } from "@/components/deep-links/help-links";

type Job = OnboardingStatus["job"];

/** Enough of a job to tell the one a press started from the one before it. */
function jobKey(job: Job): string {
  return job ? `${job.status}|${job.started_at ?? ""}|${job.finished_at ?? ""}` : "none";
}

/**
 * The line shown beside the button when the last read gave up, so a read
 * that stops never just turns quietly back into the button. Null otherwise.
 */
export function gaveUpLine(job: Job, nowMs: number = Date.now()): string | null {
  if (job?.status === "failed") return stoppedLabel(job, nowMs, "Your last read");
  if (job?.status === "canceled") {
    return /disconnected|no PMS connection/.test(job.last_error ?? "")
      ? "Your last read stopped because your property system is no longer connected."
      : "Your last read stopped before it finished.";
  }
  return null;
}

/**
 * "Ask Maya for help" from the Rules page — re-runs the guided analysis on a
 * hotel that already has configuration. The promise it makes (and keeps):
 * nothing changes by itself. The run produces suggestions reviewed one by one.
 * A PMS with no history import (Mews today) gets the button switched off with
 * a note, since there is nothing for the read to read.
 */
export function AskForHelp() {
  const status = useOnboardingStatus(8000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The job as it was when the read was started. Until the status shows a
  // different one, the new read has not reached it yet and counts as running;
  // from then on the job's own status says what is happening.
  const [kickedFrom, setKickedFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const job = status?.job;
  const waitingForKick = kickedFrom !== null && jobKey(job) === kickedFrom;
  const running = waitingForKick || job?.status === "queued" || job?.status === "running";
  const suggestionsReady =
    !waitingForKick &&
    job?.status === "completed" &&
    (status?.proposedFindings ?? 0) > 0 &&
    !status?.state?.review_completed_at;

  async function start() {
    setError(null);
    const before = jobKey(job);
    try {
      const res = await fetch("/api/onboarding/refresh", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Couldn't start the read. Try again.");
      }
      setKickedFrom(before);
      setConfirmOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the read. Try again.");
    }
  }

  if (status?.historyImport === false) {
    const pms = status.pmsName ?? "your property system";
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-500"
        >
          🤝 Get suggestions from my data
        </button>
        <span className="text-xs text-slate-400">
          Not available for {pms} yet. MAYA can&apos;t read its booking history.
        </span>
      </div>
    );
  }

  if (suggestionsReady) {
    return (
      <Link
        href="/onboarding/review"
        className="inline-flex cursor-pointer items-center gap-2 rounded border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:border-emerald-400"
      >
        {status?.proposedFindings} suggestion{status?.proposedFindings === 1 ? "" : "s"} ready →
      </Link>
    );
  }

  if (running) {
    return (
      <span className="inline-flex items-center gap-2 rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
        </span>
        Reading your history…
      </span>
    );
  }

  const gaveUp = gaveUpLine(job);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative">
        <button
          type="button"
          onClick={() => setConfirmOpen((o) => !o)}
          className="cursor-pointer rounded border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:border-sky-400"
        >
          🤝 Get suggestions from my data
        </button>

        {confirmOpen ? (
          <div className="absolute right-0 top-full z-10 mt-2 w-80 rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-xl">
            <div className="text-sm font-semibold text-slate-100">
              Here&apos;s exactly what happens
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              We re-read your booking history and compare it against your current
              rules and price guardrails. <span className="text-slate-200">Nothing
              changes by itself</span>. You get a list of suggestions and
              approve or reject each one individually. Your existing rules stay
              exactly as they are unless you say otherwise.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={start}
                className="cursor-pointer rounded bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400"
              >
                Sounds good, read it
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="cursor-pointer px-2 py-1.5 text-xs text-slate-400 hover:text-slate-300"
              >
                Never mind
              </button>
            </div>
            {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
            <LearnMore panel="ask-for-help" />
          </div>
        ) : null}
      </div>
      {gaveUp ? <span className="text-xs text-amber-300">{gaveUp}</span> : null}
    </div>
  );
}
