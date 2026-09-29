"use client";

import { useEffect, useState } from "react";

/**
 * Dashboard banner for users who left onboarding before the import finished:
 * once an analysis has findings awaiting review, nudge them back. That can be
 * the early analysis while older years are still importing, or a finding the
 * final analysis raised after they had already finished reviewing.
 * Renders nothing in every other situation.
 */
export function OnboardingReviewBanner({ hotelId = null }: { hotelId?: string | null }) {
  // hotelId is the property on screen: the status is read again when it
  // changes, and a read for another property is never shown for this one.
  const [loaded, setLoaded] = useState<{ hotelId: string | null; count: number } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/onboarding/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!alive || !body) return;
        const b = body as {
          connected?: boolean;
          state?: { review_completed_at: string | null } | null;
          job?: { status: string; stats?: { earlyAnalysisAt?: string } } | null;
          proposedFindings?: number;
          latestProposedAt?: string | null;
        };
        const analysed =
          b.job?.status === "completed" ||
          (b.job?.status === "running" && typeof b.job.stats?.earlyAnalysisAt === "string");
        const reviewedAt = b.state?.review_completed_at;
        const unseen =
          !reviewedAt ||
          (!!b.latestProposedAt && Date.parse(b.latestProposedAt) > Date.parse(reviewedAt));
        if (b.connected && analysed && unseen && (b.proposedFindings ?? 0) > 0) {
          setLoaded({ hotelId, count: b.proposedFindings ?? 0 });
        } else {
          setLoaded(null);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hotelId]);

  const show = loaded?.hotelId === hotelId ? loaded : null;
  if (!show) return null;

  return (
    <a
      href="/onboarding/review"
      className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-sky-500/40 bg-sky-500/10 px-5 py-3.5 transition-colors hover:border-sky-400"
    >
      <div>
        <div className="text-sm font-semibold text-sky-200">
          Your booking history has been read
        </div>
        <div className="mt-0.5 text-xs text-sky-200/70">
          We found {show.count} thing{show.count === 1 ? "" : "s"} worth a quick
          look. It takes about a minute.
        </div>
      </div>
      <span className="shrink-0 text-sm font-medium text-sky-300">Review →</span>
    </a>
  );
}
