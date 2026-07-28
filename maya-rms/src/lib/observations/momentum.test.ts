import { describe, expect, it } from "vitest";
import {
  MOMENTUM_MIN_NEIGHBORS,
  MOMENTUM_RATIO_CEILING,
  MOMENTUM_RATIO_FLOOR,
  describeMomentum,
  estimateMomentumFallback,
} from "../../../supabase/functions/_shared/observations/momentum";
import type { SlimReservationRow } from "../../../supabase/functions/_shared/observations/booking-rows";

const NO_MATH_SYMBOLS = /[<>]/;

// asOf 2026-08-01, target 2026-08-15 -> daysOut 14 throughout this suite.
// Neighbor daysOut (from asOf): 08-13 -> 12, 08-17 -> 16. Every row below
// uses booking_window_days equal to the stay date's OWN daysOut, so it
// always lands inside that date's [daysOut, daysOut+7) band — no incidental
// overlap to reason about.
function windowRow(stayDate: string, windowDays: number, count = 1): SlimReservationRow[] {
  return Array.from({ length: count }, () => ({ stay_date: stayDate, booking_window_days: windowDays }));
}

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

  it("computes a faster-than-last-year ratio from neighbor pace and applies it to the target's own year-ago baseline", () => {
    const rows: SlimReservationRow[] = [
      // Target itself, one year ago, at the same days-out (14): 4 bookings.
      ...windowRow("2025-08-15", 14, 4),
      // Neighbor -2 (2026-08-13, daysOut 12): 6 recent, 3 a year ago.
      ...windowRow("2026-08-13", 12, 6),
      ...windowRow("2025-08-13", 12, 3),
      // Neighbor +2 (2026-08-17, daysOut 16): 6 recent, 3 a year ago.
      ...windowRow("2026-08-17", 16, 6),
      ...windowRow("2025-08-17", 16, 3),
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
    // recentTotal 12 / historicalTotal 6 = 2.0
    expect(est!.momentumRatio).toBe(2);
    expect(est!.baselineSource).toBe("target_year_ago");
    expect(est!.naiveBaselineBookings).toBe(4);
    expect(est!.expectedBookings).toBe(8);
  });

  it("falls back to neighbor pace as the baseline when the target has no year-ago data either", () => {
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-08-13", 12, 2),
      ...windowRow("2026-08-17", 16, 2),
      // No year-ago rows anywhere -> historicalTotal 0 -> neutral ratio,
      // and no target_year_ago row -> falls back to neighbor pace.
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 2,
    });
    expect(est).not.toBeNull();
    expect(est!.momentumRatio).toBe(1);
    expect(est!.baselineSource).toBe("neighbor_pace");
    // neighbor recent paces: 2 and 2 -> average 2
    expect(est!.naiveBaselineBookings).toBe(2);
    expect(est!.expectedBookings).toBe(2);
  });

  it("stays neutral (ratio 1) when there is no year-ago data for any neighbor", () => {
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
    expect(est!.momentumRatio).toBe(1);
  });

  it("clamps the ratio at the ceiling when recent pace dwarfs a thin year-ago baseline", () => {
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-08-13", 12, 20),
      ...windowRow("2025-08-13", 12, 1),
      ...windowRow("2026-08-17", 16, 20),
      ...windowRow("2025-08-17", 16, 1),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 2,
    });
    // recentTotal 40 / historicalTotal 2 = 20, clamped down to the ceiling.
    expect(est!.momentumRatio).toBe(MOMENTUM_RATIO_CEILING);
  });

  it("clamps the ratio at the floor when recent pace has collapsed against a busy year-ago baseline", () => {
    const rows: SlimReservationRow[] = [
      ...windowRow("2026-08-13", 12, 1),
      ...windowRow("2025-08-13", 12, 20),
      ...windowRow("2026-08-17", 16, 1),
      ...windowRow("2025-08-17", 16, 20),
    ];
    const est = estimateMomentumFallback({
      rows,
      target: "2026-08-15",
      asOf: "2026-08-01",
      windowDays: 7,
      radiusDays: 2,
    });
    // recentTotal 2 / historicalTotal 40 = 0.05, clamped up to the floor.
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
    neighborsUsed: 2,
    naiveBaselineBookings: 2,
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

  it("explains which baseline was used", () => {
    expect(
      describeMomentum({ ...base, momentumRatio: 1, baselineSource: "target_year_ago" }),
    ).toContain("what this date itself did a year ago");
    expect(
      describeMomentum({ ...base, momentumRatio: 1, baselineSource: "neighbor_pace" }),
    ).toContain("pace of nearby dates");
  });

  it("never emits math symbols", () => {
    for (const momentumRatio of [0.15, 0.5, 0.9, 1, 1.1, 2, 6]) {
      for (const baselineSource of ["target_year_ago", "neighbor_pace"] as const) {
        expect(describeMomentum({ ...base, momentumRatio, baselineSource })).not.toMatch(
          NO_MATH_SYMBOLS,
        );
      }
    }
  });
});
