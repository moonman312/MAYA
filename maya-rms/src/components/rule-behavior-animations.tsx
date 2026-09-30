"use client";

/**
 * "How rules behave": three short animations on the Rules tab, so an owner
 * can predict what a rule will do to a night's price. The story is the one
 * the engine tells (supabase/functions/_shared/engine, mirrored in
 * src/lib/engine):
 *
 *   1) A rule adjusts the price when its condition is met. If cancellations
 *      make the condition no longer true, the change comes off, unless the
 *      rule's box ("Undo the change if cancellations mean this rule is no
 *      longer true", ticked by default) is unticked (cancellationFinding in
 *      engine/pickup.ts). A rule that is still true after its wait can
 *      adjust again, and after an undo the wait still runs from the change
 *      that came off (waitAnchor).
 *   2) An occupancy rule has no wait: ticked, it comes off when cancellations
 *      take the night under its bar and goes back on as soon as the night is
 *      over it again (ladderConditionsHold in engine/conditions.ts).
 *   3) A stronger rule's change covers the weaker rules that move the price
 *      the same way: they count only the bookings made after it, and a
 *      weaker rule's change never restarts a stronger rule's count
 *      (countFromFireAt in engine/pickup.ts; Jake, 2026-09-24, option A).
 *
 * A box above the scenes flips scenes 1 and 2 between ticked and unticked.
 * Scene 3 has no cancellations, so the box changes nothing there.
 *
 * The scene numbers are data, exported so the tests can hold them to the
 * engine: rule-behavior-animations.test.tsx checks every level against
 * classifyBookingSpeed and every price against applyAdjustments, and
 * engine/rule-animation-scenes.test.ts plays each scene, ticked and
 * unticked, through whole engine runs on both engine copies and expects
 * the prices shown. Every booking in them is one room, so a count of
 * bookings is also a count of rooms and of room nights.
 *
 * No animation library: CSS transitions driven by a step index that a timer
 * advances. Reduced motion starts every scene paused and drops the
 * transitions; the step dots still walk through it.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { bookingSpeedLabel, bookingSpeedRank, type BookingSpeed } from "@/lib/observations/booking-speed";
import { RoomCountHelp } from "@/components/room-type-settings";
import { UNDO_ON_CANCELLATION_HELP, UNDO_ON_CANCELLATION_LABEL } from "@/lib/rule-form";

/* ── Scene data ───────────────────────────────────────────────────────── */

/** A booking speed reading as the rule judged it. */
export type SpeedReading = {
  /** What the count covers: "Past week", or what is left of the bookings a change counted. */
  over: string;
  /** Bookings counted. */
  booked: number;
  /** About how many a night like it usually gets over the same days. */
  usual: number;
  level: BookingSpeed;
};

/** One rule's line in the stronger-rule scene. */
export type RuleCount = {
  /** Bookings it counts now: since the newest raise still on the night by itself or a stronger rule. */
  counting: number;
  /** Raises of its own on the night. */
  raises: number;
};

export type SceneStep = {
  day: number;
  label: string;
  caption: string;
  /** The night's price after this step. */
  price: number;
  /** Each change on the price after this step, in the order they apply ("+10%"). */
  changes: string[];
  /** Rooms booked on the night (occupancy scene). */
  roomsBooked?: number;
  /** Bookings that came in since the step before. */
  newBookings?: number;
  /** Bookings that cancelled since the step before. */
  cancelled?: number;
  speed?: SpeedReading;
  /** Stronger-rule scene: the weaker and the stronger rule's counts. */
  weaker?: RuleCount;
  stronger?: RuleCount;
};

export type Scene = {
  id: "speed" | "occupancy" | "stronger";
  title: string;
  /** The rule, or rules, in plain words. */
  rules: string[];
  basePrice: number;
  /** Rooms the night has to sell (occupancy scene). */
  rooms?: number;
  /** The occupancy rule's bar, in percent. */
  occupancyThreshold?: number;
  /** The steps with the rule's box ticked, and unticked. The same when nothing cancels. */
  ticked: SceneStep[];
  unticked: SceneStep[];
};

