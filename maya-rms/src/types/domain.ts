/* ── Legacy types (kept for backward compatibility with demo/simulation) ── */

export type RuleConditionValue = string | number;

export type RuleAction = {
  adjust_rate_percent?: number;
  adjust_rate_dollars?: number;
};

export type RuleConfig = {
  id: string;
  rule_name: string;
  conditions: Record<string, RuleConditionValue>;
  action: RuleAction;
  room_types: string[];
  enabled: boolean;
};

/* ── Rules Engine v1 types (Implementation Guide aligned) ──────────── */

export type ActionKind = "percent" | "fixed";
export type ActionDirection = "increase" | "decrease";
export type ConditionOperator = "gt" | "lt";
export type PickupMetric = "room_nights" | "revenue";

export type RuleCondition = {
  occupancy_operator?: ConditionOperator | null;
  occupancy_threshold?: number | null;
  dta_operator?: ConditionOperator | null;
  dta_threshold_days?: number | null;
  pickup_operator?: ConditionOperator | null;
  pickup_threshold?: number | null;
  pickup_window_days?: 1 | 3 | 7 | null;
  pickup_metric?: PickupMetric | null;
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

export type StayDateSnapshot = {
  hotel_id: string;
  snapshot_ts: string;
  stay_date: string;
  room_type_id: string;
  sellable_units: number;
  booked_units: number;
  booked_revenue: number;
};

export type PublishedPrice = {
  hotel_id: string;
  stay_date: string;
  room_type_id: string;
  price: number;
  computed_at: string;
};

export type LadderRuleState = {
  rule_id: string;
  rule_version: number;
  stay_date: string;
  room_type_id: string;
  is_active: boolean;
  activated_at?: string | null;
  deactivated_at?: string | null;
  last_evaluated_at: string;
  action_kind: ActionKind;
  action_direction: ActionDirection;
  action_value: number;
};

export type LadderTransitionEvent = {
  id: string;
  hotel_id: string;
  rule_id: string;
  rule_version: number;
  stay_date: string;
  room_type_id: string;
  transition: "activate" | "deactivate";
  transitioned_at: string;
  metrics_snapshot: Record<string, unknown>;
  action_kind: ActionKind;
  action_direction: ActionDirection;
  action_value: number;
};

export type PickupEvent = {
  id: string;
  hotel_id: string;
  rule_id: string;
  rule_version: number;
  stay_date: string;
  affected_room_type_id: string;
  baseline_start_ts: string;
  baseline_end_ts: string;
  signal_booked_units_start: number;
  signal_booked_units_end: number;
  signal_booked_revenue_start: number;
  signal_booked_revenue_end: number;
  applied_at: string;
  retired_at?: string | null;
  action_kind: ActionKind;
  action_direction: ActionDirection;
  action_value: number;
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
};

export type EvaluationAudit = {
  id: string;
  evaluation_run_id: string;
  hotel_id: string;
  stay_date: string;
  room_type_id: string;
  evaluated_at: string;
  base_price: number;
  floor_price: number;
  ceiling_price: number;
  ladder_subtotal_delta: number;
  pickup_subtotal_delta: number;
  pre_clamp_price: number;
  final_price: number;
  details: EvaluationAuditDetails;
};

/* ── Calendar types ────────────────────────────────────────────────── */

export type CalendarRoomType = {
  /** Stable key for UI (UUID from DB or demo surrogate). */
  id: string;
  name: string;
  total_rooms: number;
  occupancy_pct: number;
  booked: number;
  rate: number;
  revenue: number;
};

export type CalendarDay = {
  occupancy_pct: number;
  booked: number;
  total: number;
  revenue: number;
  weekday: string;
  room_types: CalendarRoomType[];
};

export type CalendarResponse = {
  year: number;
  month: number;
  month_name: string;
  days_in_month: number;
  first_weekday: number;
  thresholds: { low: number; high: number };
  days: Record<string, CalendarDay>;
};

/* ── Simulation types ─────────────────────────────────────────────── */

export type SimulationReservation = {
  room_type: string;
  occupancy_percentage: number;
  booking_window: number;
  pickup_rate: number;
  current_rate: number;
};

export type SimulationResult = {
  room_type: string;
  original_rate: number;
  new_rate: number;
  applied_rules: string;
};

/* ── Changelog types ──────────────────────────────────────────────── */

export type ChangelogEntry = {
  room_type: string;
  rule_name: string;
  original_rate: number;
  new_rate: number;
  change_pct: number;
  occupancy_pct: number;
  description: string;
};

export type ChangelogCycle = {
  cycle: number;
  timestamp: string;
  has_changes: boolean;
  changes: ChangelogEntry[];
};
