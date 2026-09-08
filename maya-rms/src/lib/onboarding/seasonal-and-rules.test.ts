import { describe, expect, it } from "vitest";
import {
  describeSeason,
  findClosedPeriods,
  mergeSeasonalClosures,
  type ClosedPeriodFinding,
  type DailyRoomNights,
} from "../../../supabase/functions/_shared/onboarding/analysis";
import {
  computeOccupancyReference,
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

describe("computeStarterRules: the booking-speed ladder", () => {
  const NO_MATH_SYMBOLS = /[<>]/;
  const rules = computeStarterRules({ daysOfHistory: 400 });
  const byName = new Map(rules.map((r) => [r.name, r]));

  it("generates exactly the five-rule pace ladder, every rule event-style", () => {
    expect(rules).toHaveLength(5);
    for (const r of rules) {
      expect(r.is_pickup_rule).toBe(true);
      expect(r.condition.booking_speed_operator).toBeDefined();
      expect(r.condition.occupancy_operator).toBeUndefined();
      expect(r.condition.pickup_operator).toBeUndefined();
    }
  });

  it("matches the agreed ladder: windows, levels, percentages, cooldowns", () => {
    expect(byName.get("Slow-date rescue")).toMatchObject({
      condition: {
        booking_speed_operator: "at_most",
        booking_speed_level: "much_slower",
        booking_speed_window_days: 30,
        booking_speed_cooldown_days: 7,
      },
      action: { action_direction: "decrease", action_value: 15 },
    });
    expect(byName.get("Slow-date trim")).toMatchObject({
      condition: {
        booking_speed_operator: "is",
        booking_speed_level: "slower",
        booking_speed_window_days: 30,
        booking_speed_cooldown_days: 7,
      },
      action: { action_direction: "decrease", action_value: 7 },
    });
    expect(byName.get("Warm-date bump")).toMatchObject({
      condition: {
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 30,
        booking_speed_cooldown_days: 3,
      },
      action: { action_direction: "increase", action_value: 10 },
    });
    expect(byName.get("Hot-week surge")).toMatchObject({
      condition: {
        booking_speed_operator: "at_least",
        booking_speed_level: "much_faster",
        booking_speed_window_days: 7,
        booking_speed_cooldown_days: 2,
      },
      action: { action_direction: "increase", action_value: 25 },
    });
    expect(byName.get("Sudden-spike catcher")).toMatchObject({
      condition: {
        booking_speed_operator: "at_least",
        booking_speed_level: "surging",
        booking_speed_window_days: 1,
        booking_speed_cooldown_days: 1,
      },
      action: { action_direction: "increase", action_value: 25 },
    });
  });

  it("keeps the two slow rules disjoint: rescue takes much_slower and below, trim takes exactly slower", () => {
    const rescue = byName.get("Slow-date rescue")!;
    const trim = byName.get("Slow-date trim")!;
    expect(rescue.condition.booking_speed_operator).toBe("at_most");
    expect(trim.condition.booking_speed_operator).toBe("is");
    expect(rescue.condition.booking_speed_level).not.toBe(trim.condition.booking_speed_level);
  });

  it("waits longer after decreases than after increases", () => {
    const cuts = rules.filter((r) => r.action.action_direction === "decrease");
    const raises = rules.filter((r) => r.action.action_direction === "increase");
    const minCutCooldown = Math.min(...cuts.map((r) => r.condition.booking_speed_cooldown_days!));
    const maxRaiseCooldown = Math.max(...raises.map((r) => r.condition.booking_speed_cooldown_days!));
    expect(minCutCooldown).toBeGreaterThan(maxRaiseCooldown);
  });

  it("gives stronger rules higher priority so same-run competition escalates correctly", () => {
    const p = (name: string) => byName.get(name)!.priority;
    expect(p("Sudden-spike catcher")).toBeGreaterThan(p("Hot-week surge"));
    expect(p("Hot-week surge")).toBeGreaterThan(p("Warm-date bump"));
    expect(p("Slow-date rescue")).toBeGreaterThan(p("Slow-date trim"));
  });

  it("refuses to generate rules from thin history", () => {
    expect(computeStarterRules({ daysOfHistory: 30 })).toHaveLength(0);
  });

  it("every rule explains itself plainly, without math symbols", () => {
    for (const r of rules) {
      expect(r.explanation.length).toBeGreaterThan(40);
      expect(r.explanation).not.toMatch(NO_MATH_SYMBOLS);
    }
  });
});

describe("computeOccupancyReference", () => {
  it("derives the surge and peak marks from the property's own distribution", () => {
    const ref = computeOccupancyReference(
      occupancySeries({ busyShare: 0.2, busyLevel: 0.9, quietLevel: 0.5 }),
    );
    expect(ref).toEqual({ surgePct: 85, peakPct: 95 });
  });

  it("clamps marks for an always-full property", () => {
    const ref = computeOccupancyReference(Array(400).fill(0.98));
    expect(ref!.surgePct).toBeLessThanOrEqual(85);
    expect(ref!.peakPct).toBeLessThanOrEqual(95);
  });

  it("returns null on thin history", () => {
    expect(computeOccupancyReference(Array(30).fill(0.5))).toBeNull();
  });
});
