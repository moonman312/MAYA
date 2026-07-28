import { describe, expect, it } from "vitest";
import {
  BOOKING_SPEED_LEVELS,
  MIN_COMPARABLES_FULL_RANGE,
  MIN_DELTA_EXTREME,
  MIN_DELTA_LEAVE_NORMAL,
  SPEED_BAND_MULTIPLES,
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
  // Large counts so no evidence guard interferes with pure band checks.
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
  it("keeps tiny numbers Normal even at big ratios", () => {
    // "More than double the pace" that is also just one extra booking.
    const c = classifyBookingSpeed({ recentBookings: 2, expectedBookings: 0.9 });
    expect(c.speed).toBe("normal");
    expect(c.guard).toBe("small_difference");
  });

  it("treats nothing-expected-nothing-came as plain Normal", () => {
    const c = classifyBookingSpeed({ recentBookings: 0, expectedBookings: 0 });
    expect(c.speed).toBe("normal");
    expect(c.guard).toBe("none");
  });

  it("calls real pickup against an empty expectation Surging", () => {
    const c = classifyBookingSpeed({ recentBookings: 5, expectedBookings: 0 });
    expect(c.speed).toBe("surging");
  });

  it("demotes Surging to Much Faster when the difference is small", () => {
    const c = classifyBookingSpeed({ recentBookings: 3, expectedBookings: 0 });
    expect(c.speed).toBe("much_faster");
    expect(c.guard).toBe("extreme_demoted");
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
    const small = classifyBookingSpeed({ recentBookings: 2, expectedBookings: 0.9 });
    expect(describeBookingSpeed(small)).toContain("we treat that as Normal");
    const thin = classifyBookingSpeed({
      recentBookings: 9,
      expectedBookings: 4,
      comparableCount: 1,
    });
    expect(describeBookingSpeed(thin)).toContain("keep the call conservative");
  });

  it("never emits math symbols across a broad input sweep", () => {
    for (const recent of [-5, 0, 1, 2, 3, 4, 7, 9, 15, 40, 120]) {
      for (const expected of [0, 0.4, 1, 2.5, 4.3, 8, 20, 100]) {
        for (const comparableCount of [undefined, 1, 6]) {
          const c = classifyBookingSpeed({
            recentBookings: recent,
            expectedBookings: expected,
            comparableCount,
          });
          expect(describeBookingSpeed(c)).not.toMatch(NO_MATH_SYMBOLS);
          expect(describeBookingSpeed(c, { windowDays: 7 })).not.toMatch(NO_MATH_SYMBOLS);
        }
      }
    }
  });
});
