/**
 * Internal engine types used across the evaluation pipeline.
 */

import type { ActionDirection, ActionKind, EngineRule } from "@/types/domain";

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
    expected: number;
    window_days: number;
    method: string;
  } | null;
  /** When set, booking-speed conditions must not match (no usable history). */
  booking_speed_block_reason?: "insufficient_data" | null;
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
  signal_booked_units_start: number;
  signal_booked_units_end: number;
  signal_booked_revenue_start: number;
  signal_booked_revenue_end: number;
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
