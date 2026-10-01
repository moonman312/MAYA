/**
 * Pure helpers for the pricing rule form — maps UI state to RuleCondition,
 * legacy conditions (simulation / in-memory store), and API payloads.
 */

import { bookingSpeedRank, isBookingSpeed } from "@/lib/observations/booking-speed";
import type {
  BookingSpeedRuleOperator,
  BookingSpeedWindowDays,
  EngineRule,
  PickupMetric,
  RuleAction,
  RuleCondition,
  RuleConditionValue,
} from "@/types/domain";

const BOOKING_SPEED_WINDOWS: readonly number[] = [1, 7, 30];

/** Waits the builder offers an event rule before it may fire again. */
export type BookingSpeedWaitDays = 1 | 2 | 3 | 7 | 14;

export const BOOKING_SPEED_WAIT_OPTIONS: { days: BookingSpeedWaitDays; label: string }[] = [
  { days: 1, label: "1 day" },
  { days: 2, label: "2 days" },
  { days: 3, label: "3 days" },
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
];

/** What a rule waits when nobody has chosen, and what a stored null means. */
export const DEFAULT_BOOKING_SPEED_WAIT_DAYS: BookingSpeedWaitDays = 7;

/**
 * The first choice of a pickup count rule's wait, and the one it starts on:
 * saved as null, which the engine reads as the lookback window. The other
 * choices are BOOKING_SPEED_WAIT_OPTIONS.
 */
export const PICKUP_WAIT_SAME_AS_WINDOW_LABEL = "Same as the lookback window";

/** Which conditions an event rule has, and the waits they were given. */
export type EventRuleWaitInput = {
  hasBookingSpeed: boolean;
  /** booking_speed_cooldown_days: null reads as a week. */
  cooldownDays: number | null | undefined;
  hasPickup: boolean;
  pickupWindowDays: number | null | undefined;
  /** pickup_cooldown_days: null (or absent) reads as the lookback window. */
  pickupCooldownDays?: number | null;
  /**
   * The pickup condition looks for low pickup (pickupCountsLow). After a
   * change on a night such a count is only judged on a whole window
   * (pickupJudgesShortStretch in engine/pickup.ts), so the rule never
   * adjusts that night again sooner than its window, whatever wait it has.
   */
  pickupLow?: boolean;
};

/**
 * Whether a pickup condition looks for low pickup: "less than" a number, or
 * "more than" one under zero. The engine never judges such a count on less
 * than its whole window after a change (pickupJudgesShortStretch in
 * engine/pickup.ts: fewer bookings would only make it truer), and
 * rule-form.test.ts holds the two together.
 */
export function pickupCountsLow(operator: string | null | undefined, threshold: number | null | undefined): boolean {
  const n = threshold != null && Number.isFinite(threshold) ? threshold : 0;
  return !(operator === "gt" && n >= 0);
}

/**
 * The hotel days a pickup count covered, said from the day of the change it
 * made ("that day"): a count looking for more counts that day so far and
 * the days before it; one looking for low pickup (pickupCountsLow) counts
 * complete days ending the day before (Jake, 2026-09-28; baselineTsFrom in
 * engine/pickup.ts). A phrase that follows "arrived".
 */
export function pickupDaysPhrase(windowDays: number, low: boolean): string {
  const n = Math.max(1, Math.floor(windowDays));
  if (low) return n === 1 ? "the day before" : `in the ${n} full days before that day`;
  if (n === 1) return "that day";
  return `that day and the ${n === 2 ? "day" : `${n - 1} days`} before`;
}

/** The booking speed condition's own wait, at least a day; 0 without one. */
export function bookingSpeedOwnWait(input: EventRuleWaitInput): number {
  return input.hasBookingSpeed ? Math.max(1, input.cooldownDays ?? DEFAULT_BOOKING_SPEED_WAIT_DAYS) : 0;
}

/**
 * The pickup condition's own wait: its chosen wait, or its lookback window,
 * and never less than that window for a count on low pickup (pickupLow). 0
 * without one.
 */
export function pickupOwnWait(input: EventRuleWaitInput): number {
  if (!input.hasPickup) return 0;
  const window = input.pickupWindowDays ?? 3;
  return Math.max(1, input.pickupCooldownDays ?? window, input.pickupLow ? window : 0);
}

