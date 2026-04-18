import { describe, expect, it } from "vitest";
import { computeDta, computeNetPickup, computeOccupancy } from "./metrics";

describe("DTA (§5.1)", () => {
  it("computes days until arrival correctly", () => {
    expect(computeDta("2026-07-20", "2026-07-15")).toBe(5);
    expect(computeDta("2026-07-15", "2026-07-15")).toBe(0);
    expect(computeDta("2026-08-15", "2026-07-15")).toBe(31);
  });
});

describe("occupancy (§5.2, §15.2)", () => {
  it("combined occupancy across a multi-room signal set", () => {
    const snapMap = new Map<string, { booked_units: number; sellable_units: number }>([
      ["rt1", { booked_units: 20, sellable_units: 40 }],
      ["rt2", { booked_units: 10, sellable_units: 30 }],
      ["rt3", { booked_units: 5, sellable_units: 15 }],
    ]);
    // Combined: 35/85
    const occ = computeOccupancy(snapMap, ["rt1", "rt2", "rt3"]);
    expect(occ).toBeCloseTo(35 / 85, 5);
  });

  it("is sum of numerators / sum of denominators, not average of ratios", () => {
    const snapMap = new Map([
      ["rt1", { booked_units: 1, sellable_units: 1 }],   // 100%
      ["rt2", { booked_units: 0, sellable_units: 100 }],  // 0%
    ]);
    // Average of ratios would be 50%, but sum/sum = 1/101
    const occ = computeOccupancy(snapMap, ["rt1", "rt2"]);
    expect(occ).toBeCloseTo(1 / 101, 5);
  });

  it("zero denominator → null (not zero)", () => {
    const snapMap = new Map([
      ["rt1", { booked_units: 0, sellable_units: 0 }],
    ]);
    expect(computeOccupancy(snapMap, ["rt1"])).toBeNull();
  });

  it("missing room type in snapshot → skipped", () => {
    const snapMap = new Map([
      ["rt1", { booked_units: 10, sellable_units: 20 }],
    ]);
    expect(computeOccupancy(snapMap, ["rt1", "rt_missing"])).toBeCloseTo(0.5, 5);
  });

  it("all signal rooms zero sellable → null", () => {
    const snapMap = new Map([
      ["rt1", { booked_units: 0, sellable_units: 0 }],
      ["rt2", { booked_units: 0, sellable_units: 0 }],
    ]);
    expect(computeOccupancy(snapMap, ["rt1", "rt2"])).toBeNull();
  });
});

describe("net pickup (§5.3, §15.4)", () => {
  it("computes delta between current and baseline", () => {
    const current = new Map([
      ["rt1", { booked_units: 20, booked_revenue: 4000 }],
    ]);
    const baseline = new Map([
      ["rt1", { booked_units: 14, booked_revenue: 2800 }],
    ]);
    const pickup = computeNetPickup(current, baseline, ["rt1"]);
    expect(pickup.units).toBe(6);
    expect(pickup.revenue).toBe(1200);
  });

  it("handles cancellations (negative pickup)", () => {
    const current = new Map([
      ["rt1", { booked_units: 8, booked_revenue: 1600 }],
    ]);
    const baseline = new Map([
      ["rt1", { booked_units: 12, booked_revenue: 2400 }],
    ]);
    const pickup = computeNetPickup(current, baseline, ["rt1"]);
    expect(pickup.units).toBe(-4);
    expect(pickup.revenue).toBe(-800);
  });

  it("combines across multiple signal room types", () => {
    const current = new Map([
      ["rt1", { booked_units: 10, booked_revenue: 2000 }],
      ["rt2", { booked_units: 5, booked_revenue: 1000 }],
    ]);
    const baseline = new Map([
      ["rt1", { booked_units: 7, booked_revenue: 1400 }],
      ["rt2", { booked_units: 3, booked_revenue: 600 }],
    ]);
    const pickup = computeNetPickup(current, baseline, ["rt1", "rt2"]);
    expect(pickup.units).toBe(5);
    expect(pickup.revenue).toBe(1000);
  });

  it("misaligned baseline map throws (handled upstream in computeRuleMetrics)", () => {
    const current = new Map([
      ["rt1", { booked_units: 10, booked_revenue: 2000 }],
      ["rt2", { booked_units: 1, booked_revenue: 100 }],
    ]);
    const baseline = new Map([["rt1", { booked_units: 7, booked_revenue: 1400 }]]);
    expect(() => computeNetPickup(current, baseline, ["rt1", "rt2"])).toThrow();
  });
});