/** Base price for scenes 1 and 2. */
export const BASE_PRICE = 200;

const SPEED_START: SceneStep[] = [
  {
    day: 1,
    label: "Normal pace",
    caption: "5 bookings came in over the past week, where about 5 is usual: Normal. No change.",
    price: 200,
    changes: [],
    speed: { over: "Past week", booked: 5, usual: 5, level: "normal" },
  },
  {
    day: 3,
    label: "The rule is true",
    caption:
      "4 more bookings make 9 in the past week, where about 5 is usual: Faster Than Normal. The rule raises 10%, to $220, then waits a week.",
    price: 220,
    changes: ["+10%"],
    newBookings: 4,
    speed: { over: "Past week", booked: 9, usual: 5, level: "faster" },
  },
];

export const SPEED_SCENE: Scene = {
  id: "speed",
  title: "A rule adjusts, and cancellations can undo it",
  rules: ["Booking speed at least Faster Than Normal over the past week: raise 10%, then wait 1 week"],
  basePrice: BASE_PRICE,
  ticked: [
    ...SPEED_START,
    {
      day: 5,
      label: "3 guests cancel",
      caption:
        "3 of the 9 bookings the raise counted cancel. The 6 left are about usual, so the rule is no longer true and its raise comes off.",
      price: 200,
      changes: [],
      cancelled: 3,
      speed: { over: "Left of the 9 it counted", booked: 6, usual: 5, level: "normal" },
    },
    {
      day: 10,
      label: "True again after the wait",
      caption:
        "The week's wait, counted from the raise that came off, is over. 9 new bookings this past week, where about 5 is usual: true again, so it raises 10%, to $220.",
      price: 220,
      changes: ["+10%"],
      newBookings: 9,
      speed: { over: "Past week", booked: 9, usual: 5, level: "faster" },
    },
  ],
  unticked: [
    ...SPEED_START,
    {
      day: 5,
      label: "3 guests cancel",
      caption:
        "3 of the 9 bookings the raise counted cancel. The 6 left are about usual, but the box is unticked, so the raise stays.",
      price: 220,
      changes: ["+10%"],
      cancelled: 3,
      speed: { over: "Left of the 9 it counted", booked: 6, usual: 5, level: "normal" },
    },
    {
      day: 10,
      label: "Still true after the wait",
      caption:
        "The week's wait is over. 9 new bookings this past week, where about 5 is usual: still true, so it raises another 10%, to $242.",
      price: 242,
      changes: ["+10%", "+10%"],
      newBookings: 9,
      speed: { over: "Past week", booked: 9, usual: 5, level: "faster" },
    },
  ],
};

const OCCUPANCY_START: SceneStep[] = [
  {
    day: 1,
    label: "Starting point",
    caption: "The night is 60% booked. The rule needs more than 70%.",
    price: 200,
    changes: [],
    roomsBooked: 12,
  },
  {
    day: 2,
    label: "The rule is true",
    caption: "3 bookings take it to 75%, over 70%. The rule raises 10%, to $220.",
    price: 220,
    changes: ["+10%"],
    roomsBooked: 15,
    newBookings: 3,
  },
];

export const OCCUPANCY_SCENE: Scene = {
  id: "occupancy",
  title: "An occupancy rule has no wait",
  rules: ["Sellable occupancy more than 70%: raise 10%"],
  basePrice: BASE_PRICE,
  rooms: 20,
  occupancyThreshold: 70,
  ticked: [
    ...OCCUPANCY_START,
    {
      day: 3,
      label: "2 guests cancel",
      caption: "Occupancy falls to 65%, so the rule is no longer true and its raise comes off.",
      price: 200,
      changes: [],
      roomsBooked: 13,
      cancelled: 2,
    },
    {
      day: 4,
      label: "True again",
      caption: "2 new bookings take it back to 75%. With no wait, the raise goes straight back on.",
      price: 220,
      changes: ["+10%"],
      roomsBooked: 15,
      newBookings: 2,
    },
  ],
  unticked: [
    ...OCCUPANCY_START,
    {
      day: 3,
      label: "2 guests cancel",
      caption: "Occupancy falls to 65%. The box is unticked, so the raise stays.",
      price: 220,
      changes: ["+10%"],
      roomsBooked: 13,
      cancelled: 2,
    },
    {
      day: 4,
      label: "Bookings come back",
      caption: "2 new bookings take it back to 75%. The rule keeps one raise while it is on, so nothing changes.",
      price: 220,
      changes: ["+10%"],
      roomsBooked: 15,
      newBookings: 2,
    },
  ],
};

