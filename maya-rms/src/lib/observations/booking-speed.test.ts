import { describe, expect, it } from "vitest";
import {
  BOOKING_SPEED_LEVELS,
  MIN_COMPARABLES_FULL_RANGE,
  MIN_DELTA_EXTREME,
  MIN_DELTA_LEAVE_NORMAL,
  SPEED_BAND_MULTIPLES,
  Z_EXTREME,
  Z_LEAVE_NORMAL,
  bookingSpeedLabel,
  bookingSpeedRank,
  classifyBookingSpeed,
  describeBookingSpeed,
  isBookingSpeed,
  isSpeedAtLeast,
  isSpeedAtMost,
} from "../../../supabase/functions/_shared/observations/booking-speed";

const NO_MATH_SYMBOLS = /[<>]/;

describe("booking speed vocabulary", () => {
  it("has seven levels with ranks -3..3 strictly increasing and Normal at 0", () => {
    expect(BOOKING_SPEED_LEVELS).toHaveLength(7);
    const ranks = BOOKING_SPEED_LEVELS.map((l) => l.rank);
    expect(ranks).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(BOOKING_SPEED_LEVELS[3].key).toBe("normal");
  });

  it("has unique keys and labels, none containing math symbols", () => {
    const keys = new Set(BOOKING_SPEED_LEVELS.map((l) => l.key));
    const labels = new Set(BOOKING_SPEED_LEVELS.map((l) => l.label));
    expect(keys.size).toBe(7);
    expect(labels.size).toBe(7);
    for (const l of BOOKING_SPEED_LEVELS) {
      expect(l.label).not.toMatch(NO_MATH_SYMBOLS);
    }
  });

  it("validates keys with isBookingSpeed", () => {
    expect(isBookingSpeed("much_faster")).toBe(true);
    expect(isBookingSpeed("slightly_faster")).toBe(false);
    expect(isBookingSpeed("way_too_fast")).toBe(false);
    expect(isBookingSpeed(2)).toBe(false);
    expect(isBookingSpeed(null)).toBe(false);
  });

  it("supports ordinal comparisons for rule conditions", () => {
    expect(isSpeedAtLeast("much_faster", "faster")).toBe(true);
    expect(isSpeedAtLeast("faster", "faster")).toBe(true);
    expect(isSpeedAtLeast("slower", "faster")).toBe(false);
    expect(isSpeedAtMost("stalled", "slower")).toBe(true);
    expect(isSpeedAtMost("surging", "normal")).toBe(false);
    expect(bookingSpeedRank("surging")).toBe(3);
    expect(bookingSpeedLabel("stalled")).toBe("Stalled");
  });
});

describe("classifyBookingSpeed bands", () => {
  // Expected 100 keeps every band edge clear of the evidence guards, so
  // these are pure band checks; realistic per-stay-date counts are covered
  // in the guard suite below.
  const at = (recent: number, expected = 100) =>
    classifyBookingSpeed({ recentBookings: recent, expectedBookings: expected });

  it("classifies the doc's canonical example: 9 recent vs 4.3 expected", () => {
    const c = classifyBookingSpeed({ recentBookings: 9, expectedBookings: 4.3 });
    expect(c.speed).toBe("much_faster");
    expect(c.guard).toBe("none");
  });

  it("maps ratio bands on the fast side", () => {
    expect(at(124).speed).toBe("normal");
    expect(at(125).speed).toBe("faster"); // boundary inclusive
    expect(at(199).speed).toBe("faster");
    expect(at(200).speed).toBe("much_faster");
    expect(at(349).speed).toBe("much_faster");
    expect(at(350).speed).toBe("surging");
  });

  it("maps ratio bands on the slow side", () => {
    expect(at(81).speed).toBe("normal");
    expect(at(80).speed).toBe("slower"); // boundary mirrors 125 on the fast side
    expect(at(51).speed).toBe("slower");
    expect(at(50).speed).toBe("much_slower");
    expect(at(29).speed).toBe("much_slower");
    expect(at(28).speed).toBe("stalled");
    expect(at(0).speed).toBe("stalled");
  });

  it("is symmetric in log space: ratio r and 1/r land equally far from Normal", () => {
    for (const [fast, slow] of [
      [125, 80],
      [200, 50],
      [350, 28],
    ] as const) {
      expect(at(fast).rank).toBe(-at(slow).rank);
    }
  });

  it("never decreases rank as recent bookings climb", () => {
    for (const expected of [1, 3, 10, 100]) {
      let last = -3;
      for (let recent = 0; recent <= expected * 6; recent++) {
        const rank = classifyBookingSpeed({
          recentBookings: recent,
          expectedBookings: expected,
        }).rank;
        expect(rank).toBeGreaterThanOrEqual(last);
        last = rank;
      }
    }
  });
});

