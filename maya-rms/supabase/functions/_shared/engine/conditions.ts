/**
 * Condition evaluation — Implementation Guide §6.
 * Deno-portable copy of src/lib/engine/conditions.ts (import paths only differ).
 */

import { bookingSpeedRank, isBookingSpeed } from "../observations/booking-speed.ts";
import type { EngineRule } from "./domain.ts";
import type { RuleMetrics } from "./types.ts";

/** Returns true iff all of the rule's non-null conditions are satisfied. */
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

/**
 * Whether a rule that keeps its change while its conditions hold (a ladder
 * rule: only occupancy and days before arrival) keeps a change it already
 * has on a night. Ticked (undo_on_cancellation, the default) it keeps it
 * exactly while its conditions match, as it always has, so cancellations
 * that take occupancy under its bar switch it off. Unticked, cancellations
 * never take it off: an "occupancy more than" condition, which only
 * cancellations (or more rooms to sell) can bring down, stays met while the
 * change is on, and the rest is read as it is now, so a days-before-arrival
 * condition still runs out with time and new bookings still end an
 * "occupancy less than" rule. A night with nothing measured is not held.
 * Only for a change the rule's current version made: one from before an
 * edit is judged on every condition (evaluateLadderTriple in ladder.ts).
 */
export function ladderConditionsHold(rule: EngineRule, metrics: RuleMetrics): boolean {
  const c = rule.condition;
  if (rule.undo_on_cancellation === false && c.occupancy_operator === "gt" && metrics.occupancy !== null) {
    return ruleConditionsMatch(
      { ...rule, condition: { ...c, occupancy_operator: null, occupancy_threshold: null } },
      metrics,
    );
  }
  return ruleConditionsMatch(rule, metrics);
}

function compare(actual: number, op: string, threshold: number): boolean {
  if (op === "gt") return actual > threshold;
  if (op === "lt") return actual < threshold;
  return false;
}

/** Count the number of non-null condition families on a rule. */
export function conditionCount(rule: Pick<EngineRule, "condition">): number {
  let count = 0;
  if (rule.condition.occupancy_operator) count++;
  if (rule.condition.dta_operator) count++;
  if (rule.condition.pickup_operator) count++;
  if (rule.condition.booking_speed_operator) count++;
  return count;
}