const STRONGER_STEPS: SceneStep[] = [
  {
    day: 1,
    label: "10 book at once",
    caption:
      "Both rules are true. The stronger one raises 20%: $100 to $120. The weaker one doesn't add its 10% on the same bookings.",
    price: 120,
    changes: ["+20%"],
    newBookings: 10,
    weaker: { counting: 0, raises: 0 },
    stronger: { counting: 0, raises: 1 },
  },
  {
    day: 2,
    label: "3 more",
    caption: "Both rules count only bookings made since the 20% raise: 3 is not enough for either. $120.",
    price: 120,
    changes: ["+20%"],
    newBookings: 3,
    weaker: { counting: 3, raises: 0 },
    stronger: { counting: 3, raises: 1 },
  },
  {
    day: 3,
    label: "2 more",
    caption:
      "That makes 5 since the 20% raise, so the weaker rule raises 10% on top: $132. The stronger rule keeps counting from its own raise: a weaker rule's raise never restarts its count.",
    price: 132,
    changes: ["+20%", "+10%"],
    newBookings: 2,
    weaker: { counting: 0, raises: 1 },
    stronger: { counting: 5, raises: 1 },
  },
];

export const STRONGER_SCENE: Scene = {
  id: "stronger",
  title: "A stronger rule's change covers weaker ones",
  rules: [
    "Weaker: 5 or more bookings in a week: raise 10%",
    "Stronger: 10 or more bookings in a week: raise 20%",
  ],
  basePrice: 100,
  ticked: STRONGER_STEPS,
  unticked: STRONGER_STEPS,
};

export const SCENES: Scene[] = [SPEED_SCENE, OCCUPANCY_SCENE, STRONGER_SCENE];

export function sceneSteps(scene: Scene, undo: boolean): SceneStep[] {
  return undo ? scene.ticked : scene.unticked;
}

export function sceneOccupancy(scene: Scene, step: SceneStep): number | null {
  if (!scene.rooms || step.roomsBooked === undefined) return null;
  return Math.round((step.roomsBooked / scene.rooms) * 100);
}

/* ── Reduced motion ───────────────────────────────────────────────────── */

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ── Visual pieces ────────────────────────────────────────────────────── */

const TRANSITION = "transition-all duration-700 ease-out motion-reduce:transition-none";

/** A bar against a marker: occupancy against the rule's bar, or bookings against the usual count. */
function MeterBar({ fill, marker, on }: { fill: number; marker: number; on: boolean }) {
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-slate-800">
      <div
        className={`h-full rounded-full ${TRANSITION} ${on ? "bg-emerald-500" : "bg-sky-500"}`}
        style={{ width: `${Math.max(0, Math.min(100, fill))}%` }}
      />
      <div className="absolute top-0 h-full w-0.5 bg-amber-400" style={{ left: `${marker}%` }} aria-hidden />
    </div>
  );
}

function OccupancyPanel({ value, threshold }: { value: number; threshold: number }) {
  const over = value > threshold;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[0.6875rem] text-slate-400">
        <span>Sellable occupancy</span>
        <span className={`tabular-nums ${over ? "text-emerald-300" : "text-slate-200"}`}>{value}%</span>
      </div>
      <MeterBar fill={value} marker={threshold} on={over} />
      <div className="text-right text-[0.625rem] text-amber-300">needs more than {threshold}%</div>
    </div>
  );
}

