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
  it("has nine levels with ranks -4..4 strictly increasing and Normal at 0", () => {
    expect(BOOKING_SPEED_LEVELS).toHaveLength(9);
    const ranks = BOOKING_SPEED_LEVELS.map((l) => l.rank);
    expect(ranks).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
    expect(BOOKING_SPEED_LEVELS[4].key).toBe("normal");
  });

  it("has unique keys and labels, none containing math symbols", () => {
    const keys = new Set(BOOKING_SPEED_LEVELS.map((l) => l.key));
    const labels = new Set(BOOKING_SPEED_LEVELS.map((l) => l.label));
    expect(keys.size).toBe(9);
    expect(labels.size).toBe(9);
    for (const l of BOOKING_SPEED_LEVELS) {
      expect(l.label).not.toMatch(NO_MATH_SYMBOLS);
    }
  });

  it("validates keys with isBookingSpeed", () => {
    expect(isBookingSpeed("much_faster")).toBe(true);
    expect(isBookingSpeed("slightly_slower")).toBe(true);
    expect(isBookingSpeed("way_too_fast")).toBe(false);
    expect(isBookingSpeed(2)).toBe(false);
    expect(isBookingSpeed(null)).toBe(false);
  });

  it("supports ordinal comparisons for rule conditions", () => {
    expect(isSpeedAtLeast("much_faster", "faster")).toBe(true);
    expect(isSpeedAtLeast("faster", "faster")).toBe(true);
    expect(isSpeedAtLeast("slightly_faster", "faster")).toBe(false);
    expect(isSpeedAtLeast("slower", "faster")).toBe(false);
    expect(isSpeedAtMost("stalled", "slower")).toBe(true);
    expect(isSpeedAtMost("surging", "normal")).toBe(false);
    expect(bookingSpeedRank("surging")).toBe(4);
    expect(bookingSpeedLabel("stalled")).toBe("Stalled");
  });
});

describe("classifyBookingSpeed bands", () => {
  // Expected 400 = the high end of a normal 7-day window; at this volume the
  // evidence guards are live from the first band edge, so these are pure
  // band checks.
  const at = (recent: number, expected = 400) =>
    classifyBookingSpeed({ recentBookings: recent, expectedBookings: expected });

  it("classifies the doc's canonical example: 9 recent vs 4.3 expected", () => {
    const c = classifyBookingSpeed({ recentBookings: 9, expectedBookings: 4.3 });
    expect(c.speed).toBe("much_faster");
    expect(c.guard).toBe("none");
  });

  it("maps ratio bands on the fast side", () => {
    expect(at(429).speed).toBe("normal");
    expect(at(440).speed).toBe("slightly_faster"); // boundary inclusive
    expect(at(519).speed).toBe("slightly_faster");
    expect(at(520).speed).toBe("faster");
    expect(at(699).speed).toBe("faster");
    expect(at(700).speed).toBe("much_faster");
    expect(at(1099).speed).toBe("much_faster");
    expect(at(1100).speed).toBe("surging");
  });

  it("maps ratio bands on the slow side", () => {
    expect(at(364).speed).toBe("normal");
    expect(at(363).speed).toBe("slightly_slower"); // boundary mirrors 440
    expect(at(308).speed).toBe("slightly_slower");
    expect(at(307).speed).toBe("slower");
    expect(at(229).speed).toBe("slower");
    expect(at(228).speed).toBe("much_slower");
    expect(at(146).speed).toBe("much_slower");
    expect(at(145).speed).toBe("stalled");
    expect(at(0).speed).toBe("stalled");
  });

  it("is symmetric in log space: ratio r and 1/r land equally far from Normal", () => {
    for (const [fast, slow] of [
      [440, 363],
      [520, 307],
      [700, 228],
      [1100, 145],
    ] as const) {
      expect(at(fast).rank).toBe(-at(slow).rank);
    }
  });

  it("never decreases rank as recent bookings climb", () => {
    for (const expected of [1, 3, 10, 100, 400]) {
      let last = -4;
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
  it("scales the leave-Normal bar with volume: same 10% bump, different call", () => {
    // 10% over pace on a 400-expectation window is a 40-booking deviation —
    // far beyond noise, so it classifies.
    const big = classifyBookingSpeed({ recentBookings: 440, expectedBookings: 400 });
    expect(big.speed).toBe("slightly_faster");
    expect(big.guard).toBe("none");
    // The same 10% bump on a 100-expectation window is only 10 bookings —
    // inside sqrt-noise, so it stays Normal.
    const small = classifyBookingSpeed({ recentBookings: 110, expectedBookings: 100 });
    expect(small.speed).toBe("normal");
    expect(small.guard).toBe("small_difference");
    // Once the deviation clears the noise bar, the call lands.
    const cleared = classifyBookingSpeed({ recentBookings: 115, expectedBookings: 100 });
    expect(cleared.speed).toBe("slightly_faster");
    expect(cleared.guard).toBe("none");
  });

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
    expect(c.speed).toBe("slightly_faster");
    expect(c.guard).toBe("few_comparables");
  });

  it("caps the slow side on thin history too", () => {
    const c = classifyBookingSpeed({
      recentBookings: 0,
      expectedBookings: 8,
      comparableCount: 1,
    });
    expect(c.speed).toBe("slightly_slower");
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
    expect(SPEED_BAND_MULTIPLES.slightlyFaster).toBeGreaterThan(1);
    expect(SPEED_BAND_MULTIPLES.faster).toBeGreaterThan(SPEED_BAND_MULTIPLES.slightlyFaster);
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
    const c = classifyBookingSpeed({ recentBookings: 240, expectedBookings: 200 });
    const s = describeBookingSpeed(c);
    expect(s).toContain("received 240 bookings in the last 7 days");
    expect(s).toContain("we expected about 200");
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
    const small = classifyBookingSpeed({ recentBookings: 110, expectedBookings: 100 });
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
    for (const recent of [-5, 0, 1, 2, 3, 4, 7, 9, 15, 40, 120, 240, 500]) {
      for (const expected of [0, 0.4, 1, 2.5, 4.3, 8, 20, 100, 200, 400]) {
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
