/**
 * Pure helpers for the pricing rule form — maps UI state to RuleCondition,
 * legacy conditions (simulation / in-memory store), and API payloads.
 */

import type {
  PickupMetric,
  RuleAction,
  RuleCondition,
  RuleConditionValue,
} from "@/types/domain";

export type ConditionMetric = "occupancy" | "booking_window" | "pickup";

export type ConditionFormRow = {
  id: string;
  metric: ConditionMetric;
  operator: "gt" | "lt";
  /** Occupancy: 0–100 (%). Booking window: days. Pickup: threshold count / amount. */
  value: string;
  pickup_window_days: 1 | 3 | 7;
  pickup_metric: PickupMetric;
};

const SYM: Record<"gt" | "lt", string> = { gt: ">", lt: "<" };

export function newConditionRow(
  metric: ConditionMetric,
  partial?: Partial<Omit<ConditionFormRow, "id" | "metric">>,
): ConditionFormRow {
  return {
    id: crypto.randomUUID(),
    metric,
    operator: partial?.operator ?? "gt",
    value: partial?.value ?? (metric === "occupancy" ? "80" : metric === "booking_window" ? "7" : "5"),
    pickup_window_days: partial?.pickup_window_days ?? 3,
    pickup_metric: partial?.pickup_metric ?? "room_nights",
  };
}

/** True when no usable condition family is set. */
export function isRuleConditionEmpty(c: RuleCondition | undefined | null): boolean {
  if (!c) return true;
  const hasOcc =
    !!c.occupancy_operator && c.occupancy_threshold != null && Number.isFinite(c.occupancy_threshold);
  const hasDta =
    !!c.dta_operator && c.dta_threshold_days != null && Number.isFinite(c.dta_threshold_days);
  const hasPu =
    !!c.pickup_operator &&
    c.pickup_threshold != null &&
    Number.isFinite(c.pickup_threshold) &&
    c.pickup_window_days != null &&
    !!c.pickup_metric;
  return !hasOcc && !hasDta && !hasPu;
}

export function conditionRowsToRuleCondition(rows: ConditionFormRow[]): RuleCondition {
  const c: RuleCondition = {};
  for (const row of rows) {
    if (row.metric === "occupancy") {
      const n = Number(row.value);
      if (!Number.isFinite(n)) continue;
      c.occupancy_operator = row.operator;
      c.occupancy_threshold = Math.min(100, Math.max(0, n)) / 100;
    } else if (row.metric === "booking_window") {
      const n = Number(row.value);
      if (!Number.isFinite(n)) continue;
      c.dta_operator = row.operator;
      c.dta_threshold_days = Math.max(0, Math.round(n));
    } else {
      const n = Number(row.value);
      if (!Number.isFinite(n)) continue;
      c.pickup_operator = row.operator;
      c.pickup_threshold = n;
      c.pickup_window_days = row.pickup_window_days;
      c.pickup_metric = row.pickup_metric;
    }
  }
  return c;
}

/** Strips incomplete families so DB rule_condition CHECK constraints pass. */
export function ruleConditionForInsert(c: RuleCondition): RuleCondition {
  const row: RuleCondition = {};
  if (
    c.occupancy_operator &&
    c.occupancy_threshold != null &&
    Number.isFinite(c.occupancy_threshold)
  ) {
    row.occupancy_operator = c.occupancy_operator;
    row.occupancy_threshold = c.occupancy_threshold;
  }
  if (
    c.dta_operator &&
    c.dta_threshold_days != null &&
    Number.isFinite(c.dta_threshold_days)
  ) {
    row.dta_operator = c.dta_operator;
    row.dta_threshold_days = c.dta_threshold_days;
  }
  if (
    c.pickup_operator &&
    c.pickup_threshold != null &&
    Number.isFinite(c.pickup_threshold) &&
    c.pickup_window_days != null &&
    c.pickup_metric
  ) {
    row.pickup_operator = c.pickup_operator;
    row.pickup_threshold = c.pickup_threshold;
    row.pickup_window_days = c.pickup_window_days;
    row.pickup_metric = c.pickup_metric;
  }
  return row;
}

/** Legacy map for simulateRateChanges + in-memory store + pricing_rule_conditions. */
export function ruleConditionToLegacyConditions(c: RuleCondition): Record<string, RuleConditionValue> {
  const out: Record<string, RuleConditionValue> = {};
  if (c.occupancy_operator && c.occupancy_threshold != null) {
    const pct = Math.round(c.occupancy_threshold * 10_000) / 100;
    out.occupancy_percentage = `${SYM[c.occupancy_operator]}${pct}`;
  }
  if (c.dta_operator && c.dta_threshold_days != null) {
    out.booking_window = `${SYM[c.dta_operator]}${c.dta_threshold_days}`;
  }
  if (c.pickup_operator && c.pickup_threshold != null) {
    out.pickup_rate = `${SYM[c.pickup_operator]}${c.pickup_threshold}`;
  }
  return out;
}

export function formatRuleConditionsDisplay(conditions: Record<string, RuleConditionValue>): string {
  const parts: string[] = [];
  const occ = conditions.occupancy_percentage;
  if (occ != null) parts.push(`Occupancy ${String(occ)}%`);
  const bw = conditions.booking_window;
  if (bw != null) parts.push(`Booking window ${String(bw)} d`);
  const pu = conditions.pickup_rate;
  if (pu != null) parts.push(`Pickup ${String(pu)}`);
  for (const [k, v] of Object.entries(conditions)) {
    if (k === "occupancy_percentage" || k === "booking_window" || k === "pickup_rate") continue;
    parts.push(`${k} ${String(v)}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}

export function isRuleActionEmpty(a: RuleAction | undefined | null): boolean {
  if (!a) return true;
  const hasPct =
    a.adjust_rate_percent !== undefined &&
    Number.isFinite(a.adjust_rate_percent);
  const hasDolR =
    a.adjust_rate_dollars !== undefined && Number.isFinite(a.adjust_rate_dollars);
  return !hasPct && !hasDolR;
}
