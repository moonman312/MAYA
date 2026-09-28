/**
 * What a link fills into the rule builder and the Rate Simulator's test rule.
 * Pure: the landing page passes these to the forms' own setters and saves
 * nothing. Condition keys map onto ConditionFormRow through the registry's
 * `row` and `field`, so a new condition field is one registry entry.
 */

import { newConditionRow, type ConditionFormRow, type ConditionMetric } from "@/lib/rule-form";
import { registry } from "./index";

const ROW_ORDER: ConditionMetric[] = ["occupancy", "booking_speed", "booking_window", "pickup"];

/** Condition rows in the builder's own order, or null when the link names none. */
export function conditionRowsFromFill(params: Record<string, string>, only?: readonly string[]): ConditionFormRow[] | null {
  const partials = new Map<ConditionMetric, Record<string, unknown>>();
  for (const [key, value] of Object.entries(params)) {
    if (only && !only.includes(key)) continue;
    const spec = registry.params[key];
    if (!spec?.row) continue;
    const metric = spec.row as ConditionMetric;
    const partial = partials.get(metric) ?? {};
    if (spec.field) {
      partial[spec.field] = spec.field.endsWith("_days") ? Number(value) : value;
    } else {
      // gt85 / lt3: the compare and the threshold
      partial.operator = value.slice(0, 2);
      partial.value = value.slice(2);
    }
    partials.set(metric, partial);
  }
  if (partials.size === 0) return null;
  return ROW_ORDER.filter((m) => partials.has(m)).map((m) =>
    newConditionRow(m, partials.get(m) as Partial<Omit<ConditionFormRow, "id" | "metric">>),
  );
}

export type BuilderFill = {
  name?: string;
  rows?: ConditionFormRow[];
  direction?: "increase" | "decrease";
  /** One amount at most: the builder leaves the other box empty. */
  percent?: string;
  dollars?: string;
  split?: boolean;
};

/** The rule builder's fill. Anything the link leaves out keeps the builder's own default. */
export function builderFill(params: Record<string, string>): BuilderFill {
  const fill: BuilderFill = {};
  if (params.name) fill.name = params.name;
  const rows = conditionRowsFromFill(params);
  if (rows) fill.rows = rows;
  if (params.direction === "increase" || params.direction === "decrease") fill.direction = params.direction;
  if (params.percent) fill.percent = params.percent;
  else if (params.amount) fill.dollars = params.amount;
  if (params.split === "1") fill.split = true;
  return fill;
}

export type TestRuleFill = {
  name?: string;
  rows?: ConditionFormRow[];
  direction?: "increase" | "decrease";
  kind?: "percent" | "fixed";
  amount?: string;
  stayIn?: number;
  /** "" is the form's "Not enough history". */
  nightSpeed?: string;
};

/**
 * The test rule's fill. That form has no "Measured over", wait or lookback,
 * so only the level or the compare and threshold of each condition come across.
 */
export function testRuleFill(params: Record<string, string>): TestRuleFill {
  const fill: TestRuleFill = {};
  if (params.name) fill.name = params.name;
  const rows = conditionRowsFromFill(params, ["occupancy", "speed", "window", "pickup"]);
  if (rows) fill.rows = rows;
  if (params.direction === "increase" || params.direction === "decrease") fill.direction = params.direction;
  if (params.percent) {
    fill.kind = "percent";
    fill.amount = params.percent;
  } else if (params.amount) {
    fill.kind = "fixed";
    fill.amount = params.amount;
  }
  if (params.stay_in !== undefined) fill.stayIn = Number(params.stay_in);
  if (params.night_speed) fill.nightSpeed = params.night_speed === "none" ? "" : params.night_speed;
  return fill;
}
