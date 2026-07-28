"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useOnboardingStatus } from "@/components/onboarding/import-progress";

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

      <StarterRules />

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

/* ── Starter rules: the payoff ────────────────────────────────────────────── */

function StarterRules() {
  const status = useOnboardingStatus(15000);
  const [going, setGoing] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rules = (status?.job?.stats?.starterRules ?? []) as Array<{
    name: string;
    explanation: string;
  }>;
  if (rules.length === 0) return null;

  const inSimulation = !live && status?.simulationMode !== false;

  async function goLive() {
    setGoing(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/activate", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Couldn't switch to live — try again.");
      }
      setLive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't switch to live — try again.");
    } finally {
      setGoing(false);
    }
  }

  return (
    <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5">
      <h2 className="text-base font-semibold text-slate-100">
        While you were here, we built your first pricing rules
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
        Based on your own booking history — they&apos;re already running in{" "}
        <span className="text-slate-300">simulation mode</span>: watching every
        night and showing what they <em>would</em> do, without touching a
        single price.
      </p>

      <div className="mt-4 space-y-2.5">
        {rules.map((r) => (
          <div key={r.name} className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
            <div className="text-sm font-semibold text-slate-200">{r.name}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{r.explanation}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        {inSimulation ? (
          <>
            <button
              type="button"
              disabled={going}
              onClick={goLive}
              className="cursor-pointer rounded bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
            >
              {going ? "Switching…" : "Turn them on for real"}
            </button>
            <span className="text-[11px] text-slate-500">
              Or leave them in simulation and watch for a while — also a great choice.
            </span>
          </>
        ) : (
          <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-300">
            ✓ Live — your rules are now managing prices
          </span>
        )}
      </div>
      {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
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
        {c.acknowledgeOnly ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="cursor-pointer rounded border border-slate-700 px-4 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 disabled:opacity-60"
          >
            {c.dismissLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export function describeFinding(f: Finding): {
  title: string;
  body: string;
  confirmLabel: string;
  dismissLabel: string;
  /** Purely informational — show a single acknowledgement button, no dismiss. */
  acknowledgeOnly?: boolean;
} {
  const p = f.payload;
  switch (f.kind) {
    case "closed_period": {
      // Seasonal pattern: one question for the whole recurring closure.
      if (p.recurring === true) {
        const years = Number(p.years_observed ?? 0);
        return {
          title: `Is your property normally closed ${String(p.season_label)}?`,
          body: `We see the same closure ${years} years running. One confirmation covers all of them — we'll keep those stretches from skewing your pricing analysis.`,
          confirmLabel: "Yes, that's our season",
          dismissLabel: "No, we were open",
        };
      }
      return {
        title: `Were you closed ${String(p.start_date)} → ${String(p.end_date)}?`,
        body: `We found ${String(p.days)} straight days with zero occupancy, with normal bookings on both sides. If the property was closed (renovation, season, anything), confirming keeps this stretch from skewing your pricing analysis.`,
        confirmLabel: "Yes, we were closed",
        dismissLabel: "No, we were open",
      };
    }
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
        body: `${Number(p.count).toLocaleString()} room-nights came through with no rate — usually comps or data gaps. Nothing you have to do — we'll ignore them for the purpose of this analysis.`,
        confirmLabel: "Got it",
        dismissLabel: "Dismiss",
        acknowledgeOnly: true,
      };
    case "rule_suggestion": {
      if (p.suggestion_type === "adjust_rule") {
        return {
          title: `Tune "${String(p.rule_name)}"?`,
          body: `${String(p.rationale)} We'd move its trigger from ${Math.round(Number(p.current_threshold) * 100)}% to ${Math.round(Number(p.suggested_threshold) * 100)}% occupancy.`,
          confirmLabel: "Make that change",
          dismissLabel: "Leave it as is",
        };
      }
      const spec = (p.spec ?? {}) as { name?: string; explanation?: string };
      return {
        title: `Add a rule: "${String(spec.name ?? "New rule")}"?`,
        body: `${String(p.rationale)} ${String(spec.explanation ?? "")}`,
        confirmLabel: "Add this rule",
        dismissLabel: "No thanks",
      };
    }
    case "guardrail_suggestion": {
      const isFloor = p.field === "floor_price";
      return {
        title: `Set a ${isFloor ? "floor" : "ceiling"} for "${String(p.room_type_name)}"?`,
        body: `${String(p.rationale)} We'd set it to ${Number(p.suggested).toLocaleString()}.`,
        confirmLabel: `Set it to ${Number(p.suggested).toLocaleString()}`,
        dismissLabel: "No thanks",
      };
    }
    case "unmapped_room_type":
      return {
        title: "Some old stays reference deleted room types",
        body: `${Number(p.count).toLocaleString()} room-nights point at room types that no longer exist in your PMS. They still count toward history totals but can't be priced. Nothing you have to do here — we've already accounted for them.`,
        confirmLabel: "Got it",
        dismissLabel: "Dismiss",
        acknowledgeOnly: true,
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