/**
 * Whole days an event rule waits on a night and room type before it may fire
 * there again, the same way the engine works it out (ruleWaitDays in
 * engine/pickup.ts): a booking speed rule waits its stored wait, at least a
 * day; a pickup count rule waits the wait chosen for it, or its lookback
 * window when none was; a rule with both waits the longer of the two. A
 * count on low pickup can't adjust a night again before its whole window has
 * passed either (pickupLow), so its rule keeps at least that.
 * rule-form.test.ts checks this against the engine's own functions, because
 * a card that says a different number is a card that lies about what the
 * rule does.
 */
export function eventRuleWaitDays(input: EventRuleWaitInput): number {
  const days = Math.max(bookingSpeedOwnWait(input), pickupOwnWait(input));
  return days > 0 ? days : DEFAULT_BOOKING_SPEED_WAIT_DAYS;
}

/** True when the pickup condition's wait, not the booking speed one, is what sets the wait. */
export function pickupSetsWait(input: EventRuleWaitInput): boolean {
  return input.hasPickup && pickupOwnWait(input) > bookingSpeedOwnWait(input);
}

/** True when a rule with both conditions waits its booking speed wait, the longer one. */
export function bookingSpeedSetsWait(input: EventRuleWaitInput): boolean {
  return input.hasBookingSpeed && input.hasPickup && bookingSpeedOwnWait(input) > pickupOwnWait(input);
}

/** A number of days in words: "1 day", "3 days", "1 week", "2 weeks". */
export function waitDaysLabel(days: number): string {
  const value = Math.max(1, Math.round(days));
  const known = BOOKING_SPEED_WAIT_OPTIONS.find((o) => o.days === value);
  if (known) return known.label;
  if (value % 7 === 0) {
    const weeks = value / 7;
    return weeks === 1 ? "1 week" : `${weeks} weeks`;
  }
  return value === 1 ? "1 day" : `${value} days`;
}

/**
 * The wait in words. A rule saved before the builder offered the choice has
 * none stored, and the engine reads that as a week, so that is what it says.
 * A number that is not on the list still reads correctly.
 */
export function bookingSpeedWaitLabel(days: number | null | undefined): string {
  return waitDaysLabel(days == null ? DEFAULT_BOOKING_SPEED_WAIT_DAYS : days);
}

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
  /** Days the rule waits on a night and room type before it may fire again. */
  booking_speed_cooldown_days: BookingSpeedWaitDays;
  /**
   * The same for a pickup count row. null is "Same as the lookback window",
   * saved as null.
   */
  pickup_cooldown_days: BookingSpeedWaitDays | null;
  /**
   * The compare a saved rule has, kept while its level is untouched: a rule
   * saved as "exactly Slower" (the starter rules have one) would otherwise
   * turn into "Slower or slower still" just by being opened and saved.
   * Choosing another level clears it, and the form derives the compare.
   */
  booking_speed_operator?: BookingSpeedRuleOperator;
  /**
   * The builder filled this row in itself (farOutCutGuardRow), and shows a
   * "?" saying why. Cleared when the row's metric is changed. Never saved:
   * the draft carries the condition, not who typed it.
   */
  prefilled?: "far_out_cut";
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
    booking_speed_cooldown_days: partial?.booking_speed_cooldown_days ?? DEFAULT_BOOKING_SPEED_WAIT_DAYS,
    pickup_cooldown_days: partial?.pickup_cooldown_days ?? null,
    ...(partial?.booking_speed_operator ? { booking_speed_operator: partial.booking_speed_operator } : {}),
    ...(partial?.prefilled ? { prefilled: partial.prefilled } : {}),
  };
}

/* ── A cut on low pickup with nothing to keep it near ─────────── */

/**
 * The shape the audit proved cuts every quiet far-out night again each wait
 * (A4; Jake, 2026-09-29): "Decrease the rate", a pickup count "Less than" a
 * number, and no days-before-arrival condition. A far-out night with no
 * bookings yet always counts as low pickup, so such a rule reaches every
 * night of the 396-night window, and cuts each one again whenever its wait
 * is over. Two guards, both in the owner's sight: the builder fills a
 * days-before-arrival row in the moment the form takes this shape
 * (farOutCutGuardRow, removable, never added on save), and the activation
 * popup says how many nights the rule reaches and that the cut repeats
 * (farOutCutFacts; farOutCutLines in rule-activation-client.ts). Rules
 * already saved are left as they are.
 */
