"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ImportProgressBar,
  useOnboardingStatus,
} from "@/components/onboarding/import-progress";

/**
 * The optional strategy questions, one at a time, while the import runs in
 * the background. Every step is skippable — the whole point is zero homework.
 *
 * The floor question anchors from the bottom up: first the cost to turn a
 * room, then a ladder that walks UP from just above that cost. Asking
 * hoteliers to walk down from their ADR always lands too high.
 */

type StepId = "name" | "turn_cost" | "floor" | "ceiling" | "confidence" | "done";

const ORDER: StepId[] = ["name", "turn_cost", "floor", "ceiling", "confidence", "done"];

export function StrategyQuestions() {
  const router = useRouter();
  const status = useOnboardingStatus();
  const [step, setStep] = useState<StepId>("name");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Local answers
  const [propertyName, setPropertyName] = useState<string | null>(null);
  const [turnCost, setTurnCost] = useState<number | null>(null);

  const currency = status?.currency ?? "USD";
  const symbol = currency === "USD" ? "$" : `${currency} `;

  useEffect(() => {
    if (propertyName === null && status?.hotelName) setPropertyName(status.hotelName);
  }, [status?.hotelName, propertyName]);

  async function save(fields: Record<string, unknown>, nextStep: StepId) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Couldn't save that — try again.");
      }
      advance(nextStep);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that — try again.");
    } finally {
      setSaving(false);
    }
  }

  function advance(next: StepId) {
    if (next === "done") {
      // Mark questions complete; ignore failures (progress page reflects state).
      fetch("/api/onboarding/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      }).catch(() => {});
      router.push("/onboarding/progress");
      return;
    }
    setStep(next);
    setError(null);
  }

  function skip() {
    advance(ORDER[ORDER.indexOf(step) + 1]);
  }

  const stepIndex = ORDER.indexOf(step) + 1;

  return (
    <div className="flex flex-col gap-6 pt-6">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">
          A few quick questions · {stepIndex} of 5 · all optional
        </div>
        <button
          type="button"
          onClick={() => advance("done")}
          className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-300"
        >
          Skip the rest →
        </button>
      </div>

      {step === "name" ? (
        <QuestionCard
          title="Did we get your property's name right?"
          subtitle="We pulled this from your property system. Fix it if it's off — whatever you type wins."
        >
          <input
            type="text"
            value={propertyName ?? ""}
            onChange={(e) => setPropertyName(e.target.value)}
            placeholder={status?.hotelName ?? "Property name"}
            className="w-full rounded bg-slate-950 p-3 text-sm text-slate-100"
          />
          <StepActions
            saving={saving}
            onSkip={skip}
            onNext={() =>
              propertyName && propertyName.trim() !== status?.hotelName
                ? save({ propertyName }, "turn_cost")
                : advance("turn_cost")
            }
            nextLabel="Looks right"
          />
        </QuestionCard>
      ) : null}

      {step === "turn_cost" ? (
        <QuestionCard
          title="Ballpark: what does it cost you to turn over a room?"
          subtitle="Cleaning, laundry, utilities, supplies — just the cost of one night's stay, not a precise number."
        >
          <MoneyInput
            symbol={symbol}
            placeholder="e.g. 35"
            onCommit={(v) => {
              setTurnCost(v);
              save({ turnCost: v }, "floor");
            }}
            saving={saving}
            onSkip={skip}
          />
        </QuestionCard>
      ) : null}

      {step === "floor" ? (
        <FloorLadder
          symbol={symbol}
          turnCost={turnCost}
          saving={saving}
          onAnswer={(v) => save({ floor: v }, "ceiling")}
          onSkip={skip}
        />
      ) : null}

      {step === "ceiling" ? (
        <QuestionCard
          title="Now the fun one: Taylor Swift is playing next door."
          subtitle="Every room in town is gone. What's the most you'd charge for a night? (For reference, also think about the highest you've ever actually sold a room for.)"
        >
          <MoneyInput
            symbol={symbol}
            placeholder="e.g. 450"
            onCommit={(v) => save({ ceiling: v }, "confidence")}
            saving={saving}
            onSkip={skip}
          />
        </QuestionCard>
      ) : null}

      {step === "confidence" ? (
        <QuestionCard
          title="Last one: how should Maya think about your current pricing?"
          subtitle="There's no wrong answer — this just tunes how adventurous our suggestions are."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => save({ confidence: "automate_current" }, "done")}
              className="cursor-pointer rounded-lg border border-slate-700 bg-slate-950 p-4 text-left transition-colors hover:border-sky-500/60 disabled:opacity-60"
            >
              <div className="text-sm font-semibold text-slate-100">
                My pricing works — automate it
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                I mostly want Maya to do what I already do, without me having
                to touch it every day.
              </p>
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => save({ confidence: "find_upside" }, "done")}
              className="cursor-pointer rounded-lg border border-slate-700 bg-slate-950 p-4 text-left transition-colors hover:border-sky-500/60 disabled:opacity-60"
            >
              <div className="text-sm font-semibold text-slate-100">
                Find money I&apos;m leaving on the table
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                I suspect there&apos;s a better way to price — show me what the
                data says.
              </p>
            </button>
          </div>
          <StepActions saving={saving} onSkip={skip} />
        </QuestionCard>
      ) : null}

      {error ? (
        <p className="rounded border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {error}
        </p>
      ) : null}

      <ImportProgressBar status={status} />
    </div>
  );
}

