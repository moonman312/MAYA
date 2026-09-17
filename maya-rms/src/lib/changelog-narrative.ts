/**
 * Human-readable change log narration.
 *
 * The change log is where a hotelier audits what their own rules did to their
 * money. They shouldn't need to decode `occ > 0.7 → +10%`, and they shouldn't
 * have to hold a thirty-word sentence in their head either. Every change reads
 * as two short sentences — what moved, then why:
 *
 *   "Busy-day bump" raised this night 10%, from $200.00 to $220.00.
 *   It was 82% full, past the 70% mark you set.
 *
 * House rules for the prose:
 *   - The owner's rule is the subject and the limits are theirs: "your
 *     ceiling", "the marks you set". Nothing here happened to them.
 *   - Outcome first, reason second. What changed is what the reader came for.
 *   - No math symbols. "past" / "under" / "beyond".
 *     ($ % and digits are fine — hoteliers read prices all day.)
 *   - Observed values appear when we have them; every sentence still reads
 *     correctly when a metric wasn't captured.
 *   - Chained rules replay in application order with running prices, using
 *     the same math as the engine (percent compounds, fixed adds). The second
 *     rule's "from" price is what shows it stacked on the first.
 *   - An event rule can hold more than one adjustment on the same night: once
 *     its wait is over and its condition still holds, it fires again. A
 *     repeat says so ("lowered it another 15%"), because the same rule name
 *     twice in a row otherwise reads like a bug. One verb per direction
 *     throughout, so one rule doing one thing twice never changes words.
 *   - A fire the run took off gets its own sentence first, so a price that
 *     went back up is never unexplained.
 *   - Clamps get their own sentence — hitting a floor/ceiling is exactly the
 *     kind of thing an owner wants to notice.
 *   - A rule that watches other room types than the ones it changed names
 *     them: "Standard and Deluxe were 92% full", on a Suite price change.
 */

import { bookingSpeedPhrase as speedPhrase, isBookingSpeed } from "@/lib/observations/booking-speed";
import type { RuleCondition } from "@/types/domain";

/**
 * Lowercase level for use mid-sentence. The Title Case label is still the
 * label everywhere it stands alone; an unknown key just loses its underscores.
 */
function speedWords(levelKey: string): string {
  return isBookingSpeed(levelKey) ? speedPhrase(levelKey) : levelKey.replace(/_/g, " ");
}

export type NarrativeMetrics = {
  /** Sellable occupancy as a fraction (0.82) — matches the engine's RuleMetrics. */
  occupancy?: number | null;
  /** Room types the engine left out of that occupancy (not rooms, e.g. a court). */
  excluded_from_occupancy?: string[] | null;
  /** Days until arrival. */
  dta?: number | null;
  /** Net pickup units over the rule's window. */
  pickup_units?: number | null;
  /** Booking Speed observation snapshot, from the engine's RuleMetrics. */
  booking_speed?: {
    label: string;
    recent: number;
    expected: number;
  } | null;
};

export type NarrativeApplication = {
  rule_name: string;
  condition: RuleCondition | null;
  action: {
    kind: "percent" | "fixed";
    direction: "increase" | "decrease";
    value: number;
  };
  metrics?: NarrativeMetrics | null;
  is_pickup: boolean;
  /**
   * Names of the room types the rule measures, set only when they are not
   * the ones it changes. Absent, the sentences read as they always have.
   */
  measured_room_types?: string[] | null;
  /** This rule already applied earlier in the chain: it fired again on this night. */
  repeat?: boolean;
};

/** An adjustment this run took off the night, in the order the audit lists them. */
export type NarrativeRetirement = {
  rule_name: string;
  /** The audit's signed delta, e.g. "+10%" or "-$5.00". */
  delta: string;
  reason: "bookings_cancelled" | "manual_price" | "rule_edited";
};

export type NarrativeInput = {
  room_type: string;
  base_price: number;
  final_price: number;
  applications: NarrativeApplication[];
  /** Fires this run stopped applying, said before what is left. */
  retirements?: NarrativeRetirement[];
  floor_price?: number | null;
  ceiling_price?: number | null;
  clamped_by?: "floor" | "ceiling" | null;
  currencySymbol?: string;
};

