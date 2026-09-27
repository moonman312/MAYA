/**
 * Expected bookings — turning a comparable set into a Booking Speed call.
 *
 * For a target stay date T seen from as-of date A, the recent pickup is the
 * count of bookings for T made in the last `windowDays`. A booking is a
 * reservation, however many rooms it holds: a 20-room wedding counts once,
 * here and on every comparable (booking-rows.ts bookingKeyOf). Each comparable
 * date is measured over the SAME stretch of its own booking curve (the same
 * days-until-arrival band), so a date 40 days out is compared with how its
 * peers were booking when THEY were 40 days out. The expectation is a
 * trimmed mean over the comparables, and often fractional — 0.4 expected
 * bookings is an honest statement about a quiet far-out date, not an error.
 *
 * Only comparables with actual reservation history behind them count —
 * a comparable date with zero ROWS is "we don't know", not "zero bookings",
 * and must not silently dilute the expectation as if it were real evidence.
 *
 * A real, day-of-week/season-matched comparable is better evidence than a
 * calendar-neighbor proxy, even when there are very few of them, so this
 * only reaches for the momentum fallback (momentum.ts — how nearby dates
 * are pacing right now versus a year ago) when NO usable comparable exists
 * at all; the classifier's own thin-history guard already keeps a call
 * built from just 1-4 real comparables appropriately conservative. Only
 * when even momentum has nothing to go on does this report
 * `insufficient_data` rather than guess.
 *
 * The stretch counted ends on the as-of date, today so far, or with
 * `completeDays` on the day before it: only complete hotel days, on the
 * target and every comparable (and momentum) alike. A rule that cuts reads
 * it that way (Jake, 2026-09-17: slowdown checks count full hotel days
 * ending yesterday, speed-up checks may count today so far, since a partial
 * day can only undercount and a "faster" reading is then real).
 *
 * A rule that already adjusted a night passes `countFrom`: only bookings
 * made from that date on count on the target, and the stretch counted
 * shrinks to the days from it to the stretch's last day, so a rule never
 * re-counts the bookings it already acted on. With `split` (a raise rule),
 * countFrom is the day of the fire itself and that day counts only the
 * bookings first seen after the fire (the rest of it, in effect), so the
 * bookings the fire could not have counted are not lost with it. A cut
 * rule never splits a day: it counts the complete days after its fire's.
 *
 * What those bookings are compared with, the bar, is one of two:
 *
 * - With `wholeWindowBar` (a rule that raises on "at least" a pace, engine
 *   booking-speed-provider.ts keepsWholeWindowBar), the whole window: the
 *   comparables (and momentum) are read over the full `windowDays`, so
 *   "much faster in a week" still needs about twice what a night like it
 *   gets in a whole week, from the bookings since the change alone (Jake's
 *   examples, 2026-09-24: 10 bookings at once raise the rule for 10, 3 more
 *   after that don't raise the rule for 5, and 5 more do). Read over the
 *   few hours or days since the change, where the comparables expect
 *   about 0 or 1, those 3 would read much faster. A shorter stretch can
 *   only count fewer bookings against the same bar, so it can only make
 *   "at least" a pace harder to reach.
 * - Otherwise the same days: the comparables (and momentum) are read over
 *   the stretch counted, on their own booking curves. A cut rule reads it
 *   so, and so does a raise rule on "at most" or "exactly" a pace: against
 *   a whole window's usual, a few days would read slow, which would make
 *   those conditions easier to meet, not harder.
 *
 * Counts reflect currently known reservations from the slim import rows:
 * a canceled booking disappears rather than counting negative. Pure
 * functions; the caller supplies rows and dates.
 */

import { addDays, daysBetween } from "./calendar.ts";
import {
  classifyBookingSpeed,
  describeBookingSpeed,
  type BookingSpeedClassification,
} from "./booking-speed.ts";
import { describeComparableSelection, type ComparableSelection } from "./comparable-dates.ts";
import {
  DEFAULT_WINDOW_DAYS,
  hasAnyRowIndexed,
  indexBookingRows,
  pickupInWindowIndexed,
  round2,
  trimmedMean,
  type BookingWindowIndex,
  type SlimReservationRow,
} from "./booking-rows.ts";
import {
  MOMENTUM_ASSUMED_COMPARABLE_COUNT,
  describeMomentum,
  estimateMomentumFallback,
  type MomentumEstimate,
} from "./momentum.ts";

