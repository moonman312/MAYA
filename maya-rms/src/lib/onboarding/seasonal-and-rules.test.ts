import { describe, expect, it } from "vitest";
import {
  describeSeason,
  findClosedPeriods,
  mergeSeasonalClosures,
  type ClosedPeriodFinding,
  type DailyRoomNights,
} from "../../../supabase/functions/_shared/onboarding/analysis";
import {
  computeStarterRules,
} from "../../../supabase/functions/_shared/onboarding/generate-rules";

/* ── Seasonal closure merging ────────────────────────────────────────────── */

function period(start: string, end: string, days: number): ClosedPeriodFinding {
  return { start_date: start, end_date: end, days, surrounding_median: 10 };
}

describe("mergeSeasonalClosures", () => {
  it("collapses three winters into ONE question", () => {
    const { seasonal, oneOff } = mergeSeasonalClosures([
      period("2023-12-15", "2024-02-10", 58),
      period("2024-12-12", "2025-02-14", 65),
      period("2025-12-18", "2026-02-08", 53),
    ]);
    expect(seasonal).toHaveLength(1);
    expect(oneOff).toHaveLength(0);
    expect(seasonal[0].years_observed).toBe(3);
    expect(seasonal[0].periods).toHaveLength(3);
    expect(seasonal[0].season_label).toMatch(/December to .*February/);
  });

  it("recognizes an every-August pattern and says it like a person", () => {
    const { seasonal } = mergeSeasonalClosures([
      period("2024-08-01", "2024-08-29", 29),
      period("2025-08-03", "2025-08-30", 28),
    ]);
    expect(seasonal).toHaveLength(1);
    expect(seasonal[0].season_label).toBe("all of August");
  });

  it("keeps a one-time renovation separate from the seasonal pattern", () => {
    const { seasonal, oneOff } = mergeSeasonalClosures([
      period("2024-01-05", "2024-01-31", 27),
      period("2025-01-08", "2025-02-02", 26),
      period("2024-06-10", "2024-07-05", 26), // renovation, once
    ]);
    expect(seasonal).toHaveLength(1);
    expect(oneOff).toHaveLength(1);
    expect(oneOff[0].start_date).toBe("2024-06-10");
  });

  it("does not merge same-year gaps into a season", () => {
    const { seasonal, oneOff } = mergeSeasonalClosures([
      period("2024-03-01", "2024-03-20", 20),
      period("2024-03-25", "2024-04-15", 22), // close in doy but same year
    ]);
    expect(seasonal).toHaveLength(0);
    expect(oneOff).toHaveLength(2);
  });

  it("handles the December→January wraparound", () => {
    const { seasonal } = mergeSeasonalClosures([
      period("2023-12-28", "2024-01-20", 24),
      period("2025-01-02", "2025-01-24", 23), // starts across the boundary
    ]);
    expect(seasonal).toHaveLength(1);
  });

  it("end-to-end: three seasonal winters in a daily series produce one finding", () => {
    const series: DailyRoomNights[] = [];
    const start = new Date("2023-04-01T00:00:00Z");
    for (let i = 0; i < 1150; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      const m = d.getUTCMonth() + 1;
      const closed = m >= 11 || m <= 3;
      if (!closed) series.push({ stay_date: date, room_nights: 12 });
    }
    const raw = findClosedPeriods(series, "2026-07-26");
    const { seasonal, oneOff } = mergeSeasonalClosures(raw);
    expect(seasonal).toHaveLength(1);
    expect(oneOff).toHaveLength(0);
    expect(seasonal[0].years_observed).toBeGreaterThanOrEqual(2);
  });
});

describe("describeSeason", () => {
  it("phrases ranges the way a hotelier would", () => {
    expect(describeSeason(348, 44)).toBe("mid-December to mid-February");
    expect(describeSeason(212, 241)).toBe("all of August");
  });
});

/* ── Starter rule generation ─────────────────────────────────────────────── */

function occupancySeries(shape: { busyShare: number; busyLevel: number; quietLevel: number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < 700; i++) {
    out.push(i % 100 < shape.busyShare * 100 ? shape.busyLevel : shape.quietLevel);
  }
  return out;
}

describe("computeStarterRules", () => {
  it("derives thresholds from the property's own distribution", () => {
    const rules = computeStarterRules({
      dailyOccupancyFractions: occupancySeries({ busyShare: 0.2, busyLevel: 0.9, quietLevel: 0.5 }),
      totalRooms: 40,
      pricingConfidence: null,
    });
    expect(rules).toHaveLength(3);
    const surge = rules[0];
    expect(surge.condition.occupancy_threshold).toBeGreaterThanOrEqual(0.6);
    expect(surge.condition.occupancy_threshold).toBeLessThanOrEqual(0.85);
    // peak strictly above surge
    expect(rules[1].condition.occupancy_threshold!).toBeGreaterThan(
      surge.condition.occupancy_threshold!,
    );
    // pickup scaled to 40 rooms
    expect(rules[2].condition.pickup_threshold).toBe(6);
    expect(rules[2].is_pickup_rule).toBe(true);
  });

  it("is bolder for find_upside than automate_current", () => {
    const base = {
      dailyOccupancyFractions: occupancySeries({ busyShare: 0.2, busyLevel: 0.9, quietLevel: 0.5 }),
      totalRooms: 40,
    };
    const gentle = computeStarterRules({ ...base, pricingConfidence: "automate_current" });
    const bold = computeStarterRules({ ...base, pricingConfidence: "find_upside" });
    expect(bold[0].action.action_value).toBeGreaterThan(gentle[0].action.action_value);
  });

  it("refuses to generate rules from thin history", () => {
    expect(
      computeStarterRules({
        dailyOccupancyFractions: Array(30).fill(0.5),
        totalRooms: 40,
        pricingConfidence: null,
      }),
    ).toHaveLength(0);
  });

  it("keeps thresholds sane even for a always-full property", () => {
    const rules = computeStarterRules({
      dailyOccupancyFractions: Array(400).fill(0.98),
      totalRooms: 40,
      pricingConfidence: null,
    });
    expect(rules[0].condition.occupancy_threshold).toBeLessThanOrEqual(0.85);
    expect(rules[1].condition.occupancy_threshold).toBeLessThanOrEqual(0.95);
  });

  it("small properties still get a reachable pickup threshold", () => {
    const rules = computeStarterRules({
      dailyOccupancyFractions: occupancySeries({ busyShare: 0.2, busyLevel: 0.9, quietLevel: 0.4 }),
      totalRooms: 6, // tiny B&B
      pricingConfidence: null,
    });
    expect(rules[2].condition.pickup_threshold).toBe(3);
  });

  it("every rule explains itself in the user's terms", () => {
    const rules = computeStarterRules({
      dailyOccupancyFractions: occupancySeries({ busyShare: 0.2, busyLevel: 0.9, quietLevel: 0.5 }),
      totalRooms: 40,
      pricingConfidence: null,
    });
    for (const r of rules) {
      expect(r.explanation.length).toBeGreaterThan(30);
      expect(r.explanation).toMatch(/%/);
    }
  });
});
