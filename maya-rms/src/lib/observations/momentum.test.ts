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
  it("returns null when fewer than the minimum neighbor dates fall within the usable radius", () => {
    expect(MOMENTUM_MIN_NEIGHBORS).toBeGreaterThanOrEqual(2);
    // radiusDays 1 with asOf == target leaves only one candidate (target+1);
    // target-1 is dropped for being before asOf. This is now the only way
    // to fall short of MOMENTUM_MIN_NEIGHBORS: rows or no rows, every
    // future, non-holiday, non-excluded date in the radius counts.
    const est = estimateMomentumFallback({
      rows: [],
      target: "2026-08-15",
      asOf: "2026-08-15",
      windowDays: 7,
      radiusDays: 1,
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
    // Radius 2 covers 4 candidate dates (08-13, 08-14, 08-16, 08-17); all 4
    // count now, including the two with no rows of their own (verified zero).
    expect(est!.neighborsUsed).toBe(4);
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
    // Honest mean over all 4 future neighbors (08-13, 08-14, 08-16, 08-17),
    // counting the two zero-row ones as verified zero: [2, 0, 0, 2] -> 1.
    // Not 2, which is what you get by only averaging the two busy ones.
    expect(est!.neighborsUsed).toBe(4);
    expect(est!.naiveBaselineBookings).toBe(1);
    expect(est!.expectedBookings).toBe(1);
  });

  it("only counts a neighbor toward the ratio when BOTH its current and year-ago side have usable data (no mixed-population ratio)", () => {
    // 8 candidate future dates (radius 4), of which only 3 have their own
    // rows (recentTotal would be large if every one of those counted) but
    // only ONE has a matched year-ago pair. The unmatched ratio would be
    // 4*2 / 2 = 4; the correct matched-only ratio is 2/2 = 1.
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
    // 08-11, 08-12, 08-13, 08-14, 08-16, 08-17, 08-18, 08-19: all 8 count,
    // including the zero-row ones (08-14, 08-16, 08-18, 08-19 as futures).
    expect(est!.neighborsUsed).toBe(8);
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
    expect(est!.neighborsUsed).toBe(4); // all 4 future candidates count, poisoned or not
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
    // Radius 3 has 6 raw candidates (07-03, 07-04, 07-05, 07-07, 07-08,
    // 07-09). Independence Day's influence window (before 2, after 2) also
    // catches 07-03 and 07-05 alongside 07-04 itself, and 07-09 is
    // caller-excluded, so only 07-07 and 07-08 remain — proven by
    // neighborsUsed, since a zero-row future date no longer drops out on
    // its own.
    expect(est).not.toBeNull();
    expect(est!.neighborsUsed).toBe(2);
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
    // Of the 5 raw candidates on/after asOf (07-06..07-10), 07-06 falls in
    // Independence Day's after-influence window and drops out, leaving
    // 07-07..07-10. 07-01 is correctly never in that set at all (before
    // asOf). Only 07-09 and 07-10 have rows, but 07-07 and 07-08 count too,
    // as verified zeros: mean of [0, 0, 2, 2] -> 1, not 2 (the old,
    // data-only average of just the two busy dates).
    expect(est!.neighborsUsed).toBe(4);
    expect(est!.baselineSource).toBe("neighbor_pace");
    expect(est!.naiveBaselineBookings).toBe(1);
  });

  it("counts verified-zero future neighbors instead of only averaging the rare busy ones (quiet-neighborhood regression)", () => {
    // Brand-new property shape: 20 future neighbor dates (radius 10), only
    // 2 of which have any rows at all (one small group block each, 2 rows).
    // The old skip-if-no-rows behavior threw out the other 18 and averaged
    // just those two -> naiveBaselineBookings of 2.0, which is exactly the
    // inflated fallback baseline the finding flagged (it would make a truly
    // quiet, normal target look like a "slowdown" against nothing).
    const target = "2026-08-10";
    const asOf = "2026-07-27";
    const busyDates = ["2026-07-31", "2026-08-15"];
    const rows: SlimReservationRow[] = busyDates.flatMap((d) => {
      const daysOut = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
      return windowRow(d, daysOut, 2);
    });
    const est = estimateMomentumFallback({
      rows,
      target,
      asOf,
      windowDays: 7,
      radiusDays: 10,
    });
    expect(est).not.toBeNull();
    expect(est!.neighborsUsed).toBe(20);
    expect(est!.baselineSource).toBe("neighbor_pace");
    // Honest trimmed mean over all 20 (18 verified zeros + 2, 2): far below
    // the old, busy-only average of 2.0, not close to it.
    expect(est!.naiveBaselineBookings).toBe(0.11);
    expect(est!.naiveBaselineBookings).toBeLessThan(0.5);
    expect(est!.expectedBookings).toBe(0.11);
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