export { DEFAULT_WINDOW_DAYS, pickupInWindow, trimmedMean, type SlimReservationRow } from "./booking-rows.ts";

export type BookingSpeedMethod = "comparable" | "momentum" | "insufficient_data";

export interface ComparablePickup {
  date: string;
  bookings: number;
  tier: number;
  reasons: string[];
  /** False when this comparable has no reservation history at all — "we don't know", not "zero bookings". */
  hasData: boolean;
}

export interface BookingSpeedObservation {
  target: string;
  asOf: string;
  daysOut: number;
  windowDays: number;
  recentBookings: number;
  expectedBookings: number;
  /** How the expectation was derived — governs which Level 2 explanation applies. */
  method: BookingSpeedMethod;
  /** Every comparable the matcher found, including any with no data (for audit purposes — see hasData). */
  perComparable: ComparablePickup[];
  /** Present only when method === "momentum". */
  momentum?: MomentumEstimate;
  selection: ComparableSelection;
  classification: BookingSpeedClassification;
  /**
   * The room types counted, when a rule measures only some of the hotel's.
   * Absent for the hotel-wide observation (every room type that counts as a
   * room), which is also how every snapshot written before this field reads.
   */
  measuredRoomTypeIds?: string[];
  /**
   * Set only when `countFrom` cut the window short, or split its first day:
   * the first booking date counted. windowDays is then the stretch counted
   * on the target, and on the comparables too unless expectedOverFullWindow.
   */
  countedFrom?: string;
  /** The window the rule asked for, set together with countedFrom. */
  fullWindowDays?: number;
  /**
   * With countedFrom, when `wholeWindowBar` applied: the comparables and
   * momentum were read over fullWindowDays, so expectedBookings is what a
   * night like it gets in the whole window, the bar the bookings since
   * countedFrom had to beat on their own. Absent: they were read over
   * windowDays, the same days as the target.
   */
  expectedOverFullWindow?: true;
  /**
   * With countedFrom, when `split` applied: the fire countedFrom is the day
   * of. On that day only the target's bookings first seen after this
   * instant were counted; the comparables read the day whole. A snapshot
   * without it counted countedFrom's day whole (the engine then passed the
   * day after the fire).
   */
  countedSince?: string;
  /**
   * With countedFrom: whether the fire the count starts after was a raise or
   * a cut, the rule's own last one on the night (engine/pickup.ts
   * bookingSpeedCountFrom). Stamped by the engine, not here.
   */
  countedAfter?: "raise" | "cut";
  /**
   * Set only with `completeDays`: the last booking date counted, the day
   * before asOf. The stretch is windowDays complete days ending there, on
   * the target and every comparable alike. Absent: it ended on asOf, today
   * so far.
   */
  countedThrough?: string;
}

export interface ObserveBookingSpeedOptions {
  rows?: SlimReservationRow[];
  /**
   * The same history already grouped by stay date and booking window (see
   * indexBookingRows). Used instead of `rows` when given; the answer is the
   * same either way. It must cover every date this observation can consult:
   * the target, its comparables, and momentum's neighbors and their
   * year-ago dates.
   */
  index?: BookingWindowIndex;
  target: string;
  asOf: string;
  selection: ComparableSelection;
  windowDays?: number;
  /**
   * Count complete hotel days only: the stretch ends on the day before
   * asOf instead of on asOf itself, on the target and on every comparable
   * (and momentum). A rule that cuts reads pace this way.
   */
  completeDays?: boolean;
  /**
   * Count only bookings made on or after this date (YYYY-MM-DD) on the
   * target: the days from it to the stretch's last day (lastCountedDay),
   * never longer than windowDays, and at least one day (see
   * windowDaysFrom). The comparables and momentum read the same days, or
   * with wholeWindowBar the whole window. Null or older than the window's
   * first day: the whole window, exactly as without it.
   */
  countFrom?: string | null;
  /**
   * With countFrom, the fire it is the day of: `since` is when the fire was
   * applied and `index` holds the target's bookings first seen after it,
   * grouped like `index` (StayDateWindowsBuilder with since). When the
   * window starts on countFrom (countFromInWindow), that day counts only
   * those on the target and every later day counts whole from `index`; the
   * comparables (and momentum) read countFrom's day whole, like the rest.
   * When the window starts after countFrom the split is not reached and
   * changes nothing. Without it countFrom's whole day counts. Never with
   * completeDays: a complete day is never split.
   */
  split?: { since: string; index: BookingWindowIndex } | null;
  /**
   * With countFrom inside the window: read the comparables (and momentum)
   * over the whole windowDays instead of the stretch counted on the
   * target, so the bookings since countFrom must beat what a night like it
   * gets in a whole window on their own. For a rule that raises on "at
   * least" a pace, which fewer bookings can only make harder to reach.
   * Never with completeDays: a cut compares the same days on both sides.
   */
  wholeWindowBar?: boolean;
  /** Same exclusion predicate passed to selectComparableDates — reused for momentum's neighbor search. */
  isExcluded?: (date: string) => boolean;
}

