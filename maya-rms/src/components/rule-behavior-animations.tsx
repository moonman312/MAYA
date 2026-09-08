"use client";

/**
 * Educational animations for the rule creation page.
 *
 * Two scenes:
 *   1) RuleCancellationScene — a standard rule fires, then a cancellation
 *      drops occupancy below the threshold, and the price reverts. Mirrors
 *      the ladder transition logic in `src/lib/engine/ladder.ts`
 *      (activate / deactivate based on whether conditions currently match).
 *
 *   2) StandardVsPickupScene — same input data on Day 1, Day 2, Day 3:
 *      - Standard rule activates once on Day 1; subsequent days are no-ops
 *        because the rule is already active (ladder is state-based).
 *      - Pickup rule inserts a new `pickup_event` each day the pickup
 *        threshold is met against the rolling baseline. Effects compound
 *        in `loadActivePickupEffects` -> `applyAdjustments`.
 *
 * No external animation deps — uses CSS transitions on Tailwind utilities
 * driven by a step state advanced by `setInterval`.
 */

import { useEffect, useRef, useState } from "react";

/* ── Reusable visual primitives ───────────────────────────────────────── */

type RuleStatus = "inactive" | "active";

function StatusPill({ status, label }: { status: RuleStatus; label?: string }) {
  const isActive = status === "active";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-500 ${
        isActive
          ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40"
          : "bg-slate-700/40 text-slate-400 ring-1 ring-slate-700"
      }`}
    >
      <span
        className={`size-1.5 rounded-full transition-colors duration-500 ${
          isActive ? "bg-emerald-400" : "bg-slate-500"
        }`}
      />
      {label ?? (isActive ? "Rule active" : "Rule inactive")}
    </span>
  );
}

/**
 * Horizontal occupancy bar with a labeled threshold line.
 * `value` and `threshold` are both 0–100.
 */
function OccupancyBar({
  value,
  threshold,
  meetsThreshold,
}: {
  value: number;
  threshold: number;
  meetsThreshold: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>Occupancy</span>
        <span
          className={`tabular-nums transition-colors duration-500 ${
            meetsThreshold ? "text-emerald-300" : "text-slate-300"
          }`}
        >
          {value}%
        </span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-[width,background-color] duration-1000 ease-out ${
            meetsThreshold ? "bg-emerald-500" : "bg-sky-500"
          }`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
        {/* Threshold marker */}
        <div
          className="absolute top-0 h-full w-px bg-amber-400/80"
          style={{ left: `${threshold}%` }}
          aria-hidden
        />
      </div>
      <div className="flex items-center justify-end text-[10px] text-amber-400/90">
        <span style={{ marginRight: `${Math.max(0, 100 - threshold - 4)}%` }}>
          ↑ threshold {threshold}%
        </span>
      </div>
    </div>
  );
}

/**
 * Animated price tag. Re-renders smoothly when value changes via CSS.
 */
