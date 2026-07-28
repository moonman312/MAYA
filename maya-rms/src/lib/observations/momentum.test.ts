import { describe, expect, it } from "vitest";
import { dayOfWeek } from "../../../supabase/functions/_shared/observations/calendar";
import {
  MOMENTUM_MIN_NEIGHBORS,
  MOMENTUM_RATIO_CEILING,
  MOMENTUM_RATIO_FLOOR,
  MOMENTUM_YEAR_OFFSET_DAYS,
  describeMomentum,
  estimateMomentumFallback,
} from "../../../supabase/functions/_shared/observations/momentum";
import type { SlimReservationRow } from "../../../supabase/functions/_shared/observations/booking-rows";

const NO_MATH_SYMBOLS = /[<>]/;

// asOf 2026-08-01, target 2026-08-15 -> daysOut 14 throughout this suite.
// Neighbor daysOut (from asOf): 08-13 -> 12, 08-17 -> 16. With the 364-day
// (52-week) offset, each neighbor's prior-year counterpart is exactly
// 2026-08-13 -> 2025-08-14, 2026-08-17 -> 2025-08-18, target 2026-08-15 ->
// 2025-08-16, verified to land on the SAME day of week (confirmed below) —
// unlike a naive 365-day offset, which drifts the weekday by one most years.
function windowRow(stayDate: string, windowDays: number, count = 1): SlimReservationRow[] {
  return Array.from({ length: count }, () => ({ stay_date: stayDate, booking_window_days: windowDays }));
}

describe("MOMENTUM_YEAR_OFFSET_DAYS", () => {
  it("is 364 (52 weeks), which keeps day-of-week exactly aligned", () => {
    expect(MOMENTUM_YEAR_OFFSET_DAYS).toBe(364);
    expect(MOMENTUM_YEAR_OFFSET_DAYS % 7).toBe(0);
    for (const d of ["2026-08-13", "2026-08-17", "2026-08-15", "2026-08-01"]) {
      const prior = new Date(Date.parse(d + "T00:00:00Z") - MOMENTUM_YEAR_OFFSET_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(dayOfWeek(prior)).toBe(dayOfWeek(d));
    }
  });
});

describe("estimateMomentumFallback", () => {
  it("returns null when fewer than the minimum neighbors have any data", () => {
    expect(MOMENTUM_MIN_NEIGHBORS).toBeGreaterThanOrEqual(2);
    const est = estimateMomentumFallback({
      rows: windowRow("2026-08-15", 5),
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
    });
    expect(est).toBeNull();
  });

  it("computes a faster-than-last-year ratio from matched neighbor pairs and applies it to the target's own year-ago baseline", () => {
    const rows: SlimReservationRow[] = [
      ...windowRow("2025-08-16", 14, 4), // target, one year ago, daysOut 14
      ...windowRow("2026-08-13", 12, 6),
      ...windowRow("2025-08-14", 12, 3),
      ...windowRow("2026-08-17", 16, 6),
      ...windowRow("2025-08-18", 16, 3),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 2,
    });
    expect(est).not.toBeNull();
    expect(est!.neighborsUsed).toBe(2);
    expect(est!.matchedPairs).toBe(2);
    expect(est!.momentumRatio).toBe(2); // 12/6
    expect(est!.baselineSource).toBe("target_year_ago");
    expect(est!.naiveBaselineBookings).toBe(4);
    expect(est!.expectedBookings).toBe(8);
  });

  it("falls back to a trimmed neighbor pace as the baseline when the target has no year-ago data either", () => {
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-08-13", 12, 2),
      ...windowRow("2026-08-17", 16, 2),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 2,
    });
    expect(est).not.toBeNull();
    expect(est!.matchedPairs).toBe(0);
    expect(est!.momentumRatio).toBe(1);
    expect(est!.baselineSource).toBe("neighbor_pace");
    expect(est!.naiveBaselineBookings).toBe(2);
    expect(est!.expectedBookings).toBe(2);
  });

  it("only counts a neighbor toward the ratio when BOTH its current and year-ago side have usable data (no mixed-population ratio)", () => {
    // 4 neighbors, all with current-year data (recentTotal would be large
    // if every neighbor counted) but only ONE has a matched year-ago pair.
    // The unmatched ratio would be 4*2 / 2 = 4; the correct matched-only
    // ratio is 2/2 = 1.
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-08-11", 10, 2),
      ...windowRow("2026-08-12", 11, 2),
      ...windowRow("2026-08-13", 12, 2),
      ...windowRow("2025-08-14", 12, 2), // the only matched year-ago pair
      ...windowRow("2026-08-17", 16, 2),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 4,
    });
    expect(est!.neighborsUsed).toBe(4);
    expect(est!.matchedPairs).toBe(1);
    expect(est!.momentumRatio).toBe(1);
  });

  it("does not let a poisoned year-ago comparison point corrupt the ratio when only the current-side date was checked", () => {
    // Neighbor 2026-08-13's prior counterpart (2025-08-14) is deliberately
    // excluded (standing in for "this date is a holiday" or "an owner
    // flagged it as non-comparable") and carries a wildly inflated count
    // that must NOT leak into the ratio. Neighbor 2026-08-17's pair is
    // clean and should be the only one driving the result.
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-08-13", 12, 6),
      ...windowRow("2025-08-14", 12, 100), // poisoned, but excluded
      ...windowRow("2026-08-17", 16, 6),
      ...windowRow("2025-08-18", 16, 3),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 2,
      isExcluded: (d) => d === "2025-08-14",
    });
    expect(est!.neighborsUsed).toBe(2); // both neighbors still count as neighbors
    expect(est!.matchedPairs).toBe(1); // but only one pairs cleanly
    expect(est!.momentumRatio).toBe(2); // 6/3, unaffected by the poisoned 100
  });

  it("clamps the ratio at the ceiling when matched recent pace dwarfs a thin year-ago baseline", () => {
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-08-13", 12, 20),
      ...windowRow("2025-08-14", 12, 1),
      ...windowRow("2026-08-17", 16, 20),
      ...windowRow("2025-08-18", 16, 1),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 2,
    });
    expect(est!.momentumRatio).toBe(MOMENTUM_RATIO_CEILING);
  });

  it("clamps the ratio at the floor when matched recent pace has collapsed against a busy year-ago baseline", () => {
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-08-13", 12, 1),
      ...windowRow("2025-08-14", 12, 20),
      ...windowRow("2026-08-17", 16, 1),
      ...windowRow("2025-08-18", 16, 20),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 2,
    });
    expect(est!.momentumRatio).toBe(MOMENTUM_RATIO_FLOOR);
  });

  it("skips holiday-context and caller-excluded neighbors", () => {
    // 2026-07-04 is a Saturday and would otherwise be a neighbor of 2026-07-06.
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-07-04", 10, 2),
      ...windowRow("2026-07-08", 10, 2),
      ...windowRow("2026-07-09", 10, 2),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-07-06",
      asOf: "2026-06-20",
      windowDays: 7,
      radiusDays: 3,
      isExcluded: (d) => d === "2026-07-09",
    });
    // 07-04 is a holiday, 07-09 is caller-excluded: only 07-08 remains
    // eligible, below MOMENTUM_MIN_NEIGHBORS.
    expect(est).toBeNull();
  });

  it("never counts a neighbor date before asOf, even when it is within the radius", () => {
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-07-01", 5, 9), // before asOf: must be ignored entirely
      ...windowRow("2026-07-09", 4, 2),
      ...windowRow("2026-07-10", 5, 2),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-07-05",
      asOf: "2026-07-05",
      windowDays: 7,
      radiusDays: 5,
    });
    expect(est).not.toBeNull();
    expect(est!.neighborsUsed).toBe(2);
    expect(est!.baselineSource).toBe("neighbor_pace");
    expect(est!.naiveBaselineBookings).toBe(2);
  });
});

