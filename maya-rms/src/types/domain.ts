import type { CalendarDisplay } from "@/lib/calendar-display";

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
  /**
   * "Undo this change if cancellations mean the rule is no longer true".
   * Absent in demo data, which reads as ticked like every saved rule.
   */
  undo_on_cancellation?: boolean;
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
  /**
   * Days a pickup count rule waits on a night and room type before it may
   * fire again. Null waits its lookback window (pickup_window_days); anything
   * under a day reads as a day. Only set with a pickup condition.
   */
  pickup_cooldown_days?: number | null;
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

/**
 * What a fire's stored numbers are good for when cancellations are checked
 * (cancellationsUndo in engine/pickup.ts). "recount": every fire made since
 * 99_supabase_migration_undo_on_cancellation_v1.sql, raise or cut; all of its
 * numbers can be recounted. The rest mark fires from before it: a booking
 * speed window is recounted only on "window_bookings" and "either" (the ones
 * recorded in bookings), and "none" or "net_units" keep that part as it was.
 */
export type PickupCancelCheck = "none" | "net_units" | "window_bookings" | "either" | "recount";

/**
 * What the cancellation check found no longer true when it took a change
 * off (cancellationFinding in engine/pickup.ts), with the numbers it
 * judged, so the change log can say why:
 *
 * - occupancy: the night's sellable occupancy then (0 to 1), against the
 *   rule's bar;
 * - pickup: the pickup the change counted, less its bookings that
 *   cancelled, in room nights or revenue as the rule counts, against the
 *   rule's number;
 * - booking_speed: of the bookings the change counted in its window
 *   (null on a change from before that was stored), how many are still
 *   booked, against the usual frozen at the change, and the pace the rule
 *   needs (level, a BookingSpeed key; absent on rows written before it was
 *   kept).
 *
 * Found only when the rule is not true either counted the way it would
 * count once the change is off (cancellablePartsHold).
 */
export type CancellationFinding =
  | { part: "occupancy"; occupancy: number; threshold: number }
  | { part: "pickup"; net: number; threshold: number; metric: "room_nights" | "revenue" }
  | { part: "booking_speed"; left: number; counted: number | null; expected: number; level?: string };

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
  /**
   * The owner's "undo this change if cancellations mean the rule is no
   * longer true" box. Ticked (true) unless the rule says false; a rule read
   * before the column existed is ticked, as every rule was migrated.
   */
  undo_on_cancellation?: boolean;
  /**
   * When the owner last switched the rule on (or saved it) with "Skip price
   * adjustments": the Skip its holds belong to (the days the popup showed,
   * left as they are until the rule stops being true there and then becomes
   * true again; ladder_rule_state.skip_state and rule_skip_hold). Null (or
   * absent, before the column exists) when the last activation applied its
   * adjustments.
   */
  skip_at?: string | null;
  /**
   * How the rule ranked as each earlier version, for its changes of those
   * versions still on the price (pricing_rules.version_ranks, written by
   * save_rule when an edit moves the version on and the old version still
   * has changes on the price, held by a Skip or frozen on a rule that is
   * off): its priority, its amount and the parts of
   * its condition that rank it. Such a change ranks as its version did, so it keeps
   * covering the weaker rules it covered (pickup.ts rankedAsMade).
   */
  version_ranks?: VersionRanks | null;
};

/** pricing_rules.version_ranks: per earlier version, what ranked the rule then. */
export type VersionRanks = Record<
  string,
  {
    priority: number;
    /** The version's amount (the changes of that version carry it too, on pickup_event). Absent in older records. */
    action_type?: ActionKind;
    action_direction?: ActionDirection;
    action_value?: number;
    condition: Pick<
      RuleCondition,
      | "occupancy_operator"
      | "dta_operator"
      | "pickup_operator"
      | "pickup_threshold"
      | "pickup_metric"
      | "booking_speed_operator"
      | "booking_speed_level"
    >;
  }
