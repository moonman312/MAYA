import { describe, expect, it } from "vitest";
import { addDays } from "../../../supabase/functions/_shared/observations/calendar";
import {
  detectSeasons,
  type DailyDemand,
} from "../../../supabase/functions/_shared/observations/seasons";
import {
  selectComparableDates,
  type ComparableSelection,
} from "../../../supabase/functions/_shared/observations/comparable-dates";
import {
  describeExpectation,
  describeObservation,
  observeBookingSpeed,
  pickupInWindow,
  trimmedMean,
  type SlimReservationRow,
} from "../../../supabase/functions/_shared/observations/expected-bookings";

const NO_MATH_SYMBOLS = /[<>]/;

describe("pickupInWindow", () => {
  const rows: SlimReservationRow[] = [
    { stay_date: "2026-08-15", booking_date: "2026-08-01" }, // 14 days out — in
    { stay_date: "2026-08-15", booking_date: "2026-07-26" }, // 20 days out — in
    { stay_date: "2026-08-15", booking_date: "2026-07-25" }, // 21 days out — out
    { stay_date: "2026-08-15", booking_date: "2026-08-02" }, // 13 days out — out
    { stay_date: "2026-08-16", booking_date: "2026-08-01" }, // other stay date
  ];

  it("counts bookings whose window falls inside the band, fenceposts included", () => {
    expect(pickupInWindow(rows, "2026-08-15", 14, 7)).toBe(2);
  });

  it("uses booking_window_days when present and skips rows with neither field", () => {
    const mixed: SlimReservationRow[] = [
      { stay_date: "2026-08-15", booking_window_days: 15 },
      { stay_date: "2026-08-15", booking_window_days: 8 },
      { stay_date: "2026-08-15" },
    ];
    expect(pickupInWindow(mixed, "2026-08-15", 14, 7)).toBe(1);
  });
});

describe("trimmedMean", () => {
  it("drops the single min and max once there are five values", () => {
    expect(trimmedMean([0, 2, 3, 3, 10])).toBeCloseTo(8 / 3, 5);
    expect(trimmedMean([5, 5, 5, 5, 5])).toBe(5);
  });

  it("plain-averages small sets and zeroes the empty set", () => {
    expect(trimmedMean([1, 2])).toBe(1.5);
    expect(trimmedMean([])).toBe(0);
  });
});