/**
 * The last booking date a reading counts: `asOf` itself (today so far), or
 * with `completeDays` the day before it, so only complete hotel days count.
 */
export function lastCountedDay(asOf: string, completeDays = false): string {
  return completeDays ? addDays(asOf, -1) : asOf;
}

/**
 * Days of a trailing `windowDays` window ending on `last` (lastCountedDay)
 * that fall on or after `countFrom`: the whole window when countFrom is null
 * or older than the window's first day, fewer when it starts inside it, 0
 * when it is after `last`. Bookings carry a date, not a time, so a whole day
 * is the unit.
 */
export function windowDaysFrom(windowDays: number, last: string, countFrom?: string | null): number {
  if (!countFrom) return windowDays;
  return Math.max(0, Math.min(windowDays, daysBetween(countFrom, last) + 1));
}

/**
 * True when `countFrom` is one of the days of a trailing `windowDays`
 * window ending on `last`, so the window's first day is countFrom's day:
 * the day a split (see ObserveBookingSpeedOptions.split) applies to. False
 * for null, for a date before the window, and for one after `last`.
 */
export function countFromInWindow(windowDays: number, last: string, countFrom?: string | null): boolean {
  if (!countFrom) return false;
  const days = daysBetween(countFrom, last) + 1;
  return days >= 1 && days <= windowDays;
}

/**
 * The full Layer 1 pipeline for one stay date: recent pickup, comparable
 * pickup (or momentum fallback), and the classified Booking Speed. The
 * returned object is the audit snapshot — persist it with the evaluation so
 * explanations replay what was actually known, not what is known later.
 */
export function observeBookingSpeed(opts: ObserveBookingSpeedOptions): BookingSpeedObservation {
  const fullWindowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const daysOut = daysBetween(opts.asOf, opts.target);
  if (daysOut < 0) {
    throw new Error("booking speed target must not be in the past");
  }
  // The stretch ends on asOf, or on the day before with completeDays: `end`
  // days before asOf, on the target and on every date it is compared with.
  const completeDays = opts.completeDays === true;
  const end = completeDays ? 1 : 0;
  const last = lastCountedDay(opts.asOf, completeDays);
  // The stretch counted on the target: bookings made from countFrom on.
  const windowDays = windowDaysFrom(fullWindowDays, last, opts.countFrom);
  if (windowDays < 1) {
    throw new Error("booking speed countFrom must leave at least one day to count");
  }
  if (completeDays && opts.split) {
    throw new Error("booking speed never splits a complete day");
  }
  if (completeDays && opts.wholeWindowBar) {
    throw new Error("booking speed reads complete days against the same days");
  }
  // The split is reached only when the window's first day is countFrom's.
  const split = opts.split && countFromInWindow(fullWindowDays, last, opts.countFrom) ? opts.split : null;
  const counted = windowDays < fullWindowDays || split !== null;
  // What a night like it usually gets, the bar: over the same days as the
  // target, or with wholeWindowBar over the whole window, so the bookings
  // since countFrom must beat a whole window's usual on their own.
  const whole = counted && opts.wholeWindowBar === true;
  const expectedDays = whole ? fullWindowDays : windowDays;
  const cut = counted
    ? {
        countedFrom: opts.countFrom!,
        fullWindowDays,
        ...(split ? { countedSince: split.since } : {}),
        ...(whole ? { expectedOverFullWindow: true as const } : {}),
      }
    : {};
  const through = completeDays ? { countedThrough: last } : {};

  const index = opts.index ?? indexBookingRows(opts.rows ?? []);

  // With a split, the first day (the fire's) counts only the bookings first
  // seen after the fire, from the split's index; the later days count whole.
  const recentBookings = split
    ? pickupInWindowIndexed(index, opts.target, daysOut + end, windowDays - 1) +
      pickupInWindowIndexed(split.index, opts.target, daysOut + end + windowDays - 1, 1)
    : pickupInWindowIndexed(index, opts.target, daysOut + end, windowDays);

  const perComparable: ComparablePickup[] = opts.selection.comparables.map((c) => ({
    date: c.date,
    bookings: pickupInWindowIndexed(index, c.date, daysOut + end, expectedDays),
    tier: c.tier,
    reasons: c.reasons,
    hasData: hasAnyRowIndexed(index, c.date),
  }));
  const usableComparables = perComparable.filter((c) => c.hasData);

  const base = {
    target: opts.target,
    asOf: opts.asOf,
    daysOut,
    windowDays,
    recentBookings,
    perComparable,
    selection: opts.selection,
    ...cut,
    ...through,
  };

  if (usableComparables.length > 0) {
    const expectedBookings = round2(trimmedMean(usableComparables.map((c) => c.bookings)));
    return {
      ...base,
      expectedBookings,
      method: "comparable",
      classification: classifyBookingSpeed({
        recentBookings,
        expectedBookings,
        comparableCount: usableComparables.length,
      }),
    };
  }

  const momentum = estimateMomentumFallback({
    index,
    target: opts.target,
    asOf: opts.asOf,
    windowDays: expectedDays,
    endOffset: end,
    isExcluded: opts.isExcluded,
  });

  if (momentum) {
    return {
      ...base,
      expectedBookings: momentum.expectedBookings,
      method: "momentum",
      momentum,
      classification: classifyBookingSpeed({
        recentBookings,
        expectedBookings: momentum.expectedBookings,
        comparableCount: MOMENTUM_ASSUMED_COMPARABLE_COUNT,
      }),
    };
  }

  // Truly nothing to go on: stay honest rather than guess.
  return {
    ...base,
    expectedBookings: 0,
    method: "insufficient_data",
    classification: classifyBookingSpeed({ recentBookings, expectedBookings: 0, comparableCount: 0 }),
  };
}

