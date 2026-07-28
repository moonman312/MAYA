/**
 * Engine-facing domain types (Deno-portable copy).
 *
 * This is a SUBSET of `src/types/domain.ts` — only the types the evaluation
 * engine imports. Kept here so `_shared/engine/*` has no `@/` path-alias
 * dependency and can run inside a Supabase Edge Function (Deno).
 *
 * Keep these in sync with `src/types/domain.ts`. If you consolidate later
 * (make `src/types/domain.ts` re-export these), this file becomes the source
 * of truth for the engine-facing shapes.
 */

export type ActionKind = "percent" | "fixed";
export type ActionDirection = "increase" | "decrease";
export type ConditionOperator = "gt" | "lt";
export type PickupMetric = "room_nights" | "revenue";
/** Ordinal compare against the Booking Speed scale (see ../observations/booking-speed.ts). */
export type BookingSpeedRuleOperator = "at_least" | "at_most" | "is";
/** Trailing day / week / month windows for Booking Speed conditions. */
export type BookingSpeedWindowDays = 1 | 7 | 30;

export type RuleCondition = {
  occupancy_operator?: ConditionOperator | null;
  occupancy_threshold?: number | null;
  dta_operator?: ConditionOperator | null;
  dta_threshold_days?: number | null;
  pickup_operator?: ConditionOperator | null;
  pickup_threshold?: number | null;
  pickup_window_days?: 1 | 3 | 7 | null;
  pickup_metric?: PickupMetric | null;
  booking_speed_operator?: BookingSpeedRuleOperator | null;
  /** A BookingSpeed level key, e.g. "much_slower" — the Observation Engine's ordered vocabulary. */
  booking_speed_level?: string | null;
  booking_speed_window_days?: BookingSpeedWindowDays | null;
  /** Days a fired event-style rule waits before it may re-fire on the same stay date. */
  booking_speed_cooldown_days?: number | null;
};

export type EngineRule = {
  id: string;
  hotel_id: string;
  name: string;
  is_active: boolean;
  version: number;
  start_date?: string | null;
  end_date?: string | null;
  is_annual: boolean;
  dow_mask: number;
  action_type: ActionKind;
  action_direction: ActionDirection;
  action_value: number;
  priority: number;
  is_pickup_rule: boolean;
  condition: RuleCondition;
  signal_room_type_ids: string[];
  affected_room_type_ids: string[];
  created_at: string;
  updated_at: string;
};

export type EvaluationAuditDetails = {
  matched_ladder_rules: {
    rule_id: string;
    rule_version: number;
    transition: "activate" | "noop" | "deactivate";
    action: { kind: ActionKind; direction: ActionDirection; value: number };
    metrics: Record<string, unknown>;
  }[];
  pickup_candidates: {
    rule_id: string;
    outcome: "won" | "lost_competition" | "idempotency_skip";
    metrics: Record<string, unknown>;
    tie_break_trace: string[];
  }[];
  active_ladder_effects: { rule_id: string; delta: string }[];
  active_pickup_effects: { event_id: string; rule_id: string; delta: string }[];
  application_order: string[];
  pre_clamp_price: string;
  clamped_by: "ceiling" | "floor" | "none";
  /**
   * Booking Speed observations consulted for this (stay_date, room_type)
   * during the run — the full Layer 1 audit snapshot persisted AT
   * EVALUATION TIME so explanations replay what was actually known. One
   * entry per distinct window length consulted.
   */
  booking_speed_observations?: Record<string, unknown>[];
};
