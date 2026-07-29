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
import { classifyBookingSpeed } from "../../../supabase/functions/_shared/observations/booking-speed";

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

describe("trimmedMean and MIN_COMPARABLES_FULL_RANGE stay in step", () => {
  // Below 5 comparables trimmedMean hasn't started trimming, so a single
  // anomalous comparable (a one-off event, a wedding block) still sets the
  // whole expectation on its own. The few_comparables guard has to still be
  // capping the call at exactly the counts trimmedMean doesn't yet protect.
  it("does not let one outlier comparable at n=3 manufacture an unguarded Stalled call", () => {
    const expected = trimmedMean([0, 0, 21]);
    expect(expected).toBe(7);
    const c = classifyBookingSpeed({ recentBookings: 0, expectedBookings: expected, comparableCount: 3 });
    expect(c.speed).not.toBe("stalled");
    expect(c.guard).toBe("few_comparables");
  });

  it("does not let one outlier comparable at n=4 manufacture an unguarded Stalled call", () => {
    const expected = trimmedMean([1, 1, 1, 25]);
    expect(expected).toBe(7);
    const c = classifyBookingSpeed({ recentBookings: 0, expectedBookings: expected, comparableCount: 4 });
    expect(c.speed).not.toBe("stalled");
    expect(c.guard).toBe("few_comparables");
  });

  it("allows the same shape of outlier through once n=5 trims it away", () => {
    // Same lone-event outlier, now alongside two ordinary comparables.
    // trimmedMean drops the min and max (the outlier and a zero), so the
    // expectation reflects the honest comparables and the classifier's full
    // range is open to call it Stalled outright.
    const expected = trimmedMean([0, 0, 21, 6, 7]);
    const c = classifyBookingSpeed({ recentBookings: 0, expectedBookings: expected, comparableCount: 5 });
    expect(c.guard).not.toBe("few_comparables");
    expect(c.speed).toBe("stalled");
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

  // Four comparables — one short of MIN_COMPARABLES_FULL_RANGE, and of
  // trimmedMean's own n>=5 trim threshold — so an extreme call built from
  // these is still capped one step by the few_comparables guard; only
  // faster/slower (not much_faster/much_slower/stalled/surging) pass through
  // unguarded at this count.
  const FOUR_COMPARABLES = ["2025-08-16", "2025-08-09", "2025-08-02", "2024-08-17"];

  it("measures every date over the same stretch of its booking curve", () => {
    const rows = [
      // 8 in window: enough over the ~4.25 expectation to clear the
      // sqrt-scaled noise guard at this volume (see the guard suite in
      // booking-speed.test.ts — a gap this small at low counts is designed
      // to read as Normal until it clears that bar).
      ...rowsFor("2026-08-15", [14, 15, 16, 17, 18, 19, 20, 18, 5, 30, 3]),
      ...rowsFor("2025-08-16", [14, 16, 18, 20, 2, 40]), // 4 in window
      ...rowsFor("2025-08-09", [15, 17, 19, 20, 90]), // 4 in window
      ...rowsFor("2025-08-02", [14, 15, 16, 18, 19, 1]), // 5 in window
      ...rowsFor("2024-08-17", [14, 16, 18, 20, 2, 40]), // 4 in window
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(FOUR_COMPARABLES),
    });
    expect(obs.daysOut).toBe(14);
    expect(obs.method).toBe("comparable");
    expect(obs.recentBookings).toBe(8);
    expect(obs.perComparable.every((c) => c.hasData)).toBe(true);
    expect(obs.perComparable.map((c) => c.bookings)).toEqual([4, 4, 5, 4]);
    expect(obs.expectedBookings).toBeCloseTo(4.25, 2);
    expect(obs.classification.speed).toBe("faster");
  });

  it("stays Normal when the gap from expectation is within noise for the volume", () => {
    const rows = [
      ...rowsFor("2026-08-15", [14, 15, 16, 17, 18, 19, 20, 5, 30, 3]),
      ...rowsFor("2025-08-16", [14, 16, 18, 20, 2, 40]),
      ...rowsFor("2025-08-09", [15, 17, 19, 20, 90]),
      ...rowsFor("2025-08-02", [14, 15, 16, 18, 19, 1]),
      ...rowsFor("2024-08-17", [14, 16, 18, 20, 2, 40]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(FOUR_COMPARABLES),
    });
    expect(obs.recentBookings).toBe(7);
    expect(obs.classification.speed).toBe("normal");
    expect(obs.classification.guard).toBe("small_difference");
  });

  it("caps elevated pickup one step when only four comparables back it", () => {
    const rows = [
      ...rowsFor("2026-08-15", [14, 15, 16, 17, 18, 19, 20, 14, 15]), // 9 in window
      ...rowsFor("2025-08-16", [14, 16, 18, 20]),
      ...rowsFor("2025-08-09", [15, 17, 19, 20]),
      ...rowsFor("2025-08-02", [14, 15, 16, 18]),
      ...rowsFor("2024-08-17", [14, 16, 18, 20]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(FOUR_COMPARABLES),
    });
    expect(obs.recentBookings).toBe(9);
    expect(obs.expectedBookings).toBe(4);
    // Raw ratio (9/4) lands in much_faster territory, but only 4 comparables
    // (still an untrimmed mean) back that expectation, so the
    // few_comparables guard holds it to one step from Normal.
    expect(obs.classification.speed).toBe("faster");
    expect(obs.classification.guard).toBe("few_comparables");
  });

  it("keeps fractional expectations honest when real comparables mostly miss the window", () => {
    // Each comparable HAS reservation history (hasData true) — they just
    // mostly don't have anything landing in this specific window, a
    // genuine "verified zero", not a "we don't know".
    const rows = [
      ...rowsFor("2025-08-16", [15]),
      ...rowsFor("2025-08-09", [999]),
      ...rowsFor("2025-08-02", [999]),
      ...rowsFor("2024-08-17", [999]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(FOUR_COMPARABLES),
    });
    expect(obs.recentBookings).toBe(0);
    expect(obs.perComparable.every((c) => c.hasData)).toBe(true);
    expect(obs.expectedBookings).toBeCloseTo(0.25, 2);
    expect(obs.classification.speed).toBe("normal");
    expect(describeExpectation(obs)).toContain("almost no bookings");
  });

  it("uses real comparables even when there are only a couple of them, rather than discarding them for momentum", () => {
    // Only 2 real, data-backed comparables — below the full-confidence
    // range, but genuine day-of-week/season-matched evidence is still
    // better than a calendar-neighbor proxy. The classifier's own
    // few_comparables guard (not this pipeline) is what keeps the call
    // conservative here.
    const rows = [
      ...rowsFor("2026-08-15", [14, 15, 16]), // 3 recent
      ...rowsFor("2025-08-16", [14]),
      ...rowsFor("2025-08-09", [15]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(["2025-08-16", "2025-08-09"]),
    });
    expect(obs.method).toBe("comparable");
    expect(obs.perComparable).toHaveLength(2);
    expect(obs.perComparable.every((c) => c.hasData)).toBe(true);
    expect(obs.expectedBookings).toBe(1);
    // Only 2 comparables backed the call — the classifier's own
    // thin-history guard engages and holds the call back a step.
    expect(obs.classification.speed).toBe("faster");
    expect(obs.classification.guard).toBe("few_comparables");
  });

  it("does not let a phantom (no-data) comparable masquerade as a verified zero", () => {
    // 4 selected comparables, but 3 have no reservation rows at all — only
    // 2025-08-16's 1 real booking should drive the expectation.
    const rows = [...rowsFor("2026-08-15", [14, 15]), ...rowsFor("2025-08-16", [15])];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(FOUR_COMPARABLES),
    });
    const byDate = new Map(obs.perComparable.map((c) => [c.date, c]));
    expect(byDate.get("2025-08-16")?.hasData).toBe(true);
    expect(byDate.get("2025-08-09")?.hasData).toBe(false);
    expect(byDate.get("2025-08-02")?.hasData).toBe(false);
    expect(byDate.get("2024-08-17")?.hasData).toBe(false);
    expect(obs.expectedBookings).toBe(1); // from the one real comparable, not diluted to 0.25
    expect(obs.classification.speed).toBe("normal");
    expect(obs.classification.guard).toBe("small_difference");
  });

  it("falls back to momentum only when there are literally zero usable comparables", () => {
    const rows = [
      ...rowsFor("2026-08-15", [14, 15, 16]), // 3 recent
      // No rows at all for either selected comparable date.
      // Momentum neighbors, correctly aligned to their own daysOut bands.
      ...rowsFor("2026-08-13", [12, 12]),
      ...rowsFor("2025-08-14", [12]),
      ...rowsFor("2026-08-17", [16, 16]),
      ...rowsFor("2025-08-18", [16]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(["2025-08-16", "2025-08-09"]),
    });
    expect(obs.method).toBe("momentum");
    expect(obs.momentum).toBeDefined();
    expect(obs.perComparable.every((c) => !c.hasData)).toBe(true);
    expect(describeExpectation(obs)).toContain("booking momentum from neighboring dates");
  });

  it("falls back to momentum (not insufficient_data) on an empty import, reading the quiet neighborhood as verified zero", () => {
    // No rows anywhere, but the target still has a full radius of future,
    // non-holiday, non-excluded neighbor dates to read as genuinely quiet
    // rather than unknown — so this is honestly "momentum says ~0", not
    // "we have nothing to go on".
    const obs = observeBookingSpeed({
      rows: [],
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection([]),
    });
    expect(obs.method).toBe("momentum");
    expect(obs.expectedBookings).toBe(0);
    expect(obs.momentum?.neighborsUsed).toBe(20);
    expect(describeExpectation(obs)).toContain("booking momentum from neighboring dates");
  });

  it("reports insufficient_data honestly when even momentum has nothing to go on", () => {
    // Every candidate neighbor date is caller-excluded (e.g. the whole
    // nearby stretch is closed), so there is truly nothing to read — this
    // is the genuine insufficient_data path, not a zero-row artifact.
    const obs = observeBookingSpeed({
      rows: [],
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection([]),
      isExcluded: () => true,
    });
    expect(obs.method).toBe("insufficient_data");
    expect(obs.expectedBookings).toBe(0);
    expect(describeObservation(obs)).toContain("do not have enough history");
    expect(describeExpectation(obs)).toContain("do not have enough booking history");
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
      ...rowsFor("2024-08-17", [16]),
    ];
    const obs = observeBookingSpeed({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      selection: fakeSelection(FOUR_COMPARABLES),
    });
    expect(describeObservation(obs)).not.toMatch(NO_MATH_SYMBOLS);
    const expectation = describeExpectation(obs);
    expect(expectation).toContain("4 similar past dates");
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
