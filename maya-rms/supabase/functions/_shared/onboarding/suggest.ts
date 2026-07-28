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
  /** True when the rule carries a booking-speed condition. */
  has_booking_speed: boolean;
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
  paceSpecs: StarterRuleSpec[],
  occupancyRef: { surgePct: number; peakPct: number } | null,
): RuleSuggestion[] {
  const out: RuleSuggestion[] = [];
  const active = existing.filter((r) => r.is_active);

  // The pace ladder is all-or-nothing: a hotel with ANY booking-speed rule
  // has a pace setup someone owns, and second-guessing their chosen levels
  // would be exactly the overreach suggestion mode exists to avoid. A hotel
  // with none gets the whole ladder offered, one accept/reject each.
  const hasBookingSpeedRule = active.some((r) => r.has_booking_speed);
  if (!hasBookingSpeedRule) {
    for (const spec of paceSpecs) {
      const rationale =
        spec.action.action_direction === "decrease"
          ? "Nothing watches for dates falling behind their normal booking pace — slow nights sit at full price until it is too late to rescue them."
          : "Nothing watches for dates booking ahead of their normal pace — demand spikes pass by unpriced.";
      out.push({ suggestion_type: "add_rule", spec, rationale });
    }
  }

  // Existing occupancy rules get a sanity check against the marks the
  // history actually supports. Adjust-only: new-rule suggestions are pace
  // rules now, so nothing here proposes fresh occupancy rules.
  if (occupancyRef) {
    const occupancyRules = active.filter(
      (r) => !r.is_pickup_rule && r.occupancy_operator === "gt" && r.occupancy_threshold != null,
    );
    for (const r of occupancyRules) {
      const currentPct = Math.round(r.occupancy_threshold! * 100);
      const nearestMark =
        Math.abs(currentPct - occupancyRef.surgePct) <= Math.abs(currentPct - occupancyRef.peakPct)
          ? occupancyRef.surgePct
          : occupancyRef.peakPct;
      if (Math.abs(currentPct - nearestMark) > ADJUST_TOLERANCE_PTS) {
        out.push({
          suggestion_type: "adjust_rule",
          rule_id: r.id,
          rule_name: r.name,
          current_threshold: r.occupancy_threshold!,
          suggested_threshold: nearestMark / 100,
          rationale:
            `"${r.name}" fires above ${currentPct}% occupancy, but your booking history ` +
            `suggests ${nearestMark}% is where nights actually become scarce.`,
        });
      }
    }
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

/* ── Initial (first-run) guardrails ──────────────────────────── */

export type InitialGuardrailInput = GuardrailState & {
  /** Median nightly rate — the anchor for a data-derived floor. */
  observed_median_rate: number | null;
  row_count: number;
};

export type InitialGuardrail = {
  room_type_id: string;
  field: "floor_price" | "ceiling_price";
  value: number;
};

/**
 * A floor well below normal discounting range still blocks a fat-fingered
 * $10 rate; 40% of the median is comfortably under any sane promotion.
 */
export const DATA_FLOOR_FRACTION_OF_MEDIAN = 0.4;
export const MIN_DATA_FLOOR = 10;
export const MIN_ROWS_FOR_DATA_GUARDRAILS = 30;

/**
 * First-run gap-filling: data-derived floors and ceilings for room types
 * still at schema defaults AFTER the strategy answers were projected.
 * Room types whose guardrails were set by a human (or by strategy answers)
 * are untouched; suspect room types are skipped — no point fitting
 * guardrails to something the same analysis says is probably not a room.
 * Ceilings use p99 x 1.5, never the raw max, so one typo'd rate can't
 * become the basis of the cap.
 */
export function computeInitialGuardrails(
  roomTypes: InitialGuardrailInput[],
  suspectRoomTypeIds: ReadonlySet<string> = new Set(),
): InitialGuardrail[] {
  const out: InitialGuardrail[] = [];
  for (const rt of roomTypes) {
    if (suspectRoomTypeIds.has(rt.room_type_id)) continue;
    if (rt.row_count < MIN_ROWS_FOR_DATA_GUARDRAILS) continue;

    // Ceiling first so the floor below can respect it.
    let newCeiling: number | null = null;
    if (rt.ceiling_price >= CEILING_UNSET_MIN && rt.observed_p99_rate && rt.observed_p99_rate > 0) {
      newCeiling = Math.round((rt.observed_p99_rate * 1.5) / 10) * 10;
      if (newCeiling > 0) {
        out.push({ room_type_id: rt.room_type_id, field: "ceiling_price", value: newCeiling });
      }
    }

    if (rt.floor_price <= FLOOR_UNSET_MAX && rt.observed_median_rate && rt.observed_median_rate > 0) {
      const floor = Math.max(
        MIN_DATA_FLOOR,
        Math.round((rt.observed_median_rate * DATA_FLOOR_FRACTION_OF_MEDIAN) / 5) * 5,
      );
      const effectiveCeiling =
        newCeiling ?? (rt.ceiling_price < CEILING_UNSET_MIN ? rt.ceiling_price : null);
      if (effectiveCeiling === null || floor < effectiveCeiling) {
        out.push({ room_type_id: rt.room_type_id, field: "floor_price", value: floor });
      }
    }
  }
  return out;
}