function PriceTag({
  base,
  current,
  baseline = base,
}: {
  base: number;
  current: number;
  baseline?: number;
}) {
  const delta = current - baseline;
  const pctDelta = baseline > 0 ? (delta / baseline) * 100 : 0;
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">
        Price
      </span>
      <span className="font-mono text-2xl font-semibold tabular-nums text-slate-100 transition-all duration-700">
        ${current.toFixed(0)}
      </span>
      {Math.abs(delta) > 0.5 ? (
        <span
          className={`text-xs font-medium tabular-nums transition-colors duration-500 ${
            delta > 0 ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          {delta > 0 ? "+" : ""}
          {pctDelta.toFixed(0)}% from base
        </span>
      ) : (
        <span className="text-xs text-slate-500">base rate</span>
      )}
    </div>
  );
}

/* ── Hook: step engine with play/pause ────────────────────────────────── */

function useAutoStep(stepCount: number, intervalMs: number) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing) {
      if (ref.current) clearInterval(ref.current);
      ref.current = null;
      return;
    }
    ref.current = setInterval(() => {
      setStep((s) => (s + 1) % stepCount);
    }, intervalMs);
    return () => {
      if (ref.current) clearInterval(ref.current);
    };
  }, [playing, stepCount, intervalMs]);

  return {
    step,
    setStep,
    playing,
    togglePlay: () => setPlaying((p) => !p),
    restart: () => setStep(0),
  };
}

/* ── Scene 1: Standard rule with cancellation ─────────────────────────── */

type CancellationScene = {
  occ: number;
  price: number;
  status: RuleStatus;
  bookings: number;
  label: string;
  caption: string;
};

const CANCELLATION_SCENES: CancellationScene[] = [
  {
    occ: 60,
    price: 200,
    status: "inactive",
    bookings: 60,
    label: "Starting point",
    caption: "Hotel is 60% booked. Threshold for the rule is 70%. Price is the base rate of $200.",
  },
  {
    occ: 75,
    price: 200,
    status: "inactive",
    bookings: 75,
    label: "More bookings arrive",
    caption: "Occupancy climbs to 75% — it just crossed the 70% threshold the rule is watching.",
  },
  {
    occ: 75,
    price: 220,
    status: "active",
    bookings: 75,
    label: "Rule activates",
    caption: "Conditions are now met, so the rule fires. The +10% adjustment is added to the price.",
  },
  {
    occ: 75,
    price: 220,
    status: "active",
    bookings: 75,
    label: "Steady state",
    caption: "Nothing changes. The rule stays active and the price stays at $220.",
  },
  {
    occ: 65,
    price: 220,
    status: "active",
    bookings: 65,
    label: "A guest cancels",
    caption: "Occupancy drops back to 65% — below the 70% threshold. But the rule is still active for one more moment.",
  },
  {
    occ: 65,
    price: 200,
    status: "inactive",
    bookings: 65,
    label: "Rule deactivates",
    caption: "Next evaluation: conditions no longer match. The rule turns off and the price reverts to $200.",
  },
];

function RuleCancellationScene() {
  const { step, setStep, playing, togglePlay } = useAutoStep(
    CANCELLATION_SCENES.length,
    2800,
  );
  const scene = CANCELLATION_SCENES[step];

  return (
    <div className="space-y-4 rounded-md border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-200">
            Standard rule: cancellation undoes the adjustment
          </h4>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Rule: <span className="text-slate-400">when occupancy &gt; 70%, raise price by 10%</span>
          </p>
        </div>
        <PlayPauseControls
          playing={playing}
          onToggle={togglePlay}
          step={step}
          total={CANCELLATION_SCENES.length}
          onStepClick={setStep}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <OccupancyBar
          value={scene.occ}
          threshold={70}
          meetsThreshold={scene.occ > 70}
        />
        <div className="hidden text-2xl text-slate-600 sm:block">→</div>
        <PriceTag base={200} current={scene.price} />
      </div>

      <div className="flex items-center gap-3 rounded border border-slate-800 bg-slate-900 px-3 py-2">
        <StatusPill status={scene.status} />
        <span className="text-xs font-medium text-slate-300">
          {scene.label}
        </span>
      </div>

      <p
        key={step}
        className="min-h-[2.5rem] text-[12px] leading-relaxed text-slate-400"
      >
        {scene.caption}
      </p>
    </div>
  );
}

/* ── Scene 2: Standard vs Pickup, day by day ──────────────────────────── */

/**
 * Each day shows the same input data (high occupancy + short booking window),
 * with both rule types evaluating side by side. The standard rule activates
 * on day 1 and is then a no-op. The pickup rule inserts a new event each
 * day, stacking the adjustment.
 */
type ComparisonDay = {
  day: number;
  label: string;
  occupancy: number;
  bookingWindow: number;
  pickup: number;
  /** What the standard rule does this day. */
  standard: {
    transition: "noop" | "activate" | "deactivate";
    priceBefore: number;
    priceAfter: number;
    note: string;
  };
  /** What the pickup rule does this day. */
  pickup_outcome: {
    fired: boolean;
    priceBefore: number;
    priceAfter: number;
    events: number;
    note: string;
  };
};

const COMPARISON_DAYS: ComparisonDay[] = [
  {
    day: 0,
    label: "Day 0 — Before",
    occupancy: 60,
    bookingWindow: 12,
    pickup: 1,
    standard: {
      transition: "noop",
      priceBefore: 200,
      priceAfter: 200,
      note: "Conditions not yet met. Rule is inactive.",
    },
    pickup_outcome: {
      fired: false,
      priceBefore: 200,
      priceAfter: 200,
      events: 0,
      note: "Pickup is only 1 booking in last 3 days — below threshold.",
    },
  },
  {
    day: 1,
    label: "Day 1 — Conditions met",
    occupancy: 85,
    bookingWindow: 6,
    pickup: 5,
    standard: {
      transition: "activate",
      priceBefore: 200,
      priceAfter: 220,
      note: "Conditions met for the first time. Rule activates and the +10% adjustment is applied.",
    },
    pickup_outcome: {
      fired: true,
      priceBefore: 200,
      priceAfter: 220,
      events: 1,
      note: "Pickup of 5 in last 3 days clears threshold of 4. New event recorded. Price +10%.",
    },
  },
  {
    day: 2,
    label: "Day 2 — Same conditions hold",
    occupancy: 85,
    bookingWindow: 6,
    pickup: 5,
    standard: {
      transition: "noop",
      priceBefore: 220,
      priceAfter: 220,
      note: "Conditions still match — but the rule is already active. No new transition, price unchanged.",
    },
    pickup_outcome: {
      fired: true,
      priceBefore: 220,
      priceAfter: 242,
      events: 2,
      note: "Baseline reset to yesterday's event. 5 more bookings in last 3 days clear threshold again. Another event stacks — price +10% on top of $220.",
    },
  },
  {
    day: 3,
    label: "Day 3 — Conditions still hold",
    occupancy: 85,
    bookingWindow: 6,
    pickup: 5,
    standard: {
      transition: "noop",
      priceBefore: 220,
      priceAfter: 220,
      note: "Still active, still no-op. The standard rule fires once and stays put until conditions break.",
    },
    pickup_outcome: {
      fired: true,
      priceBefore: 242,
      priceAfter: 266,
      events: 3,
      note: "Pickup keeps accumulating against the new baseline. Threshold clears a third time — a third event stacks. Price compounds.",
    },
  },
];

function ConditionChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="font-mono text-xs text-slate-200">{value}</div>
    </div>
  );
}

function StandardVsPickupScene() {
  const { step, setStep, playing, togglePlay } = useAutoStep(
    COMPARISON_DAYS.length,
    3400,
  );
  const day = COMPARISON_DAYS[step];

  return (
    <div className="space-y-4 rounded-md border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-200">
            Standard vs. Pickup: what happens day after day
          </h4>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Same input data on both sides — only the rule type differs.
          </p>
        </div>
        <PlayPauseControls
          playing={playing}
          onToggle={togglePlay}
          step={step}
          total={COMPARISON_DAYS.length}
          onStepClick={setStep}
        />
      </div>

      {/* Day label and shared input data */}
      <div className="space-y-2 rounded border border-slate-800 bg-slate-900 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-200">
            {day.label}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-slate-500">
            same data, both sides
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <ConditionChip
            label="Occupancy"
            value={`${day.occupancy}%`}
          />
          <ConditionChip
            label="Booking window"
            value={`${day.bookingWindow} days`}
          />
          <ConditionChip
            label="Pickup (last 3d)"
            value={`${day.pickup} bookings`}
          />
        </div>
      </div>

      {/* Side-by-side rule outcomes */}
      <div className="grid gap-3 md:grid-cols-2">
        {/* Standard rule */}
        <div className="space-y-2 rounded border border-slate-800 bg-slate-900 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">
              Standard rule
            </span>
            <span className="text-[10px] text-slate-500">
              occupancy &gt; 70% AND booking window &lt; 7d
            </span>
          </div>
          <PriceTag
            base={200}
            current={day.standard.priceAfter}
          />
          <TransitionBadge transition={day.standard.transition} />
          <p
            key={`std-${step}`}
            className="min-h-[2.5rem] text-[11px] leading-relaxed text-slate-400"
          >
            {day.standard.note}
          </p>
        </div>

        {/* Pickup rule */}
        <div className="space-y-2 rounded border border-slate-800 bg-slate-900 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">
              Pickup rule
            </span>
            <span className="text-[10px] text-slate-500">
              pickup &gt; 4 in last 3 days
            </span>
          </div>
          <PriceTag
            base={200}
            current={day.pickup_outcome.priceAfter}
          />
          <PickupEventsBadge count={day.pickup_outcome.events} />
          <p
            key={`pkp-${step}`}
            className="min-h-[2.5rem] text-[11px] leading-relaxed text-slate-400"
          >
            {day.pickup_outcome.note}
          </p>
        </div>
      </div>
    </div>
  );
}

function TransitionBadge({
  transition,
}: {
  transition: "noop" | "activate" | "deactivate";
}) {
  const map = {
    noop: {
      label: "No change",
      cls: "bg-slate-700/40 text-slate-400 ring-slate-700",
    },
    activate: {
      label: "Activated → +10%",
      cls: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/40",
    },
    deactivate: {
      label: "Deactivated → revert",
      cls: "bg-rose-500/20 text-rose-300 ring-rose-500/40",
    },
  } as const;
  const c = map[transition];
  return (
    <span
      className={`inline-flex w-fit rounded-full px-2.5 py-0.5 text-[10px] font-medium ring-1 transition-colors duration-500 ${c.cls}`}
    >
      {c.label}
    </span>
  );
}

function PickupEventsBadge({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">
        Pickup events
      </span>
      <div className="flex items-center gap-1">
        {[0, 1, 2, 3].map((i) => {
          const filled = i < count;
          return (
            <span
              key={i}
              className={`size-2.5 rounded-sm transition-colors duration-500 ${
                filled ? "bg-emerald-500" : "bg-slate-700"
              }`}
            />
          );
        })}
        <span className="ml-1 text-[11px] tabular-nums text-slate-400">
          {count} active
        </span>
      </div>
    </div>
  );
}

/* ── Shared controls ──────────────────────────────────────────────────── */

function PlayPauseControls({
  playing,
  onToggle,
  step,
  total,
  onStepClick,
}: {
  playing: boolean;
  onToggle: () => void;
  step: number;
  total: number;
  onStepClick: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        {Array.from({ length: total }, (_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Jump to step ${i + 1}`}
            className={`size-1.5 cursor-pointer rounded-full transition-colors ${
              i === step ? "bg-sky-400" : "bg-slate-700 hover:bg-slate-600"
            }`}
            onClick={() => onStepClick(i)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="cursor-pointer rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-300 hover:border-slate-600 hover:text-slate-100"
        aria-label={playing ? "Pause animation" : "Play animation"}
      >
        {playing ? "Pause" : "Play"}
      </button>
    </div>
  );
}

/* ── Public wrapper: collapsible disclosure ───────────────────────────── */

export function RuleBehaviorAnimations() {
  const [open, setOpen] = useState(true);

  return (
    <section className="rounded-lg border border-stone-300 bg-stone-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div>
          <div className="text-sm font-semibold text-stone-800">
            How rules behave
          </div>
          <div className="text-[11px] text-stone-500">
            Two short animations explaining standard rules vs. pickup rules.
          </div>
        </div>
        <span
          className={`text-stone-500 transition-transform duration-300 ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-stone-200 p-4">
          <RuleCancellationScene />
          <StandardVsPickupScene />
          <p className="text-[11px] leading-relaxed text-slate-500">
            <strong className="text-slate-400">Key takeaway:</strong> standard
            rules track the <em>current</em> state and undo themselves when
            conditions break. Pickup rules record each qualifying moment as a
            permanent event — they don&apos;t undo on a single cancellation,
            and they can fire again on later days if new pickup keeps
            accumulating.
          </p>
        </div>
      )}
    </section>
  );
}
