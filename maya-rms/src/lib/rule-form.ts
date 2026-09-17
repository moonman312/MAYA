/**
 * Pure helpers for the pricing rule form — maps UI state to RuleCondition,
 * legacy conditions (simulation / in-memory store), and API payloads.
 */

import { bookingSpeedRank, isBookingSpeed } from "@/lib/observations/booking-speed";
import type {
  BookingSpeedRuleOperator,
  BookingSpeedWindowDays,
  PickupMetric,
  RuleAction,
  RuleCondition,
  RuleConditionValue,
} from "@/types/domain";

const BOOKING_SPEED_WINDOWS: readonly number[] = [1, 7, 30];

export type ConditionMetric = "occupancy" | "booking_window" | "pickup" | "booking_speed";

export type ConditionFormRow = {
  id: string;
  metric: ConditionMetric;
  operator: "gt" | "lt";
  /** Occupancy: 0–100 (%). Booking window: days. Pickup: threshold count / amount. */
  value: string;
  pickup_window_days: 1 | 3 | 7;
  pickup_metric: PickupMetric;
  /** A BookingSpeed level key ("faster", "much_slower", ...). The compare
   *  operator is DERIVED from the level's side of Normal — see
   *  directionalBookingSpeedOperator — so the form never asks for it. */
  booking_speed_level: string;
  booking_speed_window_days: BookingSpeedWindowDays;
};

const SYM: Record<"gt" | "lt", string> = { gt: ">", lt: "<" };

export function newConditionRow(
  metric: ConditionMetric,
  partial?: Partial<Omit<ConditionFormRow, "id" | "metric">>,
): ConditionFormRow {
  return {
    id: crypto.randomUUID(),
    metric,
    operator: partial?.operator ?? "gt",
    value: partial?.value ?? (metric === "occupancy" ? "80" : metric === "booking_window" ? "7" : "5"),
    pickup_window_days: partial?.pickup_window_days ?? 3,
    pickup_metric: partial?.pickup_metric ?? "room_nights",
    booking_speed_level: partial?.booking_speed_level ?? "faster",
    booking_speed_window_days: partial?.booking_speed_window_days ?? 7,
  };
}

/**
 * The one sane compare for each speed level: picking a level below Normal
 * means "that slow or slower", above Normal means "that fast or faster",
 * Normal means exactly Normal. Owners phrase it this way naturally, so the
 * form derives the operator instead of asking.
 */
export function directionalBookingSpeedOperator(levelKey: string): BookingSpeedRuleOperator {
  if (!isBookingSpeed(levelKey)) return "is";
  const rank = bookingSpeedRank(levelKey);
  return rank < 0 ? "at_most" : rank > 0 ? "at_least" : "is";
}

/** True when no usable condition family is set. */
export function isRuleConditionEmpty(c: RuleCondition | undefined | null): boolean {
  if (!c) return true;
  const hasOcc =
    !!c.occupancy_operator && c.occupancy_threshold != null && Number.isFinite(c.occupancy_threshold);
  const hasDta =
    !!c.dta_operator && c.dta_threshold_days != null && Number.isFinite(c.dta_threshold_days);
  const hasPu =
    !!c.pickup_operator &&
    c.pickup_threshold != null &&
    Number.isFinite(c.pickup_threshold) &&
    c.pickup_window_days != null &&
    !!c.pickup_metric;
  const hasBs =
    !!c.booking_speed_operator &&
    isBookingSpeed(c.booking_speed_level) &&
    c.booking_speed_window_days != null &&
    BOOKING_SPEED_WINDOWS.includes(c.booking_speed_window_days);
  return !hasOcc && !hasDta && !hasPu && !hasBs;
}

/**
 * Parses a threshold input string, distinguishing "the user typed nothing"
 * (or only whitespace) from "the user typed 0" — Number("") and Number("  ")
 * are both 0 and finite, so a cleared-then-submitted field would otherwise
 * silently become a legitimate zero threshold (e.g. "occupancy above 0%",
 * true for every stay date with any booking at all) instead of being
 * rejected. Negative values are rejected outright rather than clamped to 0,
 * since clamping a typo like "-5" produces that exact same always-true
 * condition. An intentional literal 0 stays legal — the check is on the
 * string, never on the parsed value being non-zero.
 */