function money(v: number, sym: string): string {
  return `${sym}${v.toFixed(2)}`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function dayWord(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

function listWords(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One threshold the owner typed, plus the word for the side it was crossed on. */
type Mark = { dir: string; text: string };

/**
 * "past the 90% and 21-day marks you set". Thresholds crossed the same way
 * share one direction word; a rule that crosses one up and one down spells
 * both out rather than picking a side.
 */
function describeMarks(marks: Mark[]): string {
  const sameSide = marks.every((m) => m.dir === marks[0].dir);
  if (sameSide) {
    const noun = marks.length === 1 ? "mark" : "marks";
    return `${marks[0].dir} the ${listWords(marks.map((m) => m.text))} ${noun} you set`;
  }
  return `${marks.map((m) => `${m.dir} the ${m.text} mark`).join(" and ")} you set`;
}

/**
 * Occupancy and the booking window share a sentence. An owner sets them as one
 * condition — 95% full with 17 days to go — so splitting them reads like two
 * separate things happened on the night.
 */
function fullnessSentence(
  condition: RuleCondition,
  metrics?: NarrativeMetrics | null,
  measured?: string[] | null,
): string | null {
  const marks: Mark[] = [];
  let fullness: string | null = null;
  let toGo: string | null = null;

  if (condition.occupancy_operator && condition.occupancy_threshold != null) {
    marks.push({
      dir: condition.occupancy_operator === "gt" ? "past" : "under",
      text: pct(condition.occupancy_threshold),
    });
    if (metrics?.occupancy != null) fullness = `${pct(metrics.occupancy)} full`;
  }

  if (condition.dta_operator && condition.dta_threshold_days != null) {
    // The window counts down, so "fewer than 21 days out" is the 21-day mark
    // gone past, not one missed.
    marks.push({
      dir: condition.dta_operator === "lt" ? "past" : "beyond",
      text: `${condition.dta_threshold_days}-day`,
    });
    if (metrics?.dta != null) toGo = `${dayWord(metrics.dta)} to go`;
  }

  if (marks.length === 0) return null;
  const limits = describeMarks(marks);
  const whatWas = measured?.length ? `${listWords(measured)} ${measured.length === 1 ? "was" : "were"}` : "It was";
  if (fullness && toGo) return `${whatWas} ${fullness} with ${toGo}, ${limits}.`;
  if (fullness) return `${whatWas} ${fullness}, ${limits}.`;
  if (toGo) return `It had ${toGo}, ${limits}.`;
  return `This night was ${limits}.`;
}

/** "9 bookings arrived in the last 3 days, past the 4-booking mark you set." */
function pickupSentence(
  condition: RuleCondition,
  metrics?: NarrativeMetrics | null,
  measured?: string[] | null,
): string | null {
  if (!condition.pickup_operator || condition.pickup_threshold == null) return null;
  const windowDays = condition.pickup_window_days ?? 3;
  const dir = condition.pickup_operator === "gt" ? "past" : "under";
  const limit = `${dir} the ${Number(condition.pickup_threshold)}-booking mark you set`;
  const seen = metrics?.pickup_units;
  const kind = measured?.length ? `${listWords(measured)} ` : "";
  if (seen != null) {
    return `${seen} ${kind}${seen === 1 ? "booking" : "bookings"} arrived in the last ${dayWord(windowDays)}, ${limit}.`;
  }
  return kind
    ? `${kind}bookings in the last ${dayWord(windowDays)} came in ${limit}.`
    : `Bookings in the last ${dayWord(windowDays)} came in ${limit}.`;
}

/**
 * Most levels slot straight into "Bookings came in ___", but stalled, surging
 * and normal aren't comparisons, and forcing them into that frame is how a
 * sentence starts sounding like a label again.
 */
function speedLead(levelKey: string, when: string, subject = "Bookings"): string {
  if (levelKey === "stalled") return `${subject} all but stopped ${when}`;
  if (levelKey === "surging") return `${subject} surged ${when}`;
  if (levelKey === "normal") return `${subject} came in at the normal pace ${when}`;
  return `${subject} came in ${speedWords(levelKey)} ${when}`;
}

/**
 * The level comes from the rule, not from the snapshot: it is the pace the
 * owner wrote into the condition, and it is the one their rule acted on.
 */
function bookingSpeedSentence(
  condition: RuleCondition,
  metrics?: NarrativeMetrics | null,
  measured?: string[] | null,
): string | null {
  if (!condition.booking_speed_operator || !condition.booking_speed_level) return null;
  const when =
    condition.booking_speed_window_days === 1
      ? "this past day"
      : condition.booking_speed_window_days === 30
        ? "this past month"
        : "this past week";
  const lead = speedLead(
    condition.booking_speed_level,
    when,
    measured?.length ? `${listWords(measured)} bookings` : undefined,
  );

  const bs = metrics?.booking_speed;
  if (!bs) return `${lead}.`;
  const recent = Math.round(bs.recent);
  const seen =
    recent < 0 ? "more cancelled than booked" : recent === 0 ? "none" : `${recent}`;
  const usual =
    bs.expected < 1
      ? "where a night like this usually has almost none by now"
      : `against the ${Math.round(bs.expected)} a night like this usually has by now`;
  return `${lead}: ${seen}, ${usual}.`;
}

/** "That 95% leaves out Pickleball Court." */
function exclusionSentence(
  condition: RuleCondition,
  metrics?: NarrativeMetrics | null,
): string | null {
  if (!condition.occupancy_operator || condition.occupancy_threshold == null) return null;
  if (metrics?.occupancy == null) return null;
  const excluded = metrics.excluded_from_occupancy ?? [];
  if (excluded.length === 0) return null;
  return `That ${pct(metrics.occupancy)} leaves out ${listWords(excluded)}.`;
}

/**
 * Why the rule ran, in the owner's own terms — one short sentence per family of
 * condition, so a rule built from two signals reads as two plain statements
 * instead of one clause pile.
 */
export function describeConditions(
  condition: RuleCondition | null,
  metrics?: NarrativeMetrics | null,
  measured?: string[] | null,
): string[] {
  if (!condition) return [];
  const sentences = [
    fullnessSentence(condition, metrics, measured),
    pickupSentence(condition, metrics, measured),
    bookingSpeedSentence(condition, metrics, measured),
    // Last, on purpose: it qualifies the occupancy figure, and a reader
    // shouldn't have to step over it to reach the point.
    exclusionSentence(condition, metrics),
  ];
  return sentences.filter((s): s is string => s != null);
}

/** Same math as the engine's applyAdjustments — percent compounds, fixed adds. */
export function applyStep(
  price: number,
  action: NarrativeApplication["action"],
): number {
  const sign = action.direction === "increase" ? 1 : -1;
  const next =
    action.kind === "fixed"
      ? price + sign * action.value
      : price * (1 + (sign * action.value) / 100);
  return Math.round(next * 100) / 100;
}

/**
 * The engine clamps to the limit exactly, so "there" is almost always the
 * limit itself; if a row ever lands elsewhere, the number that shipped wins.
 */
function stoppedAt(limit: number, final: number, sym: string): string {
  return Math.round(Math.abs(final - limit) * 100) < 1
    ? "stopped there"
    : `stopped at ${money(final, sym)}`;
}

/** "10% raise" / "$5.00 cut", from the signed delta the audit stores. */
function retirementWords(delta: string): string {
  const raise = !delta.startsWith("-");
  return `${delta.replace(/^[+-]/, "")} ${raise ? "raise" : "cut"}`;
}

const RETIREMENT_REASONS: Record<NarrativeRetirement["reason"], string> = {
  bookings_cancelled: "enough of the bookings behind it cancelled",
  manual_price: "this night's price was set by hand",
  rule_edited: "the rule was edited, so MAYA started it fresh",
};

/**
 * Full story for one (room type, night): what came off, then the move each
 * rule made, each one followed by why it ran, plus a clamp sentence when a
 * floor/ceiling stepped in.
 */
export function narrateChange(input: NarrativeInput): string[] {
  const sym = input.currencySymbol ?? "$";
  const sentences: string[] = [];
  let running = input.base_price;

  for (const off of input.retirements ?? []) {
    sentences.push(
      `"${off.rule_name}" stopped applying an earlier ${retirementWords(off.delta)} here: ${RETIREMENT_REASONS[off.reason]}.`,
    );
  }

  input.applications.forEach((app, i) => {
    const before = running;
    running = applyStep(running, app.action);
    const verb = app.action.direction === "increase" ? "raised" : "lowered";
    const amount =
      app.action.kind === "percent" ? `${app.action.value}%` : money(app.action.value, sym);
    // A later rule's "from" price is the price the earlier one left, which is
    // how the stack shows itself without anyone having to say "stacked".
    // The same rule twice is one rule that fired again after its wait: one
    // verb per direction throughout, and "another" rather than an adverb
    // wedged between the verb and the amount.
    const opener =
      i === 0
        ? `"${app.rule_name}" ${verb} this night ${amount}`
        : app.repeat
          ? `Then "${app.rule_name}" ${verb} it another ${amount}`
          : `Then "${app.rule_name}" ${verb} it ${amount}`;
    sentences.push(`${opener}, from ${money(before, sym)} to ${money(running, sym)}.`);
    // A repeat's conditions were read on the run it fired, not this one, so
    // only the fire this run made carries a "why" it can stand behind.
    if (!app.repeat || app.metrics) {
      sentences.push(...describeConditions(app.condition, app.metrics, app.measured_room_types));
    }
  });

  // A manual price over the ceiling or under the floor is the limit itself
  // for the rules on top of it (priceBounds): they stop at it, not at the
  // room type's own limit, which the price is already past.
  if (input.clamped_by === "ceiling" && input.ceiling_price != null && input.final_price > input.ceiling_price) {
    sentences.push(
      `That would have gone further past your ${money(input.ceiling_price, sym)} ceiling for ${input.room_type} than the price it started from, so it ${stoppedAt(input.base_price, input.final_price, sym)}.`,
    );
  } else if (input.clamped_by === "ceiling" && input.ceiling_price != null) {
    sentences.push(
      `That would have gone past your ${money(input.ceiling_price, sym)} ceiling for ${input.room_type}, so it ${stoppedAt(input.ceiling_price, input.final_price, sym)}.`,
    );
  } else if (input.clamped_by === "floor" && input.floor_price != null && input.final_price < input.floor_price) {
    sentences.push(
      `That would have gone further under your ${money(input.floor_price, sym)} floor for ${input.room_type} than the price it started from, so it ${stoppedAt(input.base_price, input.final_price, sym)}.`,
    );
  } else if (input.clamped_by === "floor" && input.floor_price != null) {
    sentences.push(
      `That would have dropped under your ${money(input.floor_price, sym)} floor for ${input.room_type}, so it ${stoppedAt(input.floor_price, input.final_price, sym)}.`,
    );
  }

  if (sentences.length === 0) {
    sentences.push(
      `The rate moved from ${money(input.base_price, sym)} to ${money(input.final_price, sym)}.`,
    );
  }

  return sentences;
}

/** One-line headline for the entry: room, movement, direction. */
export function narrateHeadline(input: NarrativeInput): string {
  const sym = input.currencySymbol ?? "$";
  const delta = input.final_price - input.base_price;
  const arrow = delta >= 0 ? "up" : "down";
  const pctMove =
    input.base_price > 0
      ? `${Math.abs(Math.round((delta / input.base_price) * 1000) / 10)}%`
      : "";
  return `${input.room_type}: ${money(input.base_price, sym)} ${arrow} to ${money(input.final_price, sym)}${pctMove ? ` (${delta >= 0 ? "+" : "-"}${pctMove})` : ""}`;
}
