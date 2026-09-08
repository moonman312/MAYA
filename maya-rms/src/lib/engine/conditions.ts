/**
 * Condition evaluation — Implementation Guide §6.
 *
 * Every non-null condition must be true (AND logic).
 * Operators are gt (strictly >) and lt (strictly <). Equality never matches.
 */

import { bookingSpeedRank, isBookingSpeed } from "@/lib/observations/booking-speed";
import type { EngineRule } from "@/types/domain";
import type { RuleMetrics } from "./types";

/**
 * Returns true iff all of the rule's non-null conditions are satisfied.
 */
export function ruleConditionsMatch(rule: EngineRule, metrics: RuleMetrics): boolean {
  const c = rule.condition;

  if (c.occupancy_operator) {
    if (metrics.occupancy === null) return false;
    if (!compare(metrics.occupancy, c.occupancy_operator, c.occupancy_threshold!)) return false;
  }

  if (c.dta_operator) {
    if (!compare(metrics.dta, c.dta_operator, c.dta_threshold_days!)) return false;
  }

  if (c.pickup_operator) {
    if (metrics.pickup_block_reason) return false;
    const pickupVal =
      c.pickup_metric === "revenue" ? metrics.net_pickup_revenue : metrics.net_pickup_units;
    if (pickupVal === null) return false;
    if (!compare(pickupVal, c.pickup_operator, c.pickup_threshold!)) return false;
  }

  if (c.booking_speed_operator) {
    // No usable history means "we don't know", never "condition met" — a
    // rule must not fire off an observation the engine couldn't make.
    if (metrics.booking_speed_block_reason) return false;
    const bs = metrics.booking_speed;
    if (!bs || !isBookingSpeed(c.booking_speed_level)) return false;
    const target = bookingSpeedRank(c.booking_speed_level);
    if (c.booking_speed_operator === "at_least" && bs.rank < target) return false;
    if (c.booking_speed_operator === "at_most" && bs.rank > target) return false;
    if (c.booking_speed_operator === "is" && bs.rank !== target) return false;
  }

  return true;
}

function compare(actual: number, op: string, threshold: number): boolean {
  if (op === "gt") return actual > threshold;
  if (op === "lt") return actual < threshold;
  return false;
}

/**
 * Count the number of non-null condition families on a rule.
 * Used for specificity tie-breaking in pickup competition.
 */
export function conditionCount(rule: EngineRule): number {
  let count = 0;
  if (rule.condition.occupancy_operator) count++;
  if (rule.condition.dta_operator) count++;
  if (rule.condition.pickup_operator) count++;
  if (rule.condition.booking_speed_operator) count++;
  return count;
}