function SpeedPanel({ speed }: { speed: SpeedReading }) {
  const fast = bookingSpeedRank(speed.level) >= 1;
  const scale = 12;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.6875rem] text-slate-400">
        <span>{speed.over}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ring-1 ${
            fast ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40" : "bg-slate-800 text-slate-300 ring-slate-700"
          }`}
        >
          {bookingSpeedLabel(speed.level)}
        </span>
      </div>
      <MeterBar fill={(speed.booked / scale) * 100} marker={(speed.usual / scale) * 100} on={fast} />
      <div className="flex items-center justify-between text-[0.625rem] tabular-nums">
        <span className="text-slate-200">
          {speed.booked} {speed.booked === 1 ? "booking" : "bookings"}
        </span>
        <span className="text-amber-300">usual about {speed.usual}</span>
      </div>
    </div>
  );
}

function RuleCountLine({ name, count, pct }: { name: string; count: RuleCount; pct: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 bg-slate-900 px-2.5 py-1.5">
      <span className="text-[0.6875rem] text-slate-300">
        {name} <span className="text-slate-500">({pct})</span>
      </span>
      <span className="flex items-center gap-2 text-[0.6875rem] tabular-nums">
        <span className="text-slate-400">counting {count.counting}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ring-1 ${
            count.raises > 0
              ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40"
              : "bg-slate-800 text-slate-400 ring-slate-700"
          }`}
        >
          {count.raises > 0 ? "raised" : "no raise"}
        </span>
      </span>
    </div>
  );
}

