/**
 * Client-side rate simulation engine.
 *
 * A TypeScript port of the Python legacy `simulate_rate_changes()` and
 * `_rule_matches()` functions.  Used by the /api/simulate endpoint.
 */

import type { RuleConfig, SimulationReservation, SimulationResult } from "@/types/domain";

/* ── Public ───────────────────────────────────────────────────── */

export function simulateRateChanges(
  rules: RuleConfig[],
  reservations: SimulationReservation[],
): SimulationResult[] {
  return reservations.map((res) => {
    let newRate = res.current_rate;
    const applied: string[] = [];

    for (const rule of rules) {
      if (ruleMatches(rule, res)) {
        if (rule.action.adjust_rate_percent !== undefined) {
          newRate *= 1 + rule.action.adjust_rate_percent / 100;
        }
        if (rule.action.adjust_rate_dollars !== undefined) {
          newRate += rule.action.adjust_rate_dollars;
        }
        applied.push(rule.rule_name);
      }
    }

    return {
      room_type: res.room_type,
      original_rate: res.current_rate,
      new_rate: Math.round(newRate * 100) / 100,
      applied_rules: applied.join(", "),
    };
  });
}

/* ── Condition matching ───────────────────────────────────────── */

function ruleMatches(rule: RuleConfig, res: SimulationReservation): boolean {
  // Room-type filter
  if (rule.room_types.length > 0 && !rule.room_types.includes(res.room_type)) {
    return false;
  }

  for (const [key, rawVal] of Object.entries(rule.conditions)) {
    const resVal = getResField(res, key);
    if (resVal === undefined) return false;

    const val = String(rawVal);
    if (val.startsWith(">")) {
      if (!(resVal > parseFloat(val.slice(1)))) return false;
    } else if (val.startsWith("<")) {
      if (!(resVal < parseFloat(val.slice(1)))) return false;
    } else if (val.startsWith("=")) {
      if (resVal !== parseFloat(val.slice(1))) return false;
    } else {
      if (resVal !== parseFloat(val)) return false;
    }
  }

  return true;
}

function getResField(res: SimulationReservation, key: string): number | undefined {
  const map: Record<string, number> = {
    occupancy_percentage: res.occupancy_percentage,
    booking_window: res.booking_window,
    pickup_rate: res.pickup_rate,
    current_rate: res.current_rate,
  };
  return map[key];
}
