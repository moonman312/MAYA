/**
 * Internal engine types used across the evaluation pipeline.
 * Deno-portable copy of src/lib/engine/types.ts (import paths only differ).
 */

import type { ActionDirection, ActionKind, EngineRule, PickupCancelCheck } from "./domain.ts";

export type RuleMetrics = {
  /**
   * Sellable occupancy over the rule's signal set: booked units over
   * total_rooms minus out-of-service units, counting only room types that
   * count as rooms. Not the PMS headline number, which keeps blocked rooms
   * and courts in the denominator.
   */
  occupancy: number | null;
  dta: number;
  net_pickup_units: number | null;
  net_pickup_revenue: number | null;
  /** §8.1 / §16.3 — when set, pickup must not match (audit / debug). */
  pickup_block_reason?:
    | "insufficient_snapshot_history"
    | "stale_baseline_snapshot"
    | "no_active_signal_room_types"
    | null;
  /** Booking Speed classification for this stay date over the rule's window (Layer 1 observation). */
  booking_speed?: {
    speed: string;
    rank: number;
    label: string;
    recent: number;
    /**
     * What a night like it usually gets: over window_days, or with
     * expected_over_full_window over the rule's whole window
     * (full_window_days).
     */
    expected: number;
    /** The days actually counted: the rule's window, or fewer when counted_from cut it. */
    window_days: number;
    method: string;
    /**
     * Set only when the fire the rule counts from on the cell cut its window
     * short or split its first day (countFromFireAt and
     * bookingSpeedCountFrom in pickup.ts: its own newest fire there, or a
     * newer one by a stronger rule that adjusts the same way). The first
     * booking date counted, the window the rule asks for, and
     * (counted_since, a raise rule only) that fire, when the first day
     * counted only the bookings first seen after it. A cut rule counts from
     * the day after the cut. An audit row without counted_since counted
     * counted_from's day whole.
     */
    counted_from?: string;
    full_window_days?: number;
    counted_since?: string;
    /**
     * With counted_from, for a rule that raises on "at least" a pace
     * (keepsWholeWindowBar): `expected` is over the rule's whole window, the
     * bar the bookings since that change had to beat on their own.
     */
    expected_over_full_window?: true;
    /**
     * Set for a rule that cuts: the last booking date counted, the day
     * before the run's. It reads complete days only, on the night and on the
     * nights it is compared with. Absent for a raise rule, which counts
     * today so far.
     */
    counted_through?: string;
  } | null;
  /**
   * When set, booking-speed conditions must not match: no usable history, or
   * no complete day left to count since the fire the rule counts from on
   * the cell (a cut rule the day after that cut, or a fire recorded by a run
   * whose clock was ahead).
   */
  booking_speed_block_reason?: "insufficient_data" | "since_last_fire" | null;
  /**
   * Set when a pickup condition's window opened at the fire the rule counts
   * from rather than a whole window back (pickupWindowOpensAt in pickup.ts:
   * its own last fire, inside a window longer than its wait, or a stronger
   * rule's newer fire that adjusts the same way): that fire's instant. The
   * net pickup above counts only what came after it.
   */
  pickup_counted_since?: string;
  /** Summed across signal room types at baseline snapshot (pickup ledger / audit). */
  signal_booked_units_baseline?: number;
  signal_booked_revenue_baseline?: number;
  /** Summed across signal room types at current snapshot. */
  signal_booked_units_now?: number;
  signal_booked_revenue_now?: number;
  /**
   * Names of active room types the rule lists as signals but which do not
   * count as rooms (counts_as_room = false), so they were left out of the
   * occupancy above. Present only when something was dropped.
   */
  excluded_from_occupancy?: string[];
};

export type AdjustmentSpec = {
  rule_id: string;
  action_kind: ActionKind;
  action_direction: ActionDirection;
  action_value: number;
};

export type PickupCandidate = {
  rule: EngineRule;
  metrics: RuleMetrics;
  /** Stay night being evaluated (§3.9, §7.3) — never the run timestamp. */
  stay_date: string;
  baseline_ts: string;
  affected_room_type_id: string;
  eval_ts: string;
  /**
   * Booked room-nights (and revenue) over the measured room types when the
   * pickup window opened, and now. A rule with no pickup condition measures
   * no window, so both are now.
   */
  signal_booked_units_start: number;
  signal_booked_units_end: number;
  signal_booked_revenue_start: number;
  signal_booked_revenue_end: number;
  /** One above the highest fire number this rule ever had on the cell. */
  fire_seq: number;
  /** Always "recount": every number a cancellation check reads is stored (PickupCancelCheck). */
  cancel_check: PickupCancelCheck;
  /**
   * For a rule with a pickup condition: the room nights (and revenue) on
   * the measured room types first seen after the count opened (baseline_ts)
   * and by this run (eval_ts), still booked now, so a later cancellation
   * check can tell how many of the bookings that came in during the count
   * have cancelled since (cancellationsUndo in pickup.ts). null without a
   * pickup condition, or when they could not be read.
   */
  pickup_units_arrived: number | null;
  pickup_revenue_arrived: number | null;
  /**
   * The booking speed window, in hotel dates, when the rule has a booking
   * speed reading: the days it counted, ending on the run's day for a raise
   * rule and on the day before for a cut rule (counted_through).
   */
  window_from: string | null;
  /**
   * When window_from's day was split at the fire this one counted from
   * (booking_speed.counted_since): only the bookings first seen after it on
   * that day were counted, and the frozen window is read back the same way.
   * null when that day was counted whole.
   */
  window_since: string | null;
  window_to: string | null;
  window_bookings_at_fire: number | null;
  window_expected_at_fire: number | null;
  /** signalSetKey of the room types measured. */
  signal_set_key: string;
};

export type LadderTransitionAction = "activate" | "deactivate" | "noop";

export type SnapshotRow = {
  hotel_id: string;
  snapshot_ts: string;
  stay_date: string;
  room_type_id: string;
  sellable_units: number;
  booked_units: number;
  booked_revenue: number;
};

export type RoomTypeRow = {
  id: string;
  hotel_id: string;
  name: string;
  is_active: boolean;
  total_rooms: number;
  floor_price: number;
  ceiling_price: number;
  /**
   * null = nobody has said yet, and an unclassified type keeps counting so a
   * fresh import behaves exactly as before the flag existed. Only an
   * explicit false takes a type out of occupancy, capacity and billing.
   */
  counts_as_room?: boolean | null;
};

/** The one test that matters for every room-count denominator in the engine. */
export function countsAsRoom(rt: { counts_as_room?: boolean | null }): boolean {
  return rt.counts_as_room !== false;
}