describe("classifyBookingSpeed evidence guards", () => {
  it("scales the leave-Normal bar with volume: same percentage bump, different call", () => {
    // A 31% bump on a 16-booking expectation is 5 bookings — inside
    // sqrt-noise, so it stays Normal.
    const small = classifyBookingSpeed({ recentBookings: 21, expectedBookings: 16 });
    expect(small.speed).toBe("normal");
    expect(small.guard).toBe("small_difference");
    // One more booking clears the noise bar and the call lands.
    const cleared = classifyBookingSpeed({ recentBookings: 22, expectedBookings: 16 });
    expect(cleared.speed).toBe("faster");
    expect(cleared.guard).toBe("none");
    // The same 31% bump on a 400-booking expectation is 125 bookings —
    // far beyond noise at that volume.
    const big = classifyBookingSpeed({ recentBookings: 525, expectedBookings: 400 });
    expect(big.speed).toBe("faster");
    expect(big.guard).toBe("none");
  });

  it("keeps tiny numbers Normal even at big ratios", () => {
    // "More than double the pace" that is also just one extra booking.
    const c = classifyBookingSpeed({ recentBookings: 2, expectedBookings: 0.9 });
    expect(c.speed).toBe("normal");
    expect(c.guard).toBe("small_difference");
  });

  it("stays quiet on far-out dates where nothing was expected and nothing came", () => {
    expect(classifyBookingSpeed({ recentBookings: 0, expectedBookings: 0 }).speed).toBe("normal");
    expect(classifyBookingSpeed({ recentBookings: 0, expectedBookings: 0 }).guard).toBe("none");
    expect(classifyBookingSpeed({ recentBookings: 0, expectedBookings: 0.3 }).speed).toBe("normal");
  });

  it("treats one stray booking against an empty expectation as Normal", () => {
    const c = classifyBookingSpeed({ recentBookings: 1, expectedBookings: 0 });
    expect(c.speed).toBe("normal");
  });

  it("flags real pickup against an empty expectation as the far-out shock signal", () => {
    // Two bookings from nothing: a real signal, held one step back.
    const two = classifyBookingSpeed({ recentBookings: 2, expectedBookings: 0 });
    expect(two.speed).toBe("much_faster");
    expect(two.guard).toBe("extreme_demoted");
    // Five bookings from nothing: the concert-just-announced case.
    const five = classifyBookingSpeed({ recentBookings: 5, expectedBookings: 0 });
    expect(five.speed).toBe("surging");
  });

  it("demotes Stalled to Much Slower when little was expected anyway", () => {
    const c = classifyBookingSpeed({ recentBookings: 0, expectedBookings: 2.5 });
    expect(c.speed).toBe("much_slower");
    expect(c.guard).toBe("extreme_demoted");
  });

  it("calls a genuinely dead date Stalled", () => {
    const c = classifyBookingSpeed({ recentBookings: 0, expectedBookings: 6 });
    expect(c.speed).toBe("stalled");
    expect(c.guard).toBe("none");
  });

  it("handles negative net pickup (cancellations outpaced bookings)", () => {
    const c = classifyBookingSpeed({ recentBookings: -3, expectedBookings: 3 });
    expect(c.speed).toBe("stalled");
    expect(c.ratio).toBe(0);
  });

  it("caps the call one step from Normal on thin comparable history", () => {
    const c = classifyBookingSpeed({
      recentBookings: 9,
      expectedBookings: 4,
      comparableCount: MIN_COMPARABLES_FULL_RANGE - 1,
    });
    expect(c.speed).toBe("faster");
    expect(c.guard).toBe("few_comparables");
  });

  it("caps the slow side on thin history too", () => {
    const c = classifyBookingSpeed({
      recentBookings: 0,
      expectedBookings: 8,
      comparableCount: 1,
    });
    expect(c.speed).toBe("slower");
    expect(c.guard).toBe("few_comparables");
  });

  it("does not cap when comparable history is adequate", () => {
    const c = classifyBookingSpeed({
      recentBookings: 9,
      expectedBookings: 4,
      comparableCount: MIN_COMPARABLES_FULL_RANGE,
    });
    expect(c.speed).toBe("much_faster");
    expect(c.guard).toBe("none");
  });

  it("exposes guard thresholds as sane exported constants", () => {
    expect(Z_LEAVE_NORMAL).toBeLessThan(Z_EXTREME);
    expect(MIN_DELTA_LEAVE_NORMAL).toBeLessThan(MIN_DELTA_EXTREME);
    expect(SPEED_BAND_MULTIPLES.faster).toBeGreaterThan(1);
    expect(SPEED_BAND_MULTIPLES.muchFaster).toBeGreaterThan(SPEED_BAND_MULTIPLES.faster);
    expect(SPEED_BAND_MULTIPLES.surging).toBeGreaterThan(SPEED_BAND_MULTIPLES.muchFaster);
  });
});

