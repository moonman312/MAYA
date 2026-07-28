/**
 * Booking Speed — the first Layer 1 observation.
 *
 * Classifies how quickly a stay date is picking up bookings relative to what
 * comparable history says is normal. Rules and the UI consume ONLY the named
 * levels below; the ratio math, bands, and evidence guards in this file are
 * Observation Engine internals and must never appear in the rule builder.
 *
 * Design rules:
 * - The levels are an ordered vocabulary, not statistics. The underlying
 *   ratio is kept on the result for audit snapshots only.
 * - Bands are symmetric in log space: twice normal pace mirrors half normal
 *   pace, so slow and fast demand shocks are treated identically.
 * - The counts here are per stay date, not property-wide: bookings received
 *   FOR one arrival date during the recent window. At a small hotel, or for
 *   a date still far out, the expectation is a handful — often zero for the
 *   whole window. That is why the scale stops at seven levels (finer tiers
 *   would be labeling sub-one-booking noise) and why the evidence guards
 *   scale with the square root of the expectation: small counts are noisy
 *   in proportion, and a big ratio built on two bookings must stay quiet.
 *   Wrongly shouting on noise is how trust dies.
 * - A quiet expectation is not a blind spot: real pickup against an
 *   almost-zero expectation is exactly the far-out demand-shock signal
 *   (concert announced eight months ahead), and it classifies fast once it
 *   clears the same guards as everything else.
 */

export type BookingSpeed =
  | "stalled"
  | "much_slower"
  | "slower"
  | "normal"
  | "faster"
  | "much_faster"
  | "surging";

export interface BookingSpeedLevel {
  key: BookingSpeed;
  /** Ordinal position, -3 (stalled) through +3 (surging); 0 is normal. */
  rank: number;
  /** Human label shown in rules, explanations, and dropdowns. */
  label: string;
}

export const BOOKING_SPEED_LEVELS: BookingSpeedLevel[] = [
  { key: "stalled", rank: -3, label: "Stalled" },
  { key: "much_slower", rank: -2, label: "Much Slower Than Normal" },
  { key: "slower", rank: -1, label: "Slower Than Normal" },
  { key: "normal", rank: 0, label: "Normal" },
  { key: "faster", rank: 1, label: "Faster Than Normal" },
  { key: "much_faster", rank: 2, label: "Much Faster Than Normal" },
  { key: "surging", rank: 3, label: "Surging" },
];

const BY_KEY = new Map(BOOKING_SPEED_LEVELS.map((l) => [l.key, l]));
const BY_RANK = new Map(BOOKING_SPEED_LEVELS.map((l) => [l.rank, l]));

export function isBookingSpeed(value: unknown): value is BookingSpeed {
  return typeof value === "string" && BY_KEY.has(value as BookingSpeed);
}

export function bookingSpeedRank(speed: BookingSpeed): number {
  return BY_KEY.get(speed)!.rank;
}

export function bookingSpeedLabel(speed: BookingSpeed): string {
  return BY_KEY.get(speed)!.label;
}

/** True when `speed` is at least as fast as `floor` (ordinal compare). */
export function isSpeedAtLeast(speed: BookingSpeed, floor: BookingSpeed): boolean {
  return bookingSpeedRank(speed) >= bookingSpeedRank(floor);
}

/** True when `speed` is at most as fast as `ceiling` (ordinal compare). */
export function isSpeedAtMost(speed: BookingSpeed, ceiling: BookingSpeed): boolean {
  return bookingSpeedRank(speed) <= bookingSpeedRank(ceiling);
}

/* ── Classification internals (never surfaced to the rule builder) ── */

/**
 * Band edges as multiples of expected pace. The slow side uses the
 * reciprocals, which keeps the scale symmetric in log space: recent/expected
 * of 2 lands exactly as far from Normal as 1/2 does.
 */
export const SPEED_BAND_MULTIPLES = {
  faster: 1.25,
  muchFaster: 2,
  surging: 3.5,
} as const;

/**
 * Evidence guards. Count noise scales with the square root of the count
 * (Poisson-style), so the deviation required before we leave Normal does
 * too: leaving Normal needs |recent - expected| of at least
 * Z_LEAVE_NORMAL * sqrt(expected), and the extreme calls (Stalled, Surging)
 * need Z_EXTREME * sqrt(expected) or they demote one step inward. The
 * absolute floors carry the tiny expectations — 2 observed vs 0.9 expected
 * is "more than double" and also just one extra booking.
 */
export const Z_LEAVE_NORMAL = 1.5;
export const Z_EXTREME = 2;
export const MIN_DELTA_LEAVE_NORMAL = 2;
export const MIN_DELTA_EXTREME = 4;

/**
 * Expected pace is floored here for the ratio so a genuinely quiet
 * comparable set (expected near zero) doesn't divide to infinity. Real
 * pickup against near-zero expectation still classifies fast — it just has
 * to clear the delta guards like everything else.
 */
export const EXPECTED_FLOOR = 0.5;

/**
 * With fewer comparable dates than this behind the expectation, the call is
 * capped one step from Normal in either direction.
 */
export const MIN_COMPARABLES_FULL_RANGE = 3;

