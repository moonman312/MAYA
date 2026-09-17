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
  /** The room types the rule changes. Absent in demo data. */
  affected_room_type_ids?: string[];
  /** The room types its conditions measure. Absent in demo data. */
  signal_room_type_ids?: string[];
  /** signal_room_type_ids with their names, where the name is known. */
  signal_room_types?: { id: string; name: string }[];
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
  /** 1, 2, 3 ... per (rule, night, room type). */
  fire_seq: number;
  retired_reason?: PickupRetiredReason | null;
  cancel_check: PickupCancelCheck;
  /** The booking speed window at the fire, in hotel dates, when the rule has a booking speed condition. */
  window_from?: string | null;
  window_to?: string | null;
  window_bookings_at_fire?: number | null;
  window_expected_at_fire?: number | null;
  /** The measured room types at the fire (sorted ids, comma separated). */
  signal_set_key: string;
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
   * during the run — the full Layer 1 audit snapshot (recent/expected
   * counts, comparable dates with per-date pickup, selection assumptions,
   * classification) persisted AT EVALUATION TIME so explanations replay
   * what was actually known, not what is known later. One entry per
   * distinct window length consulted.
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
  /**
   * The base the engine priced this night from (`published_price.base_price`),
   * before rules and clamps. Null when nothing has been published or in demo.
   */
  base_price: number | null;
  /**
   * An open manual price for this (stay_date, room_type) — a person typed it
   * and it outranks every other base. Null when MAYA is pricing the night.
   * `source` "pms": the hotel changed the rate in its PMS (`pms_type`) on a
   * night MAYA had sent, and MAYA kept it; clearing works the same.
   */
  manual_price: { price: number; set_at: string; source?: "maya" | "pms"; pms_type?: string | null } | null;
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

/** Tries at a push problem that went the same way, condensed to one line. */
export type PushProblemRetries = {
  first_at: string;
  last_at: string;
  count: number;
  nights: number;
  room_types: number;
  outcome: "failed" | "rejected" | "skipped" | "unconfirmed" | "landed";
  /** Plain words for the outcome, e.g. "Cloudbeds refused them". */
  label: string;
  /** The PMS's own message, when it gave one. */
  detail: string | null;
};

/**
 * Rates that are not reaching the PMS, as one change log item: the root cause
 * in plain words, what it affects, and the tries behind it. Only incidents
 * that need the owner are ever sent (rate_push_incidents.customer_visible_at).
 */
export type ChangelogPushProblem = {
  kind: "push_problem";
  id: string;
  /** When it started. */
  timestamp: string;
  pms: string;
  cause: string;
  title: string;
  /** What the owner can do about it, when there is anything. */
  action: string | null;
  nights: number;
  room_types: string[];
  status: "ongoing" | "resolved";
  resolved_at: string | null;
  resolution: "landed" | "superseded" | "stopped" | null;
  attempts: number;
  /** The newest tries, condensed. */
  retries: PushProblemRetries[];
  /** Tries counted but not listed in `retries` (older than those read, or past the stored cap). */
  retries_not_kept: number;
};

/** The change log timeline, newest first: pricing runs and push problems. */
export type ChangelogItem = ChangelogCycle | ChangelogPushProblem;
