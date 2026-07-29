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
  const [step, setStep] = useState<"assumptions" | "recommendations">("assumptions");

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

  async function act(id: string, action: "confirm" | "dismiss", value?: number, keepRule?: boolean) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/onboarding/findings/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(value != null ? { value } : {}),
          ...(keepRule ? { keepRule: true } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "That didn't save — try again.");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save — try again.");
      // A 409 means another tab or an earlier retry already resolved this
      // one — refresh so the stale card doesn't sit there looking actionable.
      await load();
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

  // Two passes: first the data assumptions (closures, suspect room types,
  // typos...) so recommendations are judged against validated data, THEN
  // the rule and guardrail recommendations built on those assumptions.
  const RECOMMENDATION_KINDS = new Set(["rule_suggestion", "guardrail_suggestion"]);
  const assumptions = open.filter((f) => !RECOMMENDATION_KINDS.has(f.kind));
  const recommendations = open.filter((f) => RECOMMENDATION_KINDS.has(f.kind));
  const showAssumptionStep = step === "assumptions" && assumptions.length > 0;

  return (
    <div className="flex flex-col gap-6 pt-6">
      {showAssumptionStep ? (
        <>
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">
              First: does this match reality?
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
              A quick sanity check so your pricing runs on clean data — and so
              the recommendations on the next screen are built on facts you
              have confirmed. Confirm what we got right, dismiss what we got
              wrong.
            </p>
          </div>

          <div className="space-y-3">
            {assumptions.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                busy={busy === f.id}
                onConfirm={(value) => act(f.id, "confirm", value)}
                onKeep={() => act(f.id, "confirm", undefined, true)}
                onDismiss={() => act(f.id, "dismiss")}
              />
            ))}
          </div>

          {error ? (
            <p className="rounded border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
              {error}
            </p>
          ) : null}

          <div>
            <button
              type="button"
              onClick={() => setStep("recommendations")}
              className="cursor-pointer rounded bg-sky-500 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-400"
            >
              Continue to recommendations
            </button>
            <p className="mt-2 text-[11px] text-slate-600">
              Anything you skip stays available later — this isn&apos;t your only chance.
            </p>
          </div>
        </>
      ) : (
        <>
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">
              Recommendations from your data
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
              Rules and guardrails your booking history supports — including
              anything that would conflict with them. Approve what you like,
              ignore the rest; nothing changes without your say-so.
            </p>
          </div>

          {findings === null ? (
            <div className="h-24 animate-pulse rounded-lg bg-slate-900" />
          ) : recommendations.length === 0 && open.length === 0 ? (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-200">
              Nothing left to review — your data looks clean.
            </div>
          ) : recommendations.length === 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-5 py-4 text-sm text-slate-400">
              No new recommendations this time.
            </div>
          ) : (
            <div className="space-y-3">
              {recommendations.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  busy={busy === f.id}
                  onConfirm={(value) => act(f.id, "confirm", value)}
                  onKeep={() => act(f.id, "confirm", undefined, true)}
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
        </>
      )}
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
  onKeep,
  onDismiss,
}: {
  finding: Finding;
  busy: boolean;
  onConfirm: (value?: number) => void;
  /** Middle option on removal cards: accept the conflict, pause the rule instead of deleting it. */
  onKeep: () => void;
  onDismiss: () => void;
}) {
  const c = describeFinding(finding);
  // Recommendations with a number should never send the owner hunting for a
  // setting: the suggested value sits in an input right on the card, so
  // "accept", "pad it a bit", and "use my own number" are all one click.
  const editable = finding.kind === "guardrail_suggestion";
  const suggested = editable ? Number(finding.payload.suggested ?? 0) : 0;
  const [value, setValue] = useState<string>(editable ? String(suggested) : "");
  const parsed = Number(value);
  const valueOk = Number.isFinite(parsed) && parsed > 0;
  const customized = editable && valueOk && parsed !== suggested;
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
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {editable ? (
          <label className="flex items-center gap-2 text-xs text-slate-400">
            $
            <input
              type="number"
              step="any"
              min="0"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-28 rounded border border-slate-700 bg-slate-950 p-1.5 text-sm text-slate-200"
              aria-label="Amount to set"
            />
          </label>
        ) : null}
        <button
          type="button"
          disabled={busy || (editable && !valueOk)}
          onClick={() => onConfirm(editable ? parsed : undefined)}
          className="cursor-pointer rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
        >
          {customized ? `Set it to ${parsed.toLocaleString()}` : c.confirmLabel}
        </button>
        {c.keepLabel ? (
          <button
            type="button"
            disabled={busy}
            onClick={onKeep}
            className="cursor-pointer rounded border border-emerald-700/60 px-4 py-1.5 text-xs font-medium text-emerald-300 hover:border-emerald-500 disabled:opacity-60"
          >
            {c.keepLabel}
          </button>
        ) : null}
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
  /** Middle option (removal cards): accept the conflict but pause the rule instead of deleting it. */
  keepLabel?: string;
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
      if (p.suggestion_type === "remove_rule") {
        return {
          title: `Remove "${String(p.rule_name)}"?`,
          body: `${String(p.rationale)} Removing deletes it and undoes its price changes; turning it off just pauses it, and you can re-enable it from your rules page anytime.`,
          confirmLabel: "Remove it",
          keepLabel: "Turn it off, keep it",
          dismissLabel: "Leave it running",
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
