"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  earlyResultsReady,
  ImportProgressBar,
  useOnboardingStatus,
} from "@/components/onboarding/import-progress";

/**
 * Full-page import progress. Safe to close — the worker runs server-side.
 * Moves on to the review step as soon as the early analysis has something to
 * show, while older years keep importing; otherwise to the review step or the
 * dashboard when the import completes.
 */
export function ImportProgressView() {
  const router = useRouter();
  const status = useOnboardingStatus();
  const job = status?.job;
  const reconnect = status?.reconnect ?? null;
  const somethingToReview =
    (status?.proposedFindings ?? 0) > 0 || (job?.stats?.starterRules?.length ?? 0) > 0;
  const moveOn = job?.status === "completed" || (earlyResultsReady(job) && somethingToReview);

  // The import usually starts at the claim, so an owner back from paying
  // often arrives to work that is already done. The pause is for watching it
  // finish; with nothing to watch it only holds them up.
  const loaded = status != null;
  const readyOnArrival = useRef<boolean | null>(null);

  useEffect(() => {
    if (!loaded) return;
    if (readyOnArrival.current === null) readyOnArrival.current = moveOn;
    if (!moveOn) return;
    const to = somethingToReview ? "/onboarding/review" : "/";
    if (readyOnArrival.current) {
      router.replace(to);
      return;
    }
    const t = setTimeout(() => router.push(to), 1500);
    return () => clearTimeout(t);
  }, [loaded, moveOn, somethingToReview, router]);

  return (
    <div className="flex flex-col items-center gap-8 pt-10 text-center">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">
          {reconnect
            ? `Reconnect ${reconnect.displayName} to continue`
            : job?.status === "completed"
              ? "All done!"
              : moveOn
                ? "Your first results are ready"
                : "We're studying your booking history"}
        </h1>
        {reconnect ? null : (
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-400">
            {moveOn
              ? "Taking you to what we found…"
              : "This runs on our side, so you can close this page, grab a coffee, or head to your dashboard. We'll flag anything worth reviewing as soon as it's ready."}
          </p>
        )}
      </div>

      <div className="w-full max-w-lg space-y-4 text-left">
        <ImportProgressBar status={status} />

        {job && !reconnect ? (
          <div className="grid grid-cols-3 gap-3">
            <Stat
              label="Room-nights"
              value={job.rows_upserted.toLocaleString()}
            />
            <Stat
              label="Years covered"
              value={
                job.oldest_stay_date && job.newest_stay_date
                  ? String(
                      Math.max(
                        1,
                        Math.round(
                          (Date.parse(job.newest_stay_date) -
                            Date.parse(job.oldest_stay_date)) /
                            (365 * 86_400_000),
                        ),
                      ),
                    )
                  : "—"
              }
            />
            <Stat
              label="Oldest stay"
              value={job.oldest_stay_date ? job.oldest_stay_date.slice(0, 7) : "—"}
            />
          </div>
        ) : null}
      </div>

      <Link href="/" className="text-xs text-slate-400 hover:text-slate-300">
        Go to my dashboard →
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-lg font-semibold tabular-nums text-slate-100">{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">
        {label}
      </div>
    </div>
  );
}