/* ── Floor ladder ─────────────────────────────────────────────────────────── */

function ladderStart(turnCost: number | null): number {
  if (turnCost && turnCost > 0) return Math.ceil((turnCost * 1.2 + 5) / 5) * 5;
  return 40; // no cost given — start low anyway; the ladder walks up fast
}

function nextRung(v: number): number {
  return Math.ceil((v * 1.15 + 1) / 5) * 5;
}

function FloorLadder({
  symbol,
  turnCost,
  saving,
  onAnswer,
  onSkip,
}: {
  symbol: string;
  turnCost: number | null;
  saving: boolean;
  onAnswer: (v: number) => void;
  onSkip: () => void;
}) {
  const [offer, setOffer] = useState(() => ladderStart(turnCost));
  const [declines, setDeclines] = useState(0);
  const [typing, setTyping] = useState(false);

  if (typing) {
    return (
      <QuestionCard
        title="What's your true floor?"
        subtitle="The lowest nightly rate you'd genuinely accept before the wrong crowd starts showing up."
      >
        <MoneyInput
          symbol={symbol}
          placeholder="e.g. 79"
          onCommit={onAnswer}
          saving={saving}
          onSkip={onSkip}
        />
      </QuestionCard>
    );
  }

  return (
    <QuestionCard
      title="Picture a Tuesday in your slowest month. You're at 10% occupancy."
      subtitle={`Someone walks in off the street, cash in hand. Would you take ${symbol}${offer} for a room tonight? Don't think "is this a good rate" — think "would the guest paying this bother my other guests?"`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => onAnswer(offer)}
          className="cursor-pointer rounded bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
        >
          I&apos;d take {symbol}
          {offer}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setDeclines((d) => d + 1);
            setOffer(nextRung(offer));
          }}
          className="cursor-pointer rounded border border-slate-700 bg-slate-950 px-6 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-60"
        >
          Too low
        </button>
      </div>
      {declines >= 2 ? (
        <p className="text-xs text-slate-500">
          Remember — this is a night that would otherwise earn {symbol}0. Anything
          above your turn cost is profit.
        </p>
      ) : null}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => setTyping(true)}
          className="cursor-pointer text-xs text-sky-400 hover:text-sky-300"
        >
          I&apos;ll just type my floor
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="cursor-pointer text-xs text-slate-500 hover:text-slate-300"
        >
          Skip this question
        </button>
      </div>
    </QuestionCard>
  );
}

/* ── Small shared pieces ──────────────────────────────────────────────────── */

function QuestionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function MoneyInput({
  symbol,
  placeholder,
  onCommit,
  saving,
  onSkip,
}: {
  symbol: string;
  placeholder: string;
  onCommit: (v: number) => void;
  saving: boolean;
  onSkip: () => void;
}) {
  const [raw, setRaw] = useState("");
  const parsed = Number(raw);
  const valid = raw.trim() !== "" && Number.isFinite(parsed) && parsed > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-500">{symbol}</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) onCommit(parsed);
          }}
          placeholder={placeholder}
          className="w-40 rounded bg-slate-950 p-3 text-sm text-slate-100"
        />
      </div>
      <StepActions
        saving={saving}
        onSkip={onSkip}
        onNext={valid ? () => onCommit(parsed) : undefined}
      />
    </div>
  );
}

function StepActions({
  saving,
  onSkip,
  onNext,
  nextLabel = "Continue",
}: {
  saving: boolean;
  onSkip: () => void;
  onNext?: () => void;
  nextLabel?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      {onNext ? (
        <button
          type="button"
          disabled={saving || !onNext}
          onClick={onNext}
          className="cursor-pointer rounded bg-sky-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:opacity-60"
        >
          {saving ? "Saving…" : nextLabel}
        </button>
      ) : null}
      <button
        type="button"
        disabled={saving}
        onClick={onSkip}
        className="cursor-pointer text-xs text-slate-500 hover:text-slate-300"
      >
        Skip this question
      </button>
    </div>
  );
}
