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
  /**
   * Days a fired event rule waits before it may fire again on the same night
   * and room type. Null reads as a week; anything under a day as a day.
   */
  booking_speed_cooldown_days?: number | null;
};

/** Which cancellation test can take a raise off. Cuts are always "none". */
export type PickupCancelCheck = "none" | "net_units" | "window_bookings" | "either";

/** Why a fire stopped applying. "legacy" and "self_cancelled" only mark rows from before stacking. */
export type PickupRetiredReason =
  | "night_passed"
  | "bookings_cancelled"
  | "manual_price"
  | "rule_edited"
  | "self_cancelled"
  | "legacy";

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
    /**
     * won: fired this run (event_id and fire_seq name the new fire).
     * lost_competition: another rule fired on the cell.
     * held_by_waiting_rule: a stronger rule that fired earlier is still
     * waiting and still matches, so nothing fired on the cell.
     * waiting: that stronger rule.
     * no_price_change: a cut already at the floor, or a raise already at the
     * ceiling, so it did not fire.
     * concurrent_fire: another run recorded the same fire first.
     * write_failed: the fire could not be written.
     * idempotency_skip: rows written before stacking only.
     */
    outcome:
      | "won"
      | "lost_competition"
      | "held_by_waiting_rule"
      | "waiting"
      | "no_price_change"
      | "concurrent_fire"
      | "write_failed"
      | "idempotency_skip";
    metrics: Record<string, unknown>;
    tie_break_trace: string[];
    event_id?: string;
    fire_seq?: number;
  }[];
  active_ladder_effects: { rule_id: string; delta: string }[];
  /** applied_at and fire_seq are missing on rows written before stacking. */
  active_pickup_effects: { event_id: string; rule_id: string; delta: string; applied_at?: string; fire_seq?: number }[];
  /** Fires this run took off the cell, when any. */
  retired_pickup_effects?: {
    event_id: string;
    rule_id: string;
    delta: string;
    applied_at: string;
    fire_seq: number;
    reason: "bookings_cancelled" | "manual_price" | "rule_edited";
    cancel_check: PickupCancelCheck;
  }[];
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
  /** Which precedence slot supplied the base. Rows written before manual prices existed lack it. */
  base_source?: "manual" | "calendar" | "reservation" | "remembered";
  /**
   * Present only when base_source is "manual": who typed the price and when.
   * `source` "pms" (with no setter) is a price changed in the PMS on a night
   * MAYA had sent; rows typed in MAYA leave it out.
   */
  manual_override?: { set_by: string | null; set_at: string; source?: "pms"; pms_type?: string | null };
};