function PriceTag({ price, base, changes }: { price: number; base: number; changes: string[] }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[0.6875rem] uppercase tracking-wide text-slate-500">Price</span>
        <span className={`font-mono text-2xl font-semibold tabular-nums text-slate-100 ${TRANSITION}`}>
          ${Number.isInteger(price) ? price : price.toFixed(2)}
        </span>
      </div>
      <div className="flex min-h-5 flex-wrap items-center gap-1">
        {changes.length === 0 ? (
          <span className="text-[0.6875rem] text-slate-500">base price ${base}</span>
        ) : (
          changes.map((c, i) => (
            <span
              key={i}
              className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-emerald-300 ring-1 ring-emerald-500/30"
            >
              {c}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

/* ── Step timer with play and pause ───────────────────────────────────── */

function useAutoStep(stepCount: number, intervalMs: number) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep((s) => (s + 1) % stepCount), intervalMs);
    return () => clearInterval(id);
  }, [playing, stepCount, intervalMs]);

  return { step, setStep, playing, togglePlay: () => setPlaying((p) => !p) };
}

function StepControls({
  playing,
  onToggle,
  step,
  steps,
  onStepClick,
}: {
  playing: boolean;
  onToggle: () => void;
  step: number;
  steps: SceneStep[];
  onStepClick: (n: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="flex items-center gap-1.5">
        {steps.map((s, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Step ${i + 1} of ${steps.length}: ${s.label}`}
            aria-current={i === step ? "step" : undefined}
            className={`size-2.5 cursor-pointer rounded-full transition-colors motion-reduce:transition-none ${
              i === step ? "bg-sky-400" : "bg-slate-700 hover:bg-slate-600"
            }`}
            onClick={() => onStepClick(i)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="cursor-pointer rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[0.6875rem] text-slate-300 hover:border-slate-600 hover:text-slate-100"
        aria-label={playing ? "Pause animation" : "Play animation"}
      >
        {playing ? "Pause" : "Play"}
      </button>
    </div>
  );
}

/* ── One scene ────────────────────────────────────────────────────────── */

export function RuleScene({ scene, undo, intervalMs }: { scene: Scene; undo: boolean; intervalMs: number }) {
  const steps = sceneSteps(scene, undo);
  const { step, setStep, playing, togglePlay } = useAutoStep(steps.length, intervalMs);
  const titleId = useId();
  const s = steps[Math.min(step, steps.length - 1)];
  const occupancy = sceneOccupancy(scene, s);

  let measure: ReactNode = null;
  if (s.speed) measure = <SpeedPanel speed={s.speed} />;
  else if (occupancy !== null && scene.occupancyThreshold !== undefined) {
    measure = <OccupancyPanel value={occupancy} threshold={scene.occupancyThreshold} />;
  } else if (s.weaker && s.stronger) {
    measure = (
      <div className="space-y-1.5">
        <RuleCountLine name="Stronger" count={s.stronger} pct="+20%" />
        <RuleCountLine name="Weaker" count={s.weaker} pct="+10%" />
      </div>
    );
  }

  const events = [
    s.newBookings ? `${s.newBookings} new ${s.newBookings === 1 ? "booking" : "bookings"}` : null,
    s.cancelled ? `${s.cancelled} cancelled` : null,
  ].filter(Boolean);

  return (
    <div role="group" aria-labelledby={titleId} className="space-y-3 rounded-md border border-slate-800 bg-slate-950 p-3 sm:p-4">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h4 id={titleId} className="min-w-0 flex-1 text-sm font-semibold text-slate-100">
            {scene.title}
          </h4>
          <StepControls playing={playing} onToggle={togglePlay} step={step} steps={steps} onStepClick={setStep} />
        </div>
        {scene.rules.map((r) => (
          <p key={r} className="mt-0.5 text-[0.6875rem] text-slate-400">
            {r}
          </p>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div>{measure}</div>
        <PriceTag price={s.price} base={scene.basePrice} changes={s.changes} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-slate-800 bg-slate-900 px-3 py-2">
        <span className="text-xs font-medium text-slate-200">
          <span className="mr-1.5 text-slate-500">Day {s.day}</span>
          {s.label}
        </span>
        {events.length > 0 ? <span className="text-[0.6875rem] text-slate-400">{events.join(", ")}</span> : null}
      </div>

      <p
        key={`${undo}-${step}`}
        aria-live={playing ? "off" : "polite"}
        className="min-h-[2.5rem] text-[0.75rem] leading-relaxed text-slate-300"
      >
        {s.caption}
      </p>
    </div>
  );
}

/* ── Public wrapper: collapsible disclosure ───────────────────────────── */

export function RuleBehaviorAnimations() {
  // Starts closed on every mount, and that is the whole mechanism: the Rules
  // tab body is rendered as `{tab === "rules" && ...}` in dashboard.tsx, so
  // leaving the tab unmounts this and coming back remounts it collapsed.
  // Switching BROWSER tabs unmounts nothing, so it stays as the reader left it.
  const [open, setOpen] = useState(false);
  // Ticked, as every new rule starts.
  const [undo, setUndo] = useState(true);
  const panelId = useId();

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
        aria-controls={panelId}
      >
        <div>
          <div className="text-sm font-semibold text-slate-100">How rules behave</div>
          <div className="text-[0.6875rem] text-slate-400">When a rule changes a price, and when the change comes off.</div>
        </div>
        <span
          className={`text-slate-400 transition-transform duration-300 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open && (
        <div id={panelId} className="space-y-3 border-t border-slate-800 p-3 sm:p-4">
          <div className="flex items-start gap-2 rounded border border-slate-800 bg-slate-900 px-3 py-2">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 rounded border-slate-600"
                checked={undo}
                onChange={(e) => setUndo(e.target.checked)}
              />
              <span className="text-xs text-slate-400">
                Try the box: <span className="text-slate-200">{UNDO_ON_CANCELLATION_LABEL}</span>
              </span>
            </label>
            <RoomCountHelp {...UNDO_ON_CANCELLATION_HELP} />
          </div>
          <RuleScene scene={SPEED_SCENE} undo={undo} intervalMs={4200} />
          <RuleScene scene={OCCUPANCY_SCENE} undo={undo} intervalMs={3600} />
          <RuleScene scene={STRONGER_SCENE} undo={undo} intervalMs={4200} />
          <p className="text-[0.6875rem] leading-relaxed text-slate-400">
            The box works the same way on every rule, raise or cut, whatever it checks. Its &quot;?&quot; says what
            else takes a change off. Turning a rule off keeps its changes as they are.
          </p>
        </div>
      )}
    </section>
  );
}
