"use client";

import Link from "next/link";
import { useState } from "react";
import { useOnboardingStatus } from "@/components/onboarding/import-progress";

/**
 * "Ask Maya for help" from the Rules page — re-runs the guided analysis on a
 * hotel that already has configuration. The promise it makes (and keeps):
 * nothing changes by itself. The run produces suggestions reviewed one by one.
 */
export function AskForHelp() {
  const status = useOnboardingStatus(8000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const job = status?.job;
  const running = kicked || job?.status === "queued" || job?.status === "running";
  const suggestionsReady =
    !kicked &&
    job?.status === "completed" &&
    (status?.proposedFindings ?? 0) > 0 &&
    !status?.state?.review_completed_at;

  async function start() {
    setError(null);
    try {
      const res = await fetch("/api/onboarding/refresh", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Couldn't start the analysis — try again.");
      }
      setKicked(true);
      setConfirmOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the analysis — try again.");
    }
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
        Studying your data…
      </span>
    );
  }

  return (
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
            changes by itself</span> — you get a list of suggestions and
            approve or reject each one individually. Your existing rules stay
            exactly as they are unless you say otherwise.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={start}
              className="cursor-pointer rounded bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400"
            >
              Sounds good — analyze
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
        </div>
      ) : null}
    </div>
  );
}
