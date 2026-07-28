/**
 * Suggestion mode: what "Hold My Hand" becomes when the hotel already has
 * configuration someone owns.
 *
 * A re-run of the guided analysis must never overwrite existing rules or
 * guardrails — those encode a human's judgment, possibly tuned for reasons
 * the data can't see. Instead we compare what the data recommends against
 * what exists and emit per-item suggestions the user accepts or rejects.
 * Gaps get "add" suggestions; existing values only get "adjust" suggestions
 * when they drift far from what the history supports; values a human clearly
 * chose (non-default guardrails) are left alone entirely.
 */

import type { StarterRuleSpec } from "./generate-rules.ts";

export type ExistingRuleSummary = {
  id: string;
  name: string;
  is_active: boolean;
  is_pickup_rule: boolean;
  occupancy_operator: string | null;
  occupancy_threshold: number | null; // fraction
  pickup_operator: string | null;
  pickup_threshold: number | null;
};

export type RuleSuggestion =
  | {
      suggestion_type: "add_rule";
      spec: StarterRuleSpec;
      rationale: string;
    }
  | {
      suggestion_type: "adjust_rule";
      rule_id: string;
      rule_name: string;
      current_threshold: number; // occupancy fraction
      suggested_threshold: number;
      rationale: string;
    };

/** How far (in occupancy points) an existing threshold may drift before we say something. */
const ADJUST_TOLERANCE_PTS = 10;

export function computeRuleSuggestions(
  existing: ExistingRuleSummary[],
  dataSpecs: StarterRuleSpec[],
): RuleSuggestion[] {
  const out: RuleSuggestion[] = [];
  const active = existing.filter((r) => r.is_active);

  const occupancyRules = active.filter(
    (r) => !r.is_pickup_rule && r.occupancy_operator === "gt" && r.occupancy_threshold != null,
  );
  const hasPickupRule = active.some((r) => r.is_pickup_rule);

  for (const spec of dataSpecs) {
    if (spec.is_pickup_rule) {
      if (!hasPickupRule) {
        out.push({
          suggestion_type: "add_rule",
          spec,
          rationale:
            "You have no rule watching short-term pickup, so demand spikes " +
            "(events, groups, sudden buzz) pass by unpriced.",
        });
      }
      continue;
    }

    const specPct = Math.round((spec.condition.occupancy_threshold ?? 0) * 100);
    // Closest existing occupancy rule to this spec's threshold.
    let closest: ExistingRuleSummary | null = null;
    let closestGap = Infinity;
    for (const r of occupancyRules) {
      const gap = Math.abs(Math.round(r.occupancy_threshold! * 100) - specPct);
      if (gap < closestGap) {
        closest = r;
        closestGap = gap;
      }
    }

    if (!closest || closestGap > 25) {
      // Nothing covers this band of occupancy at all.
      out.push({
        suggestion_type: "add_rule",
        spec,
        rationale: `No existing rule reacts around the ${specPct}% occupancy mark your history points to.`,
      });
    } else if (closestGap > ADJUST_TOLERANCE_PTS) {
      const currentPct = Math.round(closest.occupancy_threshold! * 100);
      out.push({
        suggestion_type: "adjust_rule",
        rule_id: closest.id,
        rule_name: closest.name,
        current_threshold: closest.occupancy_threshold!,
        suggested_threshold: specPct / 100,
        rationale:
          `"${closest.name}" fires above ${currentPct}% occupancy, but your booking history ` +
          `suggests ${specPct}% is where nights actually become scarce.`,
      });
    }
    // Within tolerance: their rule already matches the data — say nothing.
  }

  return out;
}

export type GuardrailState = {
  room_type_id: string;
  name: string;
  floor_price: number;
  ceiling_price: number;
  /** p99 nightly rate — outlier-resistant. Never use the raw max here: a
   *  single fat-fingered rate would become the basis of the ceiling. */
  observed_p99_rate: number | null;
};

export type GuardrailSuggestion = {
  suggestion_type: "set_guardrail";
  room_type_id: string;
  room_type_name: string;
  field: "floor_price" | "ceiling_price";
  current: number;
  suggested: number;
  rationale: string;
};

// Schema defaults meaning "never set": floor 1.00, ceiling 99999.99.
const FLOOR_UNSET_MAX = 1.0;
const CEILING_UNSET_MIN = 99_000;

/**
 * Only fills gaps. A guardrail someone actually set — any non-default value —
 * is their call and never questioned here.
 */
export function computeGuardrailSuggestions(
  roomTypes: GuardrailState[],
  strategy: { floor: number | null; ceiling: number | null },
  /** Room types the same analysis flagged as probably-not-rooms — don't
   *  suggest guardrails for something we're also suggesting excluding. */
  suspectRoomTypeIds: ReadonlySet<string> = new Set(),
): GuardrailSuggestion[] {
  const out: GuardrailSuggestion[] = [];
  for (const rt of roomTypes) {
    if (suspectRoomTypeIds.has(rt.room_type_id)) continue;
    if (rt.floor_price <= FLOOR_UNSET_MAX && strategy.floor && strategy.floor > 0) {
      out.push({
        suggestion_type: "set_guardrail",
        room_type_id: rt.room_type_id,
        room_type_name: rt.name,
        field: "floor_price",
        current: rt.floor_price,
        suggested: strategy.floor,
        rationale: `"${rt.name}" has no price floor — nothing stops a rule from discounting it below what you'd ever accept.`,
      });
    }
    if (rt.ceiling_price >= CEILING_UNSET_MIN) {
      const target =
        strategy.ceiling && strategy.ceiling > (rt.observed_p99_rate ?? 0)
          ? strategy.ceiling
          : rt.observed_p99_rate
            ? Math.round((rt.observed_p99_rate * 1.5) / 10) * 10
            : null;
      if (target && target > 0) {
        out.push({
          suggestion_type: "set_guardrail",
          room_type_id: rt.room_type_id,
          room_type_name: rt.name,
          field: "ceiling_price",
          current: rt.ceiling_price,
          suggested: target,
          rationale: `"${rt.name}" has no ceiling — a runaway surge could price it absurdly and embarrass you on the OTAs.`,
        });
      }
    }
  }
  return out;
}