export const FAR_OUT_CUT_GUARD_DAYS = 60;

/** True for a saved condition and direction of that shape. */
export function isFarOutCut(
  condition: Pick<RuleCondition, "pickup_operator" | "dta_operator" | "dta_threshold_days"> | null | undefined,
  direction: string | null | undefined,
): boolean {
  if (direction !== "decrease" || condition?.pickup_operator !== "lt") return false;
  return !(condition.dta_operator && condition.dta_threshold_days != null);
}

/**
 * True the moment the builder's rows take that shape: a pickup row on "Less
 * than" and no booking window row at all (one with an empty threshold is
 * still a row the owner can see and fill in).
 */
export function rowsAreFarOutCut(rows: readonly ConditionFormRow[], direction: string): boolean {
  if (direction !== "decrease") return false;
  const pickup = rows.find((r) => r.metric === "pickup");
  return pickup?.operator === "lt" && !rows.some((r) => r.metric === "booking_window");
}

/** The row the builder fills in: within FAR_OUT_CUT_GUARD_DAYS days of arrival, marked as filled in. */
export function farOutCutGuardRow(): ConditionFormRow {
  return newConditionRow("booking_window", { operator: "lt", value: String(FAR_OUT_CUT_GUARD_DAYS), prefilled: "far_out_cut" });
}

/** The "?" beside the row the builder filled in. */
export const FAR_OUT_CUT_GUARD_HELP: { label: string; title: string; lines: string[] } = {
  label: "Why this condition was added",
  title: "Filled in for you",
  lines: [
    `A cut on low pickup with no booking window reaches every night ahead, and a far-out night with no bookings yet always counts as quiet, so it would cut each of them again every time its wait is over. Within ${FAR_OUT_CUT_GUARD_DAYS} days of arrival keeps the cuts to the nights that need them. Change the number, or remove the row.`,
  ],
};

/** What the popup says about a rule of that shape, from its saved condition. */
export type FarOutCutFacts = {
  threshold: number;
  windowDays: number;
  metric: PickupMetric;
  /** The wait the rule really keeps between two cuts on a night (eventRuleWaitDays). */
  waitDays: number;
};

/**
 * The facts for a rule of that shape, or null for any other. The wait is
 * the one the engine keeps: the pickup wait, never less than the window for
 * a count on low pickup, or the booking speed wait when that is longer.
 */