>;

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
  /** When the numbers below were taken: the fire's own run, applied_at. */
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
  /**
   * For a rule with a pickup condition: room nights (and revenue) first seen
   * inside the count's window and still booked at the fire. Null on fires
   * from before 99_supabase_migration_undo_on_cancellation_v1.sql.
   */
  pickup_units_arrived_at_fire?: number | null;
  pickup_revenue_arrived_at_fire?: number | null;
  /** The booking speed window at the fire, in hotel dates, when the rule has a booking speed condition. */
  window_from?: string | null;
  window_to?: string | null;
  window_bookings_at_fire?: number | null;
  window_expected_at_fire?: number | null;
  /** The bookings counted in that window, by booking key: see PickupCandidate.window_booking_keys. */
  window_booking_keys?: string[] | null;
  /**
   * Set when a run found cancellations had taken this change's own count
   * short but bookings made since kept its rule true: that run's instant,
   * and the numbers its cancellation check recounts from then on, under the
   * names of the columns above (CheckedCount in engine/pickup.ts). Only that
   * check reads them; every rule still counts from applied_at.
   */
  checked_at?: string | null;
  checked_count?: Record<string, unknown> | null;
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
     * waiting and matches again, so nothing fired on the cell: for a rule
     * moving the price its way, on what it counts itself since the newest
     * change by itself or a stronger rule; for one moving it the other way,
     * over its whole window.
     * waiting: that stronger rule.
     * no_price_change: a cut already at the floor, or a raise already at the
     * ceiling, so it did not fire.
     * comp_night: a raise on a night given away at 0 (a manual price of 0),
     * which no rule may raise.
     * concurrent_fire: another run recorded the same fire first.
     * write_failed: the fire could not be written.
     * idempotency_skip: rows written before stacking only.
     *
     * A rule the owner stopped on that night (rule_repeat_alert_nights.choice
     * = stop) is not a candidate at all, so it appears nowhere in this list.
     */
    outcome:
      | "won"
      | "lost_competition"
      | "held_by_waiting_rule"
      | "waiting"
      | "no_price_change"
      | "comp_night"
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
    /** For bookings_cancelled, what cancellations made no longer true. Absent on rows from before it was kept. */
    finding?: CancellationFinding;
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
  /**
   * Which slot supplied the base: a typed price or the hotel's own rate. Rows
   * written before manual prices existed lack it; rows from before audit A6
   * (2026-09-29) may say "reservation" or "remembered", bases the engine no
   * longer prices on.
   */
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
  /** Average rate of the night's bookings (ADR). Null when nothing is booked. */
  rate: number | null;
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
  /**
   * True when the property system (Cloudbeds or ThinkReservations) has no
   * rate on record for this night and nobody has typed a price: MAYA does
   * not price the night or send to it until the system has a rate for it.
   * Absent otherwise, and on past nights, on Mews, and in demo mode.
   */
  no_rate_in_pms?: true;
  /**
   * True when the property system (Cloudbeds or ThinkReservations) no longer
   * has a rate for this night, after MAYA sent its price, and the property
   * keeps changes made there: MAYA does not price the night or send to it
   * until the system has a rate again, or someone types a price. Absent
   * otherwise, and on past nights.
   */
  rate_removed_in_pms?: true;
};

export type CalendarDay = {
  occupancy_pct: number;
  booked: number;
  total: number;
  revenue: number;
  weekday: string;
  room_types: CalendarRoomType[];
  /**
   * The RevPAR the day is coloured by: sellable_revpar, or 0 with no rooms
   * to sell. 2dp.
   */
  revpar: number;
  /**
   * Property-relative RevPAR bucket: the day's sellable RevPAR against the
   * same figure on the property's other nights. Past days are judged against
   * the hotel's historical terciles, future days against the on-the-books ones.
   * Always the standard colour (green strong, red weak): a property that
   * reversed its colours in Settings shows it through nightColor().
   */
  color: "green" | "orange" | "red";
  /**
   * Room revenue from the room types that count as rooms, divided by the
   * rooms booked in them, 2dp. Null when nothing is booked. Older servers omit it.
   */
  adr?: number | null;
  /**
   * That same room revenue divided by the rooms you can sell that night
   * (`total`), 2dp. Null when there are none to sell. Older servers omit it.
   */
  sellable_revpar?: number | null;
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
  /** Today on the property's calendar (YYYY-MM-DD). Older servers omit it. */
  today?: string;
  /** The property's currency code ("USD", "EUR"); null when it has none set. Older servers omit it. */
  currency?: string | null;
  /** What each day shows and how its colours read, as the property chose in Settings. Older servers omit it. */
  display?: CalendarDisplay;
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
  /** True when the audit row carries booking-speed observation snapshots — the "Show the numbers" expander only shows then. */
  has_booking_speed_details?: boolean;
};