export type BookingSpeedGuard =
  | "none"
  /** Deviation within normal noise for this volume — snapped back to Normal. */
  | "small_difference"
  /** Stalled/Surging demoted one step: not enough deviation for the strongest call. */
  | "extreme_demoted"
  /** Capped one step from Normal: too few comparable dates. */
  | "few_comparables";

export interface BookingSpeedInput {
  /** Net bookings the stay date gained in the recent window (may be negative). */
  recentBookings: number;
  /** Bookings comparable past dates gained in the matching window. */
  expectedBookings: number;
  /** How many comparable dates produced the expectation, when known. */
  comparableCount?: number;
}

export interface BookingSpeedClassification {
  speed: BookingSpeed;
  rank: number;
  label: string;
  /** recent/expected with the floor applied, 2dp — for audit snapshots. */
  ratio: number;
  /** Absolute booking-count difference, 2dp — for audit snapshots. */
  difference: number;
  /** Which evidence guard, if any, changed the raw ratio-band verdict. */
  guard: BookingSpeedGuard;
  recentBookings: number;
  expectedBookings: number;
}

function rankFromRatio(ratio: number): number {
  const { faster, muchFaster, surging } = SPEED_BAND_MULTIPLES;
  if (ratio >= surging) return 3;
  if (ratio >= muchFaster) return 2;
  if (ratio >= faster) return 1;
  if (ratio <= 1 / surging) return -3;
  if (ratio <= 1 / muchFaster) return -2;
  if (ratio <= 1 / faster) return -1;
  return 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function classifyBookingSpeed(input: BookingSpeedInput): BookingSpeedClassification {
  const recent = input.recentBookings;
  const expected = Math.max(0, input.expectedBookings);
  const ratio = Math.max(recent, 0) / Math.max(expected, EXPECTED_FLOOR);
  const difference = Math.abs(recent - expected);

  const noise = Math.sqrt(expected);
  const leaveNormalDelta = Math.max(MIN_DELTA_LEAVE_NORMAL, Z_LEAVE_NORMAL * noise);
  const extremeDelta = Math.max(MIN_DELTA_EXTREME, Z_EXTREME * noise);

  const rawRank = rankFromRatio(ratio);
  let rank = rawRank;
  let guard: BookingSpeedGuard = "none";

  if (difference < leaveNormalDelta) {
    // Only report a guard when it actually suppressed a signal; with
    // identical counts the raw verdict is an artifact of the ratio floor.
    if (rawRank !== 0 && difference > 0) guard = "small_difference";
    rank = 0;
  } else {
    if (Math.abs(rank) === 3 && difference < extremeDelta) {
      rank = Math.sign(rank) * 2;
      guard = "extreme_demoted";
    }
    const comparables = input.comparableCount;
    if (
      comparables != null &&
      comparables < MIN_COMPARABLES_FULL_RANGE &&
      Math.abs(rank) > 1
    ) {
      rank = Math.sign(rank);
      guard = "few_comparables";
    }
  }

  const level = BY_RANK.get(rank)!;
  return {
    speed: level.key,
    rank,
    label: level.label,
    ratio: round2(ratio),
    difference: round2(difference),
    guard,
    recentBookings: recent,
    expectedBookings: round2(expected),
  };
}

/* ── Level 1 narrative ────────────────────────────────────────── */

export interface DescribeBookingSpeedOptions {
  /** Length of the recent-pickup window the counts came from. Default 7. */
  windowDays?: number;
}

/**
 * The Level 1 explanation: what we saw, what we expected, what we call it.
 * Plain words only — no comparison symbols, ratios, or band thresholds.
 */
export function describeBookingSpeed(
  c: BookingSpeedClassification,
  opts: DescribeBookingSpeedOptions = {},
): string {
  const windowDays = opts.windowDays ?? 7;
  const windowPhrase = `in the last ${windowDays} days`;

  let observed: string;
  if (c.recentBookings < 0) {
    observed = `This stay date has lost more bookings than it gained ${windowPhrase}.`;
  } else if (c.recentBookings === 0) {
    observed = `This stay date has received no bookings ${windowPhrase}.`;
  } else if (Math.round(c.recentBookings) === 1) {
    observed = `This stay date has received 1 booking ${windowPhrase}.`;
  } else {
    observed = `This stay date has received ${Math.round(c.recentBookings)} bookings ${windowPhrase}.`;
  }

  const expected =
    c.expectedBookings < 1
      ? "Based on similar past dates, we expected almost none."
      : `Based on similar past dates, we expected about ${Math.round(c.expectedBookings)}.`;

  const verdict = `Booking speed is ${c.label}.`;

  let caveat = "";
  if (c.guard === "small_difference") {
    caveat =
      " That difference is within the normal ups and downs for a date like this, so we call it Normal.";
  } else if (c.guard === "few_comparables") {
    caveat =
      " We only have a few similar past dates to compare against, so we keep the call conservative.";
  } else if (c.guard === "extreme_demoted") {
    caveat =
      " The difference is not quite big enough for the strongest call, so we hold back one step.";
  }

  return `${observed} ${expected} ${verdict}${caveat}`;
}