function parseThreshold(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function conditionRowsToRuleCondition(rows: ConditionFormRow[]): RuleCondition {
  const c: RuleCondition = {};
  for (const row of rows) {
    if (row.metric === "occupancy") {
      const n = parseThreshold(row.value);
      if (n === null) continue;
      c.occupancy_operator = row.operator;
      c.occupancy_threshold = Math.min(100, n) / 100;
    } else if (row.metric === "booking_window") {
      const n = parseThreshold(row.value);
      if (n === null) continue;
      c.dta_operator = row.operator;
      c.dta_threshold_days = Math.round(n);
    } else if (row.metric === "booking_speed") {
      if (!isBookingSpeed(row.booking_speed_level)) continue;
      c.booking_speed_operator = directionalBookingSpeedOperator(row.booking_speed_level);
      c.booking_speed_level = row.booking_speed_level;
      c.booking_speed_window_days = row.booking_speed_window_days;
    } else {
      const n = parseThreshold(row.value);
      if (n === null) continue;
      c.pickup_operator = row.operator;
      c.pickup_threshold = n;
      c.pickup_window_days = row.pickup_window_days;
      c.pickup_metric = row.pickup_metric;
    }
  }
  return c;
}

/** Strips incomplete families so DB rule_condition CHECK constraints pass. */
export function ruleConditionForInsert(c: RuleCondition): RuleCondition {
  const row: RuleCondition = {};
  if (
    c.occupancy_operator &&
    c.occupancy_threshold != null &&
    Number.isFinite(c.occupancy_threshold)
  ) {
    row.occupancy_operator = c.occupancy_operator;
    row.occupancy_threshold = c.occupancy_threshold;
  }
  if (
    c.dta_operator &&
    c.dta_threshold_days != null &&
    Number.isFinite(c.dta_threshold_days)
  ) {
    row.dta_operator = c.dta_operator;
    row.dta_threshold_days = c.dta_threshold_days;
  }
  if (
    c.pickup_operator &&
    c.pickup_threshold != null &&
    Number.isFinite(c.pickup_threshold) &&
    c.pickup_window_days != null &&
    c.pickup_metric
  ) {
    row.pickup_operator = c.pickup_operator;
    row.pickup_threshold = c.pickup_threshold;
    row.pickup_window_days = c.pickup_window_days;
    row.pickup_metric = c.pickup_metric;
  }
  if (
    c.booking_speed_operator &&
    isBookingSpeed(c.booking_speed_level) &&
    c.booking_speed_window_days != null &&
    BOOKING_SPEED_WINDOWS.includes(c.booking_speed_window_days)
  ) {
    row.booking_speed_operator = c.booking_speed_operator;
    row.booking_speed_level = c.booking_speed_level;
    row.booking_speed_window_days = c.booking_speed_window_days;
    if (
      c.booking_speed_cooldown_days != null &&
      Number.isFinite(c.booking_speed_cooldown_days) &&
      c.booking_speed_cooldown_days >= 0
    ) {
      row.booking_speed_cooldown_days = Math.round(c.booking_speed_cooldown_days);
    }
  }
  return row;
}

/** Legacy map for simulateRateChanges + in-memory store + pricing_rule_conditions. */
export function ruleConditionToLegacyConditions(c: RuleCondition): Record<string, RuleConditionValue> {
  const out: Record<string, RuleConditionValue> = {};
  if (c.occupancy_operator && c.occupancy_threshold != null) {
    const pct = Math.round(c.occupancy_threshold * 10_000) / 100;
    out.occupancy_percentage = `${SYM[c.occupancy_operator]}${pct}`;
  }
  if (c.dta_operator && c.dta_threshold_days != null) {
    out.booking_window = `${SYM[c.dta_operator]}${c.dta_threshold_days}`;
  }
  if (c.pickup_operator && c.pickup_threshold != null) {
    out.pickup_rate = `${SYM[c.pickup_operator]}${c.pickup_threshold}`;
  }
  return out;
}

/** ">80" -> "above 80", "<7" -> "below 7" — hoteliers read words, not math. */
function wordify(value: RuleConditionValue, unit = ""): string {
  const s = String(value).trim();
  if (s.startsWith(">")) return `above ${s.slice(1).trim()}${unit}`;
  if (s.startsWith("<")) return `below ${s.slice(1).trim()}${unit}`;
  return `${s}${unit}`;
}

export function formatRuleConditionsDisplay(conditions: Record<string, RuleConditionValue>): string {
  const parts: string[] = [];
  const occ = conditions.occupancy_percentage;
  if (occ != null) parts.push(`Occupancy ${wordify(occ, "%")}`);
  const bw = conditions.booking_window;
  if (bw != null) parts.push(`Booking window ${wordify(bw, " days")}`);
  const pu = conditions.pickup_rate;
  if (pu != null) parts.push(`Pickup ${wordify(pu, " bookings")}`);
  for (const [k, v] of Object.entries(conditions)) {
    if (k === "occupancy_percentage" || k === "booking_window" || k === "pickup_rate") continue;
    parts.push(`${k.replace(/_/g, " ")} ${wordify(v)}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}

export function isRuleActionEmpty(a: RuleAction | undefined | null): boolean {
  if (!a) return true;
  const hasPct =
    a.adjust_rate_percent !== undefined &&
    Number.isFinite(a.adjust_rate_percent);
  const hasDolR =
    a.adjust_rate_dollars !== undefined && Number.isFinite(a.adjust_rate_dollars);
  return !hasPct && !hasDolR;
}

/* ── Measured and changed room types ─────────────────────────── */

/**
 * The room types a rule measures when the owner picked one list: the ones
 * among `affected` that count as rooms, or all of them when none do (ticking
 * only the court is a decision to price it on its own numbers). The same
 * default createRule applies when no signal set is sent.
 */
export function defaultSignalIds(
  affected: readonly string[],
  isCounting: (id: string) => boolean,
): string[] {
  const counting = affected.filter(isCounting);
  return counting.length > 0 ? counting : [...affected];
}

/**
 * True when a rule measures different room types from the ones it changes.
 * Only types that count as rooms are compared, so a rule that also changes
 * the court (which it never measures) still reads as one list.
 */
export function measuresDifferently(
  signal: readonly string[],
  affected: readonly string[],
  isCounting: (id: string) => boolean,
): boolean {
  const key = (ids: readonly string[]) => [...new Set(ids.filter(isCounting))].sort().join(",");
  return key(signal) !== key(affected);
}

/**
 * The room types column of a rule card: the changed names as they always
 * read, or "Watches A, B · Changes C" when the rule measures something else.
 * Only watched types that count as rooms are named, since those are all the
 * engine measures (the change log names the same ones).
 */
export function ruleRoomTypesLabel(
  rule: {
    room_types: string[];
    signal_room_type_ids?: string[];
    affected_room_type_ids?: string[];
    signal_room_types?: { id: string; name: string }[];
  },
  isCounting: (id: string) => boolean,
): string {
  const changes = rule.room_types.length ? rule.room_types.join(", ") : "All";
  const signal = rule.signal_room_type_ids;
  const affected = rule.affected_room_type_ids;
  if (!signal || !affected || !measuresDifferently(signal, affected, isCounting)) return changes;
  const watched = (rule.signal_room_types ?? []).filter((rt) => isCounting(rt.id)).map((rt) => rt.name);
  if (!watched.length) return changes;
  return `Watches ${watched.join(", ")} · Changes ${changes}`;
}

/**
 * Why a room type id list in a request is unusable, or null when it is fine
 * (or absent). An empty list would leave a rule with nothing to measure or
 * nothing to change.
 */
export function roomTypeIdListError(value: unknown, what: "measure" | "change"): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim() === "")) {
    return "Invalid room types.";
  }
  if (value.length === 0) return `Pick at least one room type to ${what}.`;
  return null;
}

export type RoomTypeOption = { id: string; name: string; counts_as_room?: boolean | null };

/**
 * The room type sets the rule builder sends. With one list, the rule changes
 * the picked types and measures the ones among them that count as rooms,
 * exactly what the server would default to. With "Change prices on different
 * room types" ticked, the first list is what it measures (rooms only) and the
 * second what it changes.
 */
export function ruleRoomTypeSets(input: {
  options: RoomTypeOption[];
  selected: string[];
  split: boolean;
  changeIds: string[];
}):
  | { error: string }
  | { signal_room_type_ids: string[]; affected_room_type_ids: string[]; room_types: string[] } {
  const { options } = input;
  const counts = (id: string) => options.find((o) => o.id === id)?.counts_as_room !== false;
  const names = (ids: string[]) => options.filter((o) => ids.includes(o.id)).map((o) => o.name);
  if (!input.split) {
    const allSelected = options.length > 0 && input.selected.length === options.length;
    const affected = allSelected ? options.map((o) => o.id) : input.selected.slice();
    if (affected.length === 0) return { error: "Select at least one room type." };
    return {
      signal_room_type_ids: defaultSignalIds(affected, counts),
      affected_room_type_ids: affected,
      room_types: names(affected),
    };
  }
  const signal = options.filter((o) => input.selected.includes(o.id) && counts(o.id)).map((o) => o.id);
  if (signal.length === 0) return { error: "Pick at least one room type to measure." };
  const affected = options.filter((o) => input.changeIds.includes(o.id)).map((o) => o.id);
  if (affected.length === 0) return { error: "Pick at least one room type to change." };
  return { signal_room_type_ids: signal, affected_room_type_ids: affected, room_types: names(affected) };
}