export function farOutCutFacts(condition: RuleCondition | null | undefined, direction: string | null | undefined): FarOutCutFacts | null {
  if (!condition || !isFarOutCut(condition, direction)) return null;
  const windowDays = Number(condition.pickup_window_days ?? 3);
  const waitDays = eventRuleWaitDays({
    hasBookingSpeed: !!condition.booking_speed_operator,
    cooldownDays: condition.booking_speed_cooldown_days ?? null,
    hasPickup: true,
    pickupWindowDays: windowDays,
    pickupCooldownDays: condition.pickup_cooldown_days ?? null,
    pickupLow: pickupCountsLow(condition.pickup_operator, condition.pickup_threshold),
  });
  return {
    threshold: Number(condition.pickup_threshold ?? 0),
    windowDays,
    metric: condition.pickup_metric ?? "room_nights",
    waitDays,
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

/**
 * The "?" beside the rules table's Fired column. rule_fire_counts counts one
 * row per ladder activation and one per fire an event rule made, on every
 * night and room type, leaving out only the same-run cancellations from
 * before stacking landed.
 */
export const RULE_FIRES_HELP: { label: string; title: string; lines: string[] } = {
  label: "What counts as a fire",
  title: "Times fired",
  lines: [
    "Every time the rule acted, counted once per night and room type.",
    "A booking speed or pickup rule can act on the same night more than once, when its wait is over and it is still true, and each time counts here.",
    "A change that came off later still counts.",
  ],
};

/**
 * The rule builder's box, ticked on every new rule. Jake, 2026-09-25: one
 * option for every rule, the same for a raise or a cut and for every kind
 * of condition. The rules list does not show it (Jake, 2026-09-28).
 */
export const UNDO_ON_CANCELLATION_LABEL = "Undo the change if cancellations mean this rule is no longer true";

/**
 * The "?" beside the box. What the engine does: ticked, once bookings a
 * change counted have cancelled (cancellationFinding in engine/pickup.ts),
 * the change comes off only if its rule is also not true counted the way it
 * would count without it, bookings made since included
 * (cancellablePartsHold, evaluate.ts); kept, only the numbers its own check
 * recounts are taken again (restateFire), and every rule still counts from
 * when it was made, which is what "since the latest raise still on this
 * night" means everywhere the owner reads it (Jake, 2026-09-27: counting
 * starts again only when a price changes); a cut's booking speed part is never
 * judged (cancellableParts), and an unticked occupancy rule keeps its
 * change (ladderConditionsHold in engine/conditions.ts). After an undo the
 * rule adjusts again once it is true and its wait, if it has one, is over.
 * Either way a change comes off when its night passes or its price is set
 * by hand here or in the PMS; a rule on occupancy or days before arrival
 * lets go whenever it stops being true for another reason; an edit starts
 * the rule over (edited changes come off, and an occupancy or
 * days-before-arrival rule still true after it keeps its change with the
 * edited adjustment); deleting a rule takes its changes off.
 */
export const UNDO_ON_CANCELLATION_HELP: { label: string; title: string; lines: string[] } = {
  label: "What undo on cancellations does",
  title: "Undo on cancellations",
  lines: [
    "Ticked: if bookings this change counted cancel and the rule is no longer true for the night, the change comes off. If bookings made since keep the rule true, it stays, and rules keep counting from when it was made.",
    "A cut on booking speed stays when cancellations only slow the night down. Once a change comes off, the rule can adjust the night again when it is true again and any wait it has is over.",
    "Unticked: cancellations never undo it.",
    "Either way, a change comes off when the night passes or its price is set by you or in your PMS. A rule on occupancy or days before arrival also lets go once it stops being true for other reasons.",
    "Editing a rule starts it over, and deleting it takes its changes off.",
  ],
};

/** What a rule's save says to someone who may read the rule but not change it. */
export const RULE_CHANGE_FORBIDDEN = "Only a Revenue Manager or above can change this.";

/**
 * Why an undo_on_cancellation value in a request is unusable, or null when
 * it is fine (a boolean) or absent. Anything else is refused rather than
 * read as ticked or unticked.
 */
export function undoOnCancellationError(value: unknown): string | null {
  if (value === undefined || typeof value === "boolean") return null;
  return "Undo on cancellations must be true or false.";
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
      c.booking_speed_operator = row.booking_speed_operator ?? directionalBookingSpeedOperator(row.booking_speed_level);
      c.booking_speed_level = row.booking_speed_level;
      c.booking_speed_window_days = row.booking_speed_window_days;
      c.booking_speed_cooldown_days = row.booking_speed_cooldown_days;
    } else {
      const n = parseThreshold(row.value);
      if (n === null) continue;
      c.pickup_operator = row.operator;
      c.pickup_threshold = n;
      c.pickup_window_days = row.pickup_window_days;
      c.pickup_metric = row.pickup_metric;
      if (row.pickup_cooldown_days != null) c.pickup_cooldown_days = row.pickup_cooldown_days;
    }
  }
  return c;
}

/**
 * A saved rule's condition as the builder's rows: the inverse of
 * conditionRowsToRuleCondition, so opening a rule to edit it and saving it
 * unchanged saves the same condition. Rows come in the builder's order.
 */
export function ruleConditionToRows(c: RuleCondition): ConditionFormRow[] {
  const rows: ConditionFormRow[] = [];
  const num = (v: number) => String(Math.round(v * 10_000) / 10_000);
  if (c.occupancy_operator && c.occupancy_threshold != null) {
    rows.push(
      newConditionRow("occupancy", {
        operator: c.occupancy_operator,
        value: String(Math.round(Number(c.occupancy_threshold) * 10_000) / 100),
      }),
    );
  }
  if (c.booking_speed_operator && isBookingSpeed(c.booking_speed_level)) {
    const level = c.booking_speed_level as string;
    const derived = directionalBookingSpeedOperator(level);
    const wait = Number(c.booking_speed_cooldown_days ?? DEFAULT_BOOKING_SPEED_WAIT_DAYS);
    rows.push(
      newConditionRow("booking_speed", {
        booking_speed_level: level,
        booking_speed_window_days: (c.booking_speed_window_days ?? 7) as BookingSpeedWindowDays,
        booking_speed_cooldown_days: wait as BookingSpeedWaitDays,
        ...(c.booking_speed_operator !== derived ? { booking_speed_operator: c.booking_speed_operator } : {}),
      }),
    );
  }
  if (c.dta_operator && c.dta_threshold_days != null) {
    rows.push(newConditionRow("booking_window", { operator: c.dta_operator, value: String(c.dta_threshold_days) }));
  }
  if (c.pickup_operator && c.pickup_threshold != null) {
    rows.push(
      newConditionRow("pickup", {
        operator: c.pickup_operator,
        value: num(Number(c.pickup_threshold)),
        pickup_window_days: (c.pickup_window_days ?? 3) as 1 | 3 | 7,
        pickup_metric: c.pickup_metric ?? "room_nights",
        pickup_cooldown_days: c.pickup_cooldown_days != null ? (Number(c.pickup_cooldown_days) as BookingSpeedWaitDays) : null,
      }),
    );
  }
  return rows.length > 0 ? rows : [newConditionRow("occupancy")];
}

