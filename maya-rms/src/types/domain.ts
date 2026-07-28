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
/** Ordinal compare against the Booking Speed scale (see lib/observations/booking-speed). */
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
  /**
   * Booking Speed observations consulted for this (stay_date, room_type)
   * during the run — the full Layer 1 audit snapshot (recent/expected
   * counts, comparable dates with per-date pickup, selection assumptions,
   * classification) persisted AT EVALUATION TIME so explanations replay
   * what was actually known, not what is known later. One entry per
   * distinct window length consulted.
   */
  booking_speed_observations?: Record<string, unknown>[];
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
  /**
   * Engine-published price for this night (from `published_price`), i.e. the
   * current asking price after rules + floor/ceiling clamps. Null when no
   * evaluation has published a price for this (stay_date, room_type) — e.g.
   * before the first /api/evaluate run, past horizon, or in demo mode.
   * Distinct from `rate`, which is the backward-looking ADR of bookings.
   */
  current_price?: number | null;
  /**
   * Current asking price for this night: the `published_price` row for this
   * (stay_date, room_type) when one exists, else null. Demo mode fills it
   * from the generated demo rate so the day detail always has a price.
   */
  current_rate: number | null;
};

export type CalendarDay = {
  occupancy_pct: number;
  booked: number;
  total: number;
  revenue: number;
  weekday: string;
  room_types: CalendarRoomType[];
  /** Booked revenue / total property rooms for the day, 2dp; 0 when no rooms. */
  revpar: number;
  /**
   * Property-relative RevPAR bucket. Past days are judged against the
   * hotel's historical terciles, future days against the on-the-books ones.
   */
  color: "green" | "orange" | "red";
};

export type CalendarResponse = {
  year: number;
  month: number;
  month_name: string;
  days_in_month: number;
  first_weekday: number;
  /**
   * `low`/`high` are the legacy occupancy-percent cutoffs (kept for older
   * consumers). `basis`/`past`/`future` are the property-relative RevPAR
   * tercile cutoffs that back each day's `color`.
   */
  thresholds: {
    low: number;
    high: number;
    basis: "revpar";
    past: { p33: number; p67: number };
    future: { p33: number; p67: number };
  };
  /**
   * First and last month (YYYY-MM) with any reservation or published price
   * for the hotel; the demo window when no Supabase data backs the calendar.
   */
  range: { min: string; max: string };
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
  /** Stay night the change applies to (ISO date). Absent in legacy/demo shapes. */
  stay_date?: string;
  /** Sentence-per-step story of the change, from narrateChange. */
  narrative?: string[];
  /** Keys for fetching the drill-down (/api/explain). Absent in demo shapes. */
  evaluation_run_id?: string;
  room_type_id?: string;
  /** True when the audit row carries booking-speed observation snapshots — the "How did we know?" expander only shows then. */
  has_booking_speed_details?: boolean;
};

export type ChangelogCycle = {
  cycle: number;
  timestamp: string;
  has_changes: boolean;
  changes: ChangelogEntry[];
};