describe("describeBookingSpeed narrative", () => {
  it("reads like the doc's Level 1 example", () => {
    const c = classifyBookingSpeed({ recentBookings: 9, expectedBookings: 4.3 });
    const s = describeBookingSpeed(c, { windowDays: 14 });
    expect(s).toContain("received 9 bookings in the last 14 days");
    expect(s).toContain("we expected about 4");
    expect(s).toContain("Booking speed is Much Faster Than Normal.");
  });

  it("defaults to a 7 day window", () => {
    const c = classifyBookingSpeed({ recentBookings: 12, expectedBookings: 6 });
    const s = describeBookingSpeed(c);
    expect(s).toContain("received 12 bookings in the last 7 days");
    expect(s).toContain("we expected about 6");
  });

  it("handles zero and singular booking counts", () => {
    const none = classifyBookingSpeed({ recentBookings: 0, expectedBookings: 6 });
    expect(describeBookingSpeed(none)).toContain("received no bookings");
    const one = classifyBookingSpeed({ recentBookings: 1, expectedBookings: 1 });
    expect(describeBookingSpeed(one)).toContain("received 1 booking in");
    expect(describeBookingSpeed(one)).not.toContain("1 bookings");
  });

  it("says almost none instead of a decimal expectation", () => {
    const c = classifyBookingSpeed({ recentBookings: 5, expectedBookings: 0.4 });
    const s = describeBookingSpeed(c);
    expect(s).toContain("we expected almost none");
    expect(s).not.toContain("0.4");
  });

  it("explains negative net pickup in words", () => {
    const c = classifyBookingSpeed({ recentBookings: -2, expectedBookings: 4 });
    expect(describeBookingSpeed(c)).toContain("lost more bookings than it gained");
  });

  it("adds a caveat sentence when a guard changed the call", () => {
    const small = classifyBookingSpeed({ recentBookings: 21, expectedBookings: 16 });
    expect(describeBookingSpeed(small)).toContain("so we call it Normal");
    const thin = classifyBookingSpeed({
      recentBookings: 9,
      expectedBookings: 4,
      comparableCount: 1,
    });
    expect(describeBookingSpeed(thin)).toContain("keep the call conservative");
    const demoted = classifyBookingSpeed({ recentBookings: 3, expectedBookings: 0 });
    expect(describeBookingSpeed(demoted)).toContain("hold back one step");
  });

  it("never emits math symbols across a broad input sweep", () => {
    for (const recent of [-5, 0, 1, 2, 3, 4, 7, 9, 15, 40, 120, 500]) {
      for (const expected of [0, 0.4, 1, 2.5, 4.3, 8, 16, 100, 400]) {
        for (const comparableCount of [undefined, 1, 6]) {
          const c = classifyBookingSpeed({
            recentBookings: recent,
            expectedBookings: expected,
            comparableCount,
          });
          expect(describeBookingSpeed(c)).not.toMatch(NO_MATH_SYMBOLS);
          expect(describeBookingSpeed(c, { windowDays: 14 })).not.toMatch(NO_MATH_SYMBOLS);
        }
      }
    }
  });
});
