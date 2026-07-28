/**
 * Pure helpers for the pricing rule form — maps UI state to RuleCondition,
 * legacy conditions (simulation / in-memory store), and API payloads.
 */

import { bookingSpeedRank, isBookingSpeed } from "@/lib/observations/booking-speed";
import type {
  BookingSpeedRuleOperator,
  BookingSpeedWindowDays,
  PickupMetric,
  RuleAction,
  RuleCondition,
  RuleConditionValue,
} from "@/types/domain";

const BOOKING_SPEED_WINDOWS: readonly number[] = [1, 7, 30];

export type ConditionMetric = "occupancy" | "booking_window" | "pickup" | "booking_speed";

export type ConditionFormRow = {
  id: string;
  metric: ConditionMetric;
  operator: "gt" | "lt";
  /** Occupancy: 0–100 (%). Booking window: days. Pickup: threshold count / amount. */
  value: string;
  pickup_window_days: 1 | 3 | 7;
  pickup_metric: PickupMetric;
  /** A BookingSpeed level key ("faster", "much_slower", ...). The compare
   *  operator is DERIVED from the level's side of Normal — see
   *  directionalBookingSpeedOperator — so the form never asks for it. */
  booking_speed_level: string;
  booking_speed_window_days: BookingSpeedWindowDays;
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
    booking_speed_level: partial?.booking_speed_level ?? "faster",
    booking_speed_window_days: partial?.booking_speed_window_days ?? 7,
  };
}

/**
 * The one sane compare for each speed level: picking a level below Normal
 * means "that slow or slower", above Normal means "that fast or faster",
 * Normal means exactly Normal. Owners phrase it this way naturally, so the
 * form derives the operator instead of asking.
 */
export function directionalBookingSpeedOperator(levelKey: string): BookingSpeedRuleOperator {
  if (!isBookingSpeed(levelKey)) return "is";
  const rank = bookingSpeedRank(levelKey);
  return rank < 0 ? "at_most" : rank > 0 ? "at_least" : "is";
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
  const hasBs =
    !!c.booking_speed_operator &&
    isBookingSpeed(c.booking_speed_level) &&
    c.booking_speed_window_days != null &&
    BOOKING_SPEED_WINDOWS.includes(c.booking_speed_window_days);
  return !hasOcc && !hasDta && !hasPu && !hasBs;
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
    } else if (row.metric === "booking_speed") {
      if (!isBookingSpeed(row.booking_speed_level)) continue;
      c.booking_speed_operator = directionalBookingSpeedOperator(row.booking_speed_level);
      c.booking_speed_level = row.booking_speed_level;
      c.booking_speed_window_days = row.booking_speed_window_days;
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
  if (
    c.booking_speed_operator &&
    isBookingSpeed(c.booking_speed_level) &&
    c.booking_speed_window_days != null &&
    BOOKING_SPEED_WINDOWS.includes(c.booking_speed_window_days)
  ) {
    row.booking_speed_operator = c.booking_speed_operator;
    row.booking_speed_level = c.booking_speed_level;
    row.booking_speed_window_days = c.booking_speed_window_days;
    if (
      c.booking_speed_cooldown_days != null &&
      Number.isFinite(c.booking_speed_cooldown_days) &&
      c.booking_speed_cooldown_days >= 0
    ) {
      row.booking_speed_cooldown_days = Math.round(c.booking_speed_cooldown_days);
    }
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

/** ">80" -> "above 80", "<7" -> "below 7" — hoteliers read words, not math. */
function wordify(value: RuleConditionValue, unit = ""): string {
  const s = String(value).trim();
  if (s.startsWith(">")) return `above ${s.slice(1).trim()}${unit}`;
  if (s.startsWith("<")) return `below ${s.slice(1).trim()}${unit}`;
  return `${s}${unit}`;
}

export function formatRuleConditionsDisplay(conditions: Record<string, RuleConditionValue>): string {
  const parts: string[] = [];
  const occ = conditions.occupancy_percentage;
  if (occ != null) parts.push(`Occupancy ${wordify(occ, "%")}`);
  const bw = conditions.booking_window;
  if (bw != null) parts.push(`Booking window ${wordify(bw, " days")}`);
  const pu = conditions.pickup_rate;
  if (pu != null) parts.push(`Pickup ${wordify(pu, " bookings")}`);
  for (const [k, v] of Object.entries(conditions)) {
    if (k === "occupancy_percentage" || k === "booking_window" || k === "pickup_rate") continue;
    parts.push(`${k.replace(/_/g, " ")} ${wordify(v)}`);
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