/**
 * Everything the builder holds for a saved rule (the engine's shape, from
 * /api/rules/engine), for editing it: the name, the condition rows, the
 * direction and the one amount, the room type lists (with "Change prices on
 * different room types" ticked when it measures something else), and the
 * undo box. Its date window, weekdays and priority are not in the builder
 * and are kept as saved.
 */
export function ruleToBuilderForm(
  rule: Pick<
    EngineRule,
    | "name"
    | "condition"
    | "action_type"
    | "action_direction"
    | "action_value"
    | "signal_room_type_ids"
    | "affected_room_type_ids"
    | "undo_on_cancellation"
  >,
  isCounting: (id: string) => boolean,
): {
  name: string;
  rows: ConditionFormRow[];
  direction: "increase" | "decrease";
  percent: string;
  dollars: string;
  split: boolean;
  selected: string[];
  changeIds: string[];
  undo: boolean;
} {
  const amount = String(Math.round(Number(rule.action_value) * 10_000) / 10_000);
  const split = measuresDifferently(rule.signal_room_type_ids, rule.affected_room_type_ids, isCounting);
  return {
    name: rule.name,
    rows: ruleConditionToRows(rule.condition),
    direction: rule.action_direction,
    percent: rule.action_type === "percent" ? amount : "",
    dollars: rule.action_type === "fixed" ? amount : "",
    split,
    selected: split ? [...rule.signal_room_type_ids] : [...rule.affected_room_type_ids],
    changeIds: split ? [...rule.affected_room_type_ids] : [],
    undo: rule.undo_on_cancellation !== false,
  };
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
    if (c.pickup_cooldown_days != null && Number.isFinite(c.pickup_cooldown_days)) {
      // At least a day, as the column requires. Left out, it is null: the
      // rule waits its lookback window.
      row.pickup_cooldown_days = Math.max(1, Math.round(c.pickup_cooldown_days));
    }
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
    if (c.booking_speed_cooldown_days != null && Number.isFinite(c.booking_speed_cooldown_days)) {
      // The column refuses anything under a day since stacking landed: a wait
      // of none would let the rule fire on every five-minute run.
      row.booking_speed_cooldown_days = Math.max(1, Math.round(c.booking_speed_cooldown_days));
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
  // pickup_timing: the window and the wait a saved rule keeps (rules-store.ts).
  const puTiming = conditions.pickup_timing;
  if (pu != null) parts.push(`Pickup ${wordify(pu, " bookings")}${puTiming != null ? ` ${puTiming}` : ""}`);
  for (const [k, v] of Object.entries(conditions)) {
    if (k === "occupancy_percentage" || k === "booking_window" || k === "pickup_rate" || k === "pickup_timing" || k === "nights") continue;
    parts.push(`${k.replace(/_/g, " ")} ${wordify(v)}`);
  }
  // The nights a rule covers, when not every night (rules-store.ts nightsLabel).
  if (conditions.nights != null) parts.push(`Nights ${conditions.nights}`);
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

/* ── The amount: a percent or a fixed amount, never both ─────── */

/** The builder's two amount boxes are both empty. */
export const RATE_AMOUNT_MISSING = "Enter a percent or a fixed amount.";
/** A rule with a percent and a fixed amount, which the routes refuse. */
export const RATE_AMOUNT_BOTH = "Use a percent or a fixed amount, not both.";

/**
 * Why an action in a request is unusable because it has both amounts, or
 * null. A key that is there at all counts, so nothing is silently dropped.
 */
export function ruleActionError(action: unknown): string | null {
  if (!action || typeof action !== "object") return null;
  const a = action as Record<string, unknown>;
  return a.adjust_rate_percent !== undefined && a.adjust_rate_dollars !== undefined ? RATE_AMOUNT_BOTH : null;
}

/** A rule's action the store refused for having both amounts. The routes answer it with a 400. */
export class RuleAmountError extends Error {
  constructor() {
    super(RATE_AMOUNT_BOTH);
    this.name = "RuleAmountError";
  }
}

/**
 * The rule builder's two amount boxes. Typing in one greys out the other,
 * so only one can hold a number; whichever does is the rule's amount, signed
 * by the direction.
 */
export function ruleActionFromAmounts(
  percent: string,
  dollars: string,
  direction: "increase" | "decrease",
): { action: RuleAction } | { error: string } {
  const p = percent.trim();
  const d = dollars.trim();
  if (p !== "" && d !== "") return { error: RATE_AMOUNT_BOTH };
  if (p === "" && d === "") return { error: RATE_AMOUNT_MISSING };
  const n = Number(p !== "" ? p : d);
  if (!Number.isFinite(n) || n < 0) {
    return {
      error:
        p !== ""
          ? "Enter the percentage as a positive number. The direction dropdown decides increase or decrease."
          : "Enter the amount as a positive number. The direction dropdown decides increase or decrease.",
    };
  }
  const signed = direction === "decrease" ? -n : n;
  return { action: p !== "" ? { adjust_rate_percent: signed } : { adjust_rate_dollars: signed } };
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
 * A room type set the store refused: empty, or nothing in it belongs to the
 * rule's hotel. The routes answer it with a 400, like roomTypeIdListError.
 */
export class RoomTypeSetError extends Error {
  constructor(what: "measure" | "change") {
    super(`Pick at least one room type to ${what}.`);
    this.name = "RoomTypeSetError";
  }
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

/** Everything the rule builder holds. */
export type BuilderValues = {
  name: string;
  rows: ConditionFormRow[];
  direction: "" | "increase" | "decrease";
  percent: string;
  dollars: string;
  selected: string[];
  split: boolean;
  changeIds: string[];
  undo: boolean;
};

/**
 * What the builder holds as the body the rules routes take (POST
 * /api/rules, PUT /api/rules/[id], and the activation popup's preview), or
 * what the owner still has to fill in.
 */
export function builderDraft(
  v: BuilderValues,
  options: RoomTypeOption[],
): { draft: Record<string, unknown> } | { error: string } {
  const rc = ruleConditionForInsert(conditionRowsToRuleCondition(v.rows));
  if (isRuleConditionEmpty(rc)) return { error: "Add at least one condition with a valid operator and threshold." };
  if (v.direction === "") return { error: "Choose whether this rule increases or decreases the rate." };
  const amount = ruleActionFromAmounts(v.percent, v.dollars, v.direction);
  if ("error" in amount) return { error: amount.error };
  const sets = ruleRoomTypeSets({ options, selected: v.selected, split: v.split, changeIds: v.changeIds });
  if ("error" in sets) return { error: sets.error };
  return {
    draft: {
      rule_name: v.name,
      condition: rc,
      conditions: ruleConditionToLegacyConditions(rc),
      action: amount.action,
      room_types: sets.room_types,
      signal_room_type_ids: sets.signal_room_type_ids,
      affected_room_type_ids: sets.affected_room_type_ids,
      undo_on_cancellation: v.undo,
    },
  };
}

/**
 * The part of a draft that decides what a rule does to prices: everything
 * but its name. Two drafts with the same key differ at most in the name,
 * which moves no price (so an edit that renames a rule saves without the
 * activation popup).
 */
export function draftBehaviourKey(draft: Record<string, unknown>): string {
  const sorted = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort() : v);
  const { rule_name: _name, conditions: _legacy, room_types: _names, ...rest } = draft;
  void _name;
  void _legacy;
  void _names;
  return JSON.stringify({
    ...rest,
    signal_room_type_ids: sorted(rest.signal_room_type_ids),
    affected_room_type_ids: sorted(rest.affected_room_type_ids),
    condition: Object.fromEntries(Object.entries((rest.condition ?? {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))),
  });
}
