/**
 * Human-readable change log narration.
 *
 * The change log is where a hotelier audits what the automation did to their
 * money. They shouldn't need to decode `occ > 0.7 → +10%` — every change
 * reads as a sentence: "Occupancy (82%) was above 70%, so 'Busy-day bump'
 * raised the rate 10% from $200.00 to $220.00."
 *
 * House rules for the prose:
 *   - No math symbols. "above" / "below" / "more than" / "fewer than".
 *     ($ % and digits are fine — hoteliers read prices all day.)
 *   - Observed values appear when we have them, in parentheses; sentences
 *     still read correctly when a metric wasn't captured.
 *   - Chained rules replay in application order with running prices, using
 *     the same math as the engine (percent compounds, fixed adds).
 *   - Clamps get their own sentence — hitting a floor/ceiling is exactly the
 *     kind of thing an owner wants to notice.
 */

import type { RuleCondition } from "@/types/domain";

export type NarrativeMetrics = {
  /** Occupancy as a fraction (0.82) — matches the engine's RuleMetrics. */
  occupancy?: number | null;
  /** Days until arrival. */
  dta?: number | null;
  /** Net pickup units over the rule's window. */
  pickup_units?: number | null;
};

export type NarrativeApplication = {
  rule_name: string;
  condition: RuleCondition | null;
  action: {
    kind: "percent" | "fixed";
    direction: "increase" | "decrease";
    value: number;
  };
  metrics?: NarrativeMetrics | null;
  is_pickup: boolean;
};

export type NarrativeInput = {
  room_type: string;
  base_price: number;
  final_price: number;
  applications: NarrativeApplication[];
  floor_price?: number | null;
  ceiling_price?: number | null;
  clamped_by?: "floor" | "ceiling" | null;
  currencySymbol?: string;
};

function money(v: number, sym: string): string {
  return `${sym}${v.toFixed(2)}`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function dayWord(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

function bookingWord(n: number): string {
  return n === 1 ? "1 booking" : `${n} bookings`;
}

/**
 * "occupancy (82%) was above 70%" / "the stay was fewer than 7 days away
 * (3 days out)" / "pickup (9 bookings in the window) was more than 4" —
 * joined with "and" when a rule has several conditions.
 */
export function describeConditions(
  condition: RuleCondition | null,
  metrics?: NarrativeMetrics | null,
): string {
  if (!condition) return "its conditions were met";
  const parts: string[] = [];

  if (condition.occupancy_operator && condition.occupancy_threshold != null) {
    const dir = condition.occupancy_operator === "gt" ? "above" : "below";
    const observed =
      metrics?.occupancy != null ? ` (${pct(metrics.occupancy)})` : "";
    parts.push(`occupancy${observed} was ${dir} ${pct(condition.occupancy_threshold)}`);
  }

  if (condition.dta_operator && condition.dta_threshold_days != null) {
    const dir = condition.dta_operator === "gt" ? "more than" : "fewer than";
    const observed = metrics?.dta != null ? ` (${dayWord(metrics.dta)} out)` : "";
    parts.push(
      `the stay was ${dir} ${dayWord(condition.dta_threshold_days)} away${observed}`,
    );
  }

  if (condition.pickup_operator && condition.pickup_threshold != null) {
    const windowDays = condition.pickup_window_days ?? 3;
    const dir = condition.pickup_operator === "gt" ? "more than" : "fewer than";
    const observed =
      metrics?.pickup_units != null ? `${bookingWord(metrics.pickup_units)}` : "pickup";
    parts.push(
      `${observed} arrived in the last ${dayWord(windowDays)}, ${dir} the ${bookingWord(Number(condition.pickup_threshold))} trigger`,
    );
  }

  if (parts.length === 0) return "its conditions were met";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function describeAction(
  action: NarrativeApplication["action"],
  before: number,
  after: number,
  sym: string,
): string {
  const verb = action.direction === "increase" ? "raised" : "lowered";
  const amount =
    action.kind === "percent" ? `${action.value}%` : money(action.value, sym);
  return `${verb} the rate ${amount}, from ${money(before, sym)} to ${money(after, sym)}`;
}

/** Same math as the engine's applyAdjustments — percent compounds, fixed adds. */
export function applyStep(
  price: number,
  action: NarrativeApplication["action"],
): number {
  const sign = action.direction === "increase" ? 1 : -1;
  const next =
    action.kind === "fixed"
      ? price + sign * action.value
      : price * (1 + (sign * action.value) / 100);
  return Math.round(next * 100) / 100;
}

/**
 * Full story for one (room type, night): one sentence per applied rule with
 * running prices, plus a clamp sentence when a floor/ceiling intervened.
 */
export function narrateChange(input: NarrativeInput): string[] {
  const sym = input.currencySymbol ?? "$";
  const sentences: string[] = [];
  let running = input.base_price;

  input.applications.forEach((app, i) => {
    const before = running;
    running = applyStep(running, app.action);
    const conditions = describeConditions(app.condition, app.metrics);
    const action = describeAction(app.action, before, running, sym);
    const opener = i === 0 ? "" : "Then ";
    const kind = app.is_pickup ? "a demand surge triggered" : "";
    if (app.is_pickup) {
      sentences.push(
        `${opener}${kind} "${app.rule_name}": ${conditions}, which ${action}.`.replace(/^Then a/, "Then a"),
      );
    } else {
      sentences.push(`${opener}"${app.rule_name}" kicked in because ${conditions}, which ${action}.`);
    }
  });

  if (input.clamped_by === "ceiling" && input.ceiling_price != null) {
    sentences.push(
      `That landed above the ${money(input.ceiling_price, sym)} ceiling for ${input.room_type}, so the final rate was capped at ${money(input.final_price, sym)}.`,
    );
  } else if (input.clamped_by === "floor" && input.floor_price != null) {
    sentences.push(
      `That landed below the ${money(input.floor_price, sym)} floor for ${input.room_type}, so the final rate was held at ${money(input.final_price, sym)}.`,
    );
  }

  if (sentences.length === 0) {
    sentences.push(
      `The rate moved from ${money(input.base_price, sym)} to ${money(input.final_price, sym)}.`,
    );
  }

  return sentences;
}

/** One-line headline for the entry: room, movement, direction. */
export function narrateHeadline(input: NarrativeInput): string {
  const sym = input.currencySymbol ?? "$";
  const delta = input.final_price - input.base_price;
  const arrow = delta >= 0 ? "up" : "down";
  const pctMove =
    input.base_price > 0
      ? `${Math.abs(Math.round((delta / input.base_price) * 1000) / 10)}%`
      : "";
  return `${input.room_type}: ${money(input.base_price, sym)} ${arrow} to ${money(input.final_price, sym)}${pctMove ? ` (${delta >= 0 ? "+" : "-"}${pctMove})` : ""}`;
}
