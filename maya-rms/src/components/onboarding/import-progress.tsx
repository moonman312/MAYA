"use client";

import { useEffect, useState } from "react";
import { PmsReconnect } from "@/components/pms-reconnect";

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
    started_at?: string | null;
    finished_at: string | null;
    stats?: {
      starterRules?: Array<{ name: string; explanation: string }>;
      /** Why the starter rules are not what the last question's answer asked for. */
      starterRulesNote?: string;
      /** Stamped once findings and starter rules exist for the first three years. */
      earlyAnalysisAt?: string;
      currentSync?: { covered?: boolean; passes?: number };
      /** Set by the worker when it stops the import (worker-core.ts ImportStop). */
      stop?: { count?: number; at?: string; retryAt?: string | null; alerted?: boolean };
      [key: string]: unknown;
    };
  } | null;
  /**
   * The starter rules from the newest import that built any, which a later
   * "Get suggestions from my data" job does not. Older servers leave it out.
   */
  starterRules?: Array<{ name: string; explanation: string }>;
  /** The note that goes with `starterRules`, when there is one. Older servers leave it out. */
  starterRulesNote?: string | null;
  proposedFindings?: number;
  simulationMode?: boolean;
  /** The hotel's PMS (pms_connections.pms_type); older servers leave it out. */
  pmsType?: string | null;
  /** Nights the push sends (pricingHorizonDays); older servers leave it out. */
  pushWindowDays?: number;
  /** The PMS's name, from the registry; older servers leave it out. */
  pmsName?: string | null;
  /**
   * False when the hotel's PMS has no history import (Mews today), so a read
   * has nothing to read; null with no connection; older servers leave it out.
   */
  historyImport?: boolean | null;
  /** The PMS connection is gone and the import cannot run until it is reconnected. */
  reconnect?: {
    pmsType: string;
    authKind: string;
    displayName: string;
    canManage: boolean;
    historyRemoved: boolean;
  } | null;
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
  sync_current: "Reading your current bookings",
  historical: "Importing past years",
  analyze_early: "Building your starter rules",
  analyze: "Checking your full history",
  done: "Import complete",
};

/**
 * Whether there is something to review before the import has finished: the
 * early analysis has written findings and starter rules for the first three
 * years while older ones keep loading.
 */
export function earlyResultsReady(job: OnboardingStatus["job"]): boolean {
  // Queued counts: an import that stopped after its early analysis and was
  // picked up again at payment is waiting to carry on, with results in hand.
  return (
    (job?.status === "running" || job?.status === "queued") && typeof job.stats?.earlyAnalysisAt === "string"
  );
}

function phaseLabel(job: NonNullable<OnboardingStatus["job"]>): string {
  // A book too big for one pass takes several, and the label should not sit
  // still looking stuck while it does.
  const passes = Number(job.stats?.currentSync?.passes ?? 0);
  if (job.phase === "sync_current" && passes > 0 && job.stats?.currentSync?.covered !== true) {
    return `Reading your current bookings (part ${passes + 1})`;
  }
  if (job.phase === "historical" && earlyResultsReady(job)) {
    return "First results ready. Importing older years";
  }
  return PHASE_LABELS[job.phase] ?? "Working…";
}

/** "3:40 PM" today, "Wed 3:40 PM" on another day, in the viewer's own time. */
function retryTime(ms: number, nowMs: number): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/**
 * What a stopped import says, from what the worker recorded when it stopped
 * it: whether it goes back in the queue by itself and when, and whether the
 * alert reached us. "We've been told" appears only when it did. `what` names
 * the job: the import on the progress bar, "Your last read" on the Rules tab.
 */
export function stoppedLabel(
  job: NonNullable<OnboardingStatus["job"]>,
  nowMs: number = Date.now(),
  what: string = "Import",
): string {
  const stop = job.stats?.stop;
  const told = stop?.alerted === true;
  const retryAt = stop?.retryAt ? Date.parse(stop.retryAt) : NaN;
  if (Number.isFinite(retryAt)) {
    const when = retryAt > nowMs ? `around ${retryTime(retryAt, nowMs)}` : "in a minute or two";
    return told
      ? `${what} paused. We've been told, and it tries again by itself ${when}.`
      : `${what} paused. It tries again by itself ${when}.`;
  }
  return told ? `${what} stopped. We've been told.` : `${what} stopped. Email us and we'll restart it.`;
}

/** Slim progress strip shown under the questions and on the progress page. */
export function ImportProgressBar({ status }: { status: OnboardingStatus | null }) {
  const job = status?.job;
  // Nothing can be read without a connection, so the prompt to reconnect
  // stands in for a progress bar that would never move.
  if (status?.reconnect && status.hotelId) {
    return (
      <PmsReconnect
        hotelId={status.hotelId}
        pmsType={status.reconnect.pmsType}
        status="disconnected"
        authKind={status.reconnect.authKind}
        displayName={status.reconnect.displayName}
        canManage={status.reconnect.canManage}
        placement="banner"
        historyRemoved={status.reconnect.historyRemoved}
      />
    );
  }
  if (!job) return null;

  const finished = job.status === "completed";
  const failed = job.status === "failed";
  // Stopped because the connection went away: nothing is running, so no
  // spinner, and nobody has been told, so not the failure line either.
  const stopped = job.status === "canceled";
  // "failed" is where the worker stopped trying for now. What comes next (a
  // retry it has booked, or nothing) is on the job, and the label says exactly
  // that. Everything before it (queued, running) retries on its own, and says
  // so by simply continuing to show progress.
  const label = failed
    ? stoppedLabel(job)
    : finished
      ? "Import complete"
      : phaseLabel(job);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {!finished && !failed && !stopped ? (
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
        <span className="text-[11px] tabular-nums text-slate-400">
          {job.rows_upserted.toLocaleString()} room-nights
          {job.oldest_stay_date ? ` · back to ${job.oldest_stay_date.slice(0, 7)}` : ""}
        </span>
      </div>
    </div>
  );
}