describe("observeBookingSpeed", () => {
  const fakeSelection = (comparables: string[]): ComparableSelection => ({
    target: "2026-08-15",
    comparables: comparables.map((date, i) => ({
      date,
      tier: 1,
      reasons: ["a Saturday"],
      score: 100 - i,
    })),
    assumptions: {
      dayOfWeek: "Saturday",
      dowClass: "weekend",
      holiday: null,
      seasonLabel: "Peak Season",
      seasonRange: "June 1 through August 31",
      relaxed: false,
    },
  });

  const rowsFor = (stayDate: string, windows: number[]): SlimReservationRow[] =>
    windows.map((w) => ({ stay_date: stayDate, booking_window_days: w }));

  it("measures every date over the same stretch of its booking curve", () => {
    const rows = [
      // 8 in window: enough over the ~4.3 expectation to clear the
      // sqrt-scaled noise guard at this volume (see the guard suite in
      // booking-speed.test.ts — a gap this small at low counts is designed
      // to read as Normal until it clears that bar).
      ...rowsFor("2026-08-15", [14, 15, 16, 17, 18, 19, 20, 18, 5, 30, 3]),
      ...rowsFor("2025-08-16", [14, 16, 18, 20, 2, 40]), // 4 in window
      ...rowsFor("2025-08-09", [15, 17, 19, 20, 90]), // 4 in window
      ...rowsFor("2025-08-02", [14, 15, 16, 18, 19, 1]), // 5 in window
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(["2025-08-16", "2025-08-09", "2025-08-02"]),
    });
    expect(obs.daysOut).toBe(14);
    expect(obs.recentBookings).toBe(8);
    expect(obs.perComparable.map((c) => c.bookings)).toEqual([4, 4, 5]);
    expect(obs.expectedBookings).toBeCloseTo(4.33, 2);
    expect(obs.classification.speed).toBe("faster");
  });

  it("stays Normal when the gap from expectation is within noise for the volume", () => {
    // Same comparables (expected ~4.33), but only 7 recent bookings — a
    // 2.67 gap, below the sqrt-scaled bar at this expectation.
    const rows = [
      ...rowsFor("2026-08-15", [14, 15, 16, 17, 18, 19, 20, 5, 30, 3]),
      ...rowsFor("2025-08-16", [14, 16, 18, 20, 2, 40]),
      ...rowsFor("2025-08-09", [15, 17, 19, 20, 90]),
      ...rowsFor("2025-08-02", [14, 15, 16, 18, 19, 1]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(["2025-08-16", "2025-08-09", "2025-08-02"]),
    });
    expect(obs.recentBookings).toBe(7);
    expect(obs.classification.speed).toBe("normal");
    expect(obs.classification.guard).toBe("small_difference");
  });

  it("classifies elevated pickup against the comparables", () => {
    const rows = [
      ...rowsFor("2026-08-15", [14, 15, 16, 17, 18, 19, 20, 14, 15]), // 9 in window
      ...rowsFor("2025-08-16", [14, 16, 18, 20]),
      ...rowsFor("2025-08-09", [15, 17, 19, 20]),
      ...rowsFor("2025-08-02", [14, 15, 16, 18]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(["2025-08-16", "2025-08-09", "2025-08-02"]),
    });
    expect(obs.recentBookings).toBe(9);
    expect(obs.expectedBookings).toBe(4);
    expect(obs.classification.speed).toBe("much_faster");
  });

  it("keeps fractional expectations honest on quiet far-out dates", () => {
    const rows = [...rowsFor("2025-08-16", [15]), ...rowsFor("2025-08-09", []), ...rowsFor("2025-08-02", [])];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(["2025-08-16", "2025-08-09", "2025-08-02"]),
    });
    expect(obs.recentBookings).toBe(0);
    expect(obs.expectedBookings).toBeCloseTo(0.33, 2);
    expect(obs.classification.speed).toBe("normal");
    expect(describeExpectation(obs)).toContain("almost no bookings");
  });

  it("refuses targets in the past", () => {
    expect(() =>
      observeBookingSpeed({
        rows: [],
        target: "2026-07-01",
        asOf: "2026-08-01",
        selection: fakeSelection([]),
      }),
    ).toThrow();
  });

  it("narrates without math symbols", () => {
    const rows = [
      ...rowsFor("2026-08-15", [14, 15, 16]),
      ...rowsFor("2025-08-16", [14, 16]),
      ...rowsFor("2025-08-09", [15]),
      ...rowsFor("2025-08-02", [18]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(["2025-08-16", "2025-08-09", "2025-08-02"]),
    });
    expect(describeObservation(obs)).not.toMatch(NO_MATH_SYMBOLS);
    const expectation = describeExpectation(obs);
    expect(expectation).toContain("3 similar past dates");
    expect(expectation).toContain("days before arrival");
    expect(expectation).not.toMatch(NO_MATH_SYMBOLS);
  });
});

describe("end to end: seasons, comparables, and booking curves together", () => {
  it("detects a demand shock on a summer Saturday against three years of history", () => {
    // Season model from three full years of a beach-shaped hotel.
    const daily: DailyDemand[] = [];
    for (let d = "2023-01-01"; d <= "2025-12-31"; d = addDays(d, 1)) {
      const m = Number(d.slice(5, 7));
      daily.push({ stay_date: d, value: m >= 6 && m <= 8 ? 100 : m === 5 || m === 9 ? 60 : 30 });
    }
    const model = detectSeasons(daily);

    // Every stay date books on the same curve (full year, so whichever
    // Saturdays the data-driven season model picks as comparables — its
    // boundaries need not land on exact month lines — are covered): two
    // bookings land in the 14-20 days-out band. The target date got four
    // extra on top.
    const rows: SlimReservationRow[] = [];
    for (const year of [2023, 2024, 2025, 2026]) {
      for (let d = `${year}-01-01`; d <= `${year}-12-31`; d = addDays(d, 1)) {
        for (const w of [3, 10, 16, 18, 40]) {
          rows.push({ stay_date: d, booking_window_days: w });
        }
      }
    }
    for (const w of [14, 15, 17, 19]) {
      rows.push({ stay_date: "2026-07-25", booking_window_days: w });
    }

    const selection = selectComparableDates("2026-07-25", {
      seasonModel: model,
      historyStart: "2023-06-01",
      historyEnd: "2026-07-10",
    });
    const obs = observeBookingSpeed({
      rows,
      target: "2026-07-25",
      asOf: "2026-07-11",
      selection,
    });

    expect(obs.daysOut).toBe(14);
    // Window alignment holds across every comparable's own booking curve.
    for (const c of obs.perComparable) expect(c.bookings).toBe(2);
    expect(obs.expectedBookings).toBe(2);
    expect(obs.recentBookings).toBe(6);
    expect(obs.classification.speed).toBe("much_faster");
    expect(describeObservation(obs)).toContain("Booking speed is Much Faster Than Normal.");
  });
});
