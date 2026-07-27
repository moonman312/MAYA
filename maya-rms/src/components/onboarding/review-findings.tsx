"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Post-import review: everything the analysis flagged, in plain language,
 * with one-tap confirm/dismiss. Nothing here is scary — we explain WHY each
 * thing was flagged and what confirming does.
 */

type Finding = {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export function ReviewFindings() {
  const router = useRouter();
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/onboarding/findings");
      if (res.ok) {
        const body = (await res.json()) as { findings: Finding[] };
        setFindings(body.findings);
      }
    } catch {
      // retry on next action
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function act(id: string, action: "confirm" | "dismiss") {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/onboarding/findings/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "That didn't save — try again.");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function finish() {
    setFinishing(true);
    try {
      await fetch("/api/onboarding/complete", { method: "POST" });
    } catch {
      // completion is best-effort; dashboard is still usable
    }
    router.push("/");
  }

  const open = (findings ?? []).filter(
    (f) => f.status === "proposed" || f.status === "auto_applied",
  );
  const resolved = (findings ?? []).filter(
    (f) => f.status === "confirmed" || f.status === "dismissed",
  );

  return (
    <div className="flex flex-col gap-6 pt-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">
          Here&apos;s what we noticed in your data
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
          A quick sanity check so your pricing runs on clean data. Confirm what
          we got right, dismiss what we got wrong — takes a minute.
        </p>
      </div>

      {findings === null ? (
        <div className="h-24 animate-pulse rounded-lg bg-slate-900" />
      ) : open.length === 0 ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-200">
          Nothing left to review — your data looks clean.
        </div>
      ) : (
        <div className="space-y-3">
          {open.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              busy={busy === f.id}
              onConfirm={() => act(f.id, "confirm")}
              onDismiss={() => act(f.id, "dismiss")}
            />
          ))}
        </div>
      )}

      {error ? (
        <p className="rounded border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {error}
        </p>
      ) : null}

      {resolved.length > 0 ? (
        <div className="text-[11px] text-slate-600">
          {resolved.length} item{resolved.length === 1 ? "" : "s"} already handled
        </div>
      ) : null}

      <div>
        <button
          type="button"
          disabled={finishing}
          onClick={finish}
          className="cursor-pointer rounded bg-sky-500 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:opacity-60"
        >
          {finishing ? "Finishing up…" : "Finish — take me to my dashboard"}
        </button>
        <p className="mt-2 text-[11px] text-slate-600">
          Anything you skip stays available later — this isn&apos;t your only chance.
        </p>
      </div>
    </div>
  );
}

/* ── Per-kind rendering ───────────────────────────────────────────────────── */

function FindingCard({
  finding,
  busy,
  onConfirm,
  onDismiss,
}: {
  finding: Finding;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const c = describeFinding(finding);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-slate-100">{c.title}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-400">{c.body}</p>
          {finding.status === "auto_applied" ? (
            <p className="mt-1.5 text-[11px] text-slate-500">
              We already did this for you — dismiss to undo it.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="cursor-pointer rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
        >
          {c.confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="cursor-pointer rounded border border-slate-700 px-4 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 disabled:opacity-60"
        >
          {c.dismissLabel}
        </button>
      </div>
    </div>
  );
}

function describeFinding(f: Finding): {
  title: string;
  body: string;
  confirmLabel: string;
  dismissLabel: string;
} {
  const p = f.payload;
  switch (f.kind) {
    case "closed_period":
      return {
        title: `Were you closed ${String(p.start_date)} → ${String(p.end_date)}?`,
        body: `We found ${String(p.days)} straight days with zero occupancy, with normal bookings on both sides. If the property was closed (renovation, season, anything), confirming keeps this stretch from skewing your pricing analysis.`,
        confirmLabel: "Yes, we were closed",
        dismissLabel: "No, we were open",
      };
    case "suspect_room_type": {
      const reasons = Array.isArray(p.reasons) ? (p.reasons as string[]).join("; ") : "";
      return {
        title: `Is "${String(p.name)}" actually a room?`,
        body: `Some systems list every bookable space as a room — event rooms, spa slots, courts. This one caught our eye: ${reasons}. Confirming excludes it from pricing (it stays in your PMS untouched).`,
        confirmLabel: "Not a room — exclude it",
        dismissLabel: "It's a real room",
      };
    }
    case "duplicate_room_type":
      return {
        title: `Hid duplicate room type "${String(p.name)}"`,
        body: "Two room types shared the same name and this one had zero bookings, so we set it aside to keep your occupancy math honest.",
        confirmLabel: "Good call",
        dismissLabel: "Undo — bring it back",
      };
    case "rate_outlier":
      return {
        title: `Some "${String(p.name)}" rates look like typos`,
        body: `The highest rate we saw (${Number(p.max_rate).toLocaleString()}) is far beyond this room's normal range (median ${Number(p.median_rate).toLocaleString()}). Usually a test booking or a fat-fingered rate. Confirming just notes it — we'll ignore extreme values in analysis.`,
        confirmLabel: "Probably a typo",
        dismissLabel: "Those are real",
      };
    case "zero_rate_rows":
      return {
        title: "Some stays have a $0 rate",
        body: `${Number(p.count).toLocaleString()} room-nights came through with no rate — usually comps or data gaps. Just a heads-up; they're excluded from rate analysis.`,
        confirmLabel: "Got it",
        dismissLabel: "Dismiss",
      };
    case "unmapped_room_type":
      return {
        title: "Some old stays reference deleted room types",
        body: `${Number(p.count).toLocaleString()} room-nights point at room types that no longer exist in your PMS. They still count toward history totals but can't be priced.`,
        confirmLabel: "Got it",
        dismissLabel: "Dismiss",
      };
    default:
      return {
        title: "Something worth a look",
        body: JSON.stringify(p),
        confirmLabel: "Confirm",
        dismissLabel: "Dismiss",
      };
  }
}
