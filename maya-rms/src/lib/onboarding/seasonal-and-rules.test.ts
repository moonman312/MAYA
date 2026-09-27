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

  it("every rule explains itself plainly, without math symbols or em dashes", () => {
    for (const r of rules) {
      expect(r.explanation.length).toBeGreaterThan(40);
      expect(r.explanation).not.toMatch(NO_MATH_SYMBOLS);
      expect(r.explanation).not.toMatch(/\u2014/);
    }
  });

  it("never promises a cut that cannot repeat, because every one of them can", () => {
    for (const r of rules) {
      expect(r.explanation).not.toContain("never pile up");
      expect(r.explanation).not.toContain("cuts never");
    }
  });

  it("says the rule acts again after its wait, in each rule's own words", () => {
    // What the engine does: after the wait, a condition that still holds fires
    // again (pickup.ts fire numbering, booking_speed_cooldown_days).
    expect(byName.get("Slow-date rescue")!.explanation).toContain("cuts again");
    expect(byName.get("Slow-date trim")!.explanation).toContain("trims again");
    expect(byName.get("Warm-date bump")!.explanation).toContain("raises again");
    expect(byName.get("Hot-week surge")!.explanation).toContain("steps up again");
    expect(byName.get("Sudden-spike catcher")!.explanation).toContain("repeated daily");
  });

  it("says a rule that acts again judges only the bookings since its or a stronger rule's latest change still on the night", () => {
    // engine/pickup.ts countFromFireAt: a rule counts from the newest raise
    // or cut still on the night by itself or a stronger rule that moves the
    // price the same way; a weaker rule's never moves it, and one that came
    // off for cancellations covers nothing (Jake, 2026-09-24, option A). Among the starters the rescue ranks ahead of the trim, and
    // the spike rule ahead of the week rule, both ahead of the month rule,
    // so their changes cover the weaker ones; an owner's own rule can rank
    // ahead of any of them.
    expect(byName.get("Slow-date rescue")!.explanation).toContain(
      "judges only the bookings made since this rule or a stronger one's latest cut still on the night",
    );
    expect(byName.get("Slow-date trim")!.explanation).toContain(
      "looking only at bookings made since this rule or a stronger one's latest cut still on the night",
    );
    expect(byName.get("Warm-date bump")!.explanation).toContain(
      "only if the bookings made since this rule or a stronger one's latest raise still on the night are, on their own, ahead of what similar nights get in a whole month",
    );
    expect(byName.get("Warm-date bump")!.explanation).not.toContain("another rule already raised on");
    // A raise rule on "at least" a pace needs the bookings since the change
    // alone to beat a whole window's usual (keepsWholeWindowBar), so it
    // doesn't raise again on bookings that merely keep the pace up.
    expect(byName.get("Hot-week surge")!.explanation).toContain(
      "if the bookings made since this rule or a stronger one's latest raise still on the night are, on their own, far more than a normal week brings",
    );
    expect(byName.get("Hot-week surge")!.explanation).not.toContain("keep coming that fast");
    for (const r of rules) {
      expect(r.explanation).not.toContain("the night is still");
      expect(r.explanation).not.toContain("while demand holds");
      expect(r.explanation).not.toContain("whichever rule");
      expect(r.explanation).not.toContain("the night was last");
      expect(r.explanation).not.toMatch(/last (raised|cut) the night/);
    }
  });

  it("says a raise comes back off when cancellations leave it short of its pace, and never promises that of a cut", () => {
    // engine/pickup.ts cancellationsUndo: every starter rule is ticked; the
    // raises are on "at least" a pace, which cancellations can make false,
    // and the cuts on a slow pace, which they only make slower.
    for (const name of ["Warm-date bump", "Hot-week surge", "Sudden-spike catcher"]) {
      // It stays while bookings made since keep the rule true, so the blurb
      // speaks of the night, not only the bookings the raise counted.
      expect(byName.get(name)!.explanation).toMatch(/If guests cancel and that leaves .*, the raise comes back off\.$/);
      expect(byName.get(name)!.explanation).not.toMatch(/bookings a raise counted|what is left of that day/);
    }
    for (const name of ["Slow-date rescue", "Slow-date trim"]) {
      expect(byName.get(name)!.explanation).not.toMatch(/cancel/);
    }
    for (const r of rules) expect(r.explanation).not.toContain("enough of the bookings");
  });

  it("says the cut rules look at full days only", () => {
    // engine/booking-speed-provider.ts countsCompleteDays.
    expect(byName.get("Slow-date rescue")!.explanation).toContain("It looks at full days only, up to yesterday.");
    expect(byName.get("Slow-date trim")!.explanation).toContain("It looks at full days only, up to yesterday.");
    for (const name of ["Warm-date bump", "Hot-week surge", "Sudden-spike catcher"]) {
      expect(byName.get(name)!.explanation).not.toContain("full days");
    }
  });

  it("tells the owner about the alert on the rules that can run away", () => {
    // Three of a rule's changes still on one night is where MAYA asks
    // (engine/repeat-alerts.ts counts the ones still on the price).
    const told = rules.filter((r) => /once three of its (raises|cuts) are on the same night/.test(r.explanation));
    expect(told.map((r) => r.name)).toEqual([
      "Slow-date rescue",
      "Hot-week surge",
      "Sudden-spike catcher",
    ]);
  });

  it("only claims a raise comes back off where the cancellation test can take it off", () => {
    // The starter cuts are on a slow pace, which cancellations only make
    // slower (cancellableParts leaves it out), so nothing cancelled undoes them.
    for (const r of rules.filter((x) => x.action.action_direction === "decrease")) {
      expect(r.explanation).not.toContain("comes back off");
    }
    expect(byName.get("Warm-date bump")!.explanation).toContain("the raise comes back off");
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