describe("describeMomentum", () => {
  const base = {
    expectedBookings: 4,
    neighborsUsed: 6,
    matchedPairs: 6,
    pairs: [],
    naiveBaselineBookings: 2,
    baselineDate: null,
  };

  it("describes accelerating, decelerating, and flat momentum in words", () => {
    expect(describeMomentum({ ...base, momentumRatio: 2, baselineSource: "target_year_ago" })).toContain(
      "booking faster than they were",
    );
    expect(describeMomentum({ ...base, momentumRatio: 0.5, baselineSource: "target_year_ago" })).toContain(
      "booking slower than they were",
    );
    expect(describeMomentum({ ...base, momentumRatio: 1, baselineSource: "target_year_ago" })).toContain(
      "about the same pace",
    );
  });

  it("says plainly when there is no matched year-ago comparison at all", () => {
    const text = describeMomentum({ ...base, matchedPairs: 0, momentumRatio: 1, baselineSource: "neighbor_pace" });
    expect(text).toContain("cannot say whether the pace has changed");
  });

  it("explains which baseline was used", () => {
    expect(
      describeMomentum({ ...base, momentumRatio: 1, baselineSource: "target_year_ago" }),
    ).toContain("what this date itself did a year ago");
    expect(
      describeMomentum({ ...base, momentumRatio: 1, baselineSource: "neighbor_pace" }),
    ).toContain("pace of nearby dates");
  });

  it("adds an honest caveat on very small samples but not on well-supported ones", () => {
    const thin = describeMomentum({
      ...base,
      matchedPairs: 1,
      neighborsUsed: 1,
      momentumRatio: 1,
      baselineSource: "target_year_ago",
    });
    expect(thin).toContain("rough guide");

    const solid = describeMomentum({
      ...base,
      matchedPairs: 5,
      neighborsUsed: 5,
      momentumRatio: 1,
      baselineSource: "target_year_ago",
    });
    expect(solid).not.toContain("rough guide");
  });

  it("never emits math symbols", () => {
    for (const momentumRatio of [0.15, 0.5, 0.9, 1, 1.1, 2, 6]) {
      for (const baselineSource of ["target_year_ago", "neighbor_pace"] as const) {
        for (const matchedPairs of [0, 1, 6]) {
          expect(
            describeMomentum({ ...base, momentumRatio, baselineSource, matchedPairs }),
          ).not.toMatch(NO_MATH_SYMBOLS);
        }
      }
    }
  });
});
