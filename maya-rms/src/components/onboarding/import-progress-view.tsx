"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  ImportProgressBar,
  useOnboardingStatus,
} from "@/components/onboarding/import-progress";

/**
 * Full-page import progress. Safe to close — the worker runs server-side.
 * Auto-advances to the review step when the import completes with findings,
 * or to the dashboard when it completes clean.
 */
export function ImportProgressView() {
  const router = useRouter();
  const status = useOnboardingStatus();
  const job = status?.job;

  useEffect(() => {
    if (!job || job.status !== "completed") return;
    const t = setTimeout(() => {
      router.push((status?.proposedFindings ?? 0) > 0 ? "/onboarding/review" : "/");
    }, 1500);
    return () => clearTimeout(t);
  }, [job, status?.proposedFindings, router]);

  return (
    <div className="flex flex-col items-center gap-8 pt-10 text-center">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">
          {job?.status === "completed"
            ? "All done!"
            : "We're studying your booking history"}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-400">
          {job?.status === "completed"
            ? "Taking you to what we found…"
            : "This runs on our side — you can close this page, grab a coffee, or head to your dashboard. We'll flag anything worth reviewing when it's done."}
        </p>
      </div>

      <div className="w-full max-w-lg space-y-4 text-left">
        <ImportProgressBar status={status} />

        {job ? (
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

      <Link href="/" className="text-xs text-slate-500 hover:text-slate-300">
        Go to my dashboard →
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-lg font-semibold tabular-nums text-slate-100">{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
    </div>
  );
}