/* ── Explainability ──────────────────────────────────────────── */

/** "day", "week", "month" or "N days": a window's length in words. */
function spanWords(days: number): string {
  return days === 1 ? "day" : days === 7 ? "week" : days === 30 ? "month" : `${days} days`;
}

/**
 * Level 1: the classification sentence for this observation's window. A
 * reading that counted from a change says so, and says the expectation
 * covers the whole window when it does (expectedOverFullWindow).
 */
export function describeObservation(obs: BookingSpeedObservation): string {
  const counted = obs.countedFrom
    ? obs.countedThrough
      ? `in the ${obs.windowDays === 1 ? "full day" : `${obs.windowDays} full days`} since the latest cut still on the night`
      : "since the latest raise still on the night"
    : null;
  if (obs.method === "insufficient_data") {
    const seen =
      obs.recentBookings === 0
        ? "has not received any bookings"
        : obs.recentBookings === 1
          ? "has received 1 booking"
          : `has received ${obs.recentBookings} bookings`;
    return `This stay date ${seen} ${counted ?? `in the last ${obs.windowDays} days`}. We do not have enough history yet to say whether that pace is unusual.`;
  }
  const expectedOver =
    obs.expectedOverFullWindow && obs.fullWindowDays ? `in a whole ${spanWords(obs.fullWindowDays)}` : undefined;
  return describeBookingSpeed(obs.classification, {
    windowDays: obs.windowDays,
    ...(counted ? { windowPhrase: counted } : {}),
    ...(expectedOver ? { expectedOver } : {}),
  });
}

/** Level 2: where the expectation came from, in plain words. */
export function describeExpectation(obs: BookingSpeedObservation): string {
  if (obs.method === "momentum" && obs.momentum) {
    return describeMomentum(obs.momentum);
  }
  if (obs.method === "insufficient_data") {
    return "We do not have enough booking history yet for this date or its neighbors, so we are not calling out its pace as unusual either way.";
  }
  const n = obs.perComparable.filter((c) => c.hasData).length;
  const dates = n === 1 ? "1 similar past date" : `${n} similar past dates`;
  const lead =
    obs.expectedBookings < 1
      ? `Dates like this usually pick up almost no bookings ${obs.daysOut} days before arrival, based on ${dates}.`
      : `We expected about ${Math.round(obs.expectedBookings)} bookings, the typical pace across ${dates} at ${obs.daysOut} days before arrival.`;
  return `${lead} ${describeComparableSelection(obs.selection)}`;
}