export type ChangelogCycle = {
  cycle: number;
  timestamp: string;
  has_changes: boolean;
  /** The run's biggest changes, at most MAX_ENTRIES_PER_CYCLE. */
  changes: ChangelogEntry[];
  /** Every change the run made, when that is more than `changes` shows. */
  total_changes?: number;
  /** total_changes is a minimum: some nights were not checked. */
  total_is_minimum?: boolean;
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

/**
 * An owner's answer to a rule that kept adjusting the same nights, as one
 * change log item: which rule, which way they answered, and how many nights
 * it covered. One item per answer, however many nights it settled. "resume"
 * is the answer taken back again, which the rules table's "Let it run again"
 * does.
 */
export type ChangelogRuleAlertChoice = {
  kind: "rule_alert_choice";
  id: string;
  /** When they answered, or took the answer back. */
  timestamp: string;
  rule_name: string;
  choice: "keep_adjusting" | "stop" | "resume";
  nights: number;
  first_night: string;
  last_night: string;
  /** What the log says happened, in one sentence. */
  title: string;
  /** The answer was given by MAYA support (a platform admin), not by someone on the property. */
  by_support?: boolean;
};

/**
 * A change MAYA support made to the property in God Mode, as one change log
 * line: "Changed by MAYA support: <what changed>". One item per save: the
 * support_changes rows written together, with ", N days" when the save
 * covered nights (src/lib/changelog-support.ts).
 */
export type ChangelogSupportChange = {
  kind: "support_change";
  id: string;
  /** When the change was made. */
  timestamp: string;
  /** What changed, in one line. */
  summary: string;
};

/**
 * A rate changed in the property system on a night MAYA sent to, as the
 * change log shows it (pms_change_notices, src/lib/changelog-pms-changes.ts):
 *
 *   overwrite   the property's setting is "MAYA's price wins", and MAYA sent
 *               its price again over a rate changed or removed there. One
 *               item per night and room type.
 *   other_tool  the setting is "Keep the change as your price", and the
 *               changes look like another pricing tool at work. It carries a
 *               button that opens the setting.
 *   more        the overwrites past the ones the log lists, counted.
 */
export type ChangelogPmsChange = {
  kind: "pms_change";
  id: string;
  /** When the change was found. */
  timestamp: string;
  change: "overwrite" | "other_tool" | "more";
  /** The property system's name, e.g. "Cloudbeds". */
  pms: string;
  /** What the log says, in one or a few sentences. */
  title: string;
  stay_date?: string;
  room_type?: string;
  /** The rate the PMS had; null when it was removed. */
  pms_rate?: number | null;
  maya_price?: number;
  /** other_tool: rates changed in the last 7 days. more: overwrites not listed. */
  count?: number;
  /** other_tool: "MAYA's price wins" is on now, so there is nothing to open. */
  setting_on?: boolean;
};

/**
 * Pricing runs in a row that changed nothing, as one change log line: how
 * many, and when the first and last of them ran. Anything else the log shows
 * in that time (a change, a push problem ending, an owner's answer) splits
 * the stretch, so every line sits where it happened.
 */
export type ChangelogQuietChecks = {
  kind: "quiet_checks";
  id: string;
  /** The latest check in the stretch; where the line sits in the timeline. */
  timestamp: string;
  /** The earliest check in the stretch. */
  first_at: string;
  /** How many checks in a row found nothing to change. */
  checks: number;
  /**
   * The line under the oldest change shown, when the log stopped reading
   * there: these are the checks just before that change, and whatever came
   * before them is not in the log.
   */
  just_before?: boolean;
};

/**
 * The change log timeline, newest first: pricing runs that changed prices,
 * the quiet checks between them, push problems and the answers the owner gave
 * to a rule that kept adjusting.
 */
export type ChangelogItem =
  | ChangelogCycle
  | ChangelogQuietChecks
  | ChangelogPushProblem
  | ChangelogRuleAlertChoice
  | ChangelogSupportChange
  | ChangelogPmsChange;
