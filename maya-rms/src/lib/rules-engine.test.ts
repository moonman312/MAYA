import { describe, expect, it } from "vitest";
import { simulateRateChanges } from "./rules-engine";
import type { RuleConfig, SimulationReservation } from "@/types/domain";

/* ── Helpers ──────────────────────────────────────────────────── */

function makeRule(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return {
    id: "1",
    rule_name: "Test Rule",
    conditions: {},
    action: {},
    room_types: [],
    enabled: true,
    ...overrides,
  };
}

function makeRes(overrides: Partial<SimulationReservation> = {}): SimulationReservation {
  return {
    room_type: "Standard",
    occupancy_percentage: 75,
    booking_window: 14,
    pickup_rate: 3,
    current_rate: 200,
    ...overrides,
  };
}

/* ── simulateRateChanges ──────────────────────────────────────── */

describe("simulateRateChanges", () => {
  it("returns unchanged rates when no rules match", () => {
    const rules = [makeRule({ conditions: { occupancy_percentage: ">90" } })];
    const res = [makeRes({ occupancy_percentage: 50 })];
    const [result] = simulateRateChanges(rules, res);
    expect(result.new_rate).toBe(200);
    expect(result.applied_rules).toBe("");
  });

  it("returns unchanged rates when rules list is empty", () => {
    const [result] = simulateRateChanges([], [makeRes()]);
    expect(result.new_rate).toBe(200);
    expect(result.original_rate).toBe(200);
    expect(result.applied_rules).toBe("");
  });

  it("applies a percentage increase", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">70" },
        action: { adjust_rate_percent: 10 },
      }),
    ];
    const [result] = simulateRateChanges(rules, [makeRes()]);
    expect(result.new_rate).toBe(220);
    expect(result.applied_rules).toBe("Test Rule");
  });

  it("applies a percentage decrease", () => {
    const rules = [
      makeRule({
        rule_name: "Discount",
        conditions: { occupancy_percentage: ">50" },
        action: { adjust_rate_percent: -10 },
      }),
    ];
    const [result] = simulateRateChanges(rules, [makeRes()]);
    expect(result.new_rate).toBe(180);
  });

  it("applies a dollar adjustment", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">70" },
        action: { adjust_rate_dollars: 25 },
      }),
    ];
    const [result] = simulateRateChanges(rules, [makeRes()]);
    expect(result.new_rate).toBe(225);
  });

  it("applies negative dollar adjustment", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">50" },
        action: { adjust_rate_dollars: -30 },
      }),
    ];
    const [result] = simulateRateChanges(rules, [makeRes()]);
    expect(result.new_rate).toBe(170);
  });

  it("applies both percent and dollar in one rule (percent first)", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">50" },
        action: { adjust_rate_percent: 10, adjust_rate_dollars: 20 },
      }),
    ];
    const [result] = simulateRateChanges(rules, [makeRes()]);
    // 200 * 1.10 = 220, then + 20 = 240
    expect(result.new_rate).toBe(240);
  });

  it("stacks multiple matching rules", () => {
    const rules = [
      makeRule({
        id: "1",
        rule_name: "Rule A",
        conditions: { occupancy_percentage: ">50" },
        action: { adjust_rate_percent: 10 },
      }),
      makeRule({
        id: "2",
        rule_name: "Rule B",
        conditions: { booking_window: "<20" },
        action: { adjust_rate_dollars: 15 },
      }),
    ];
    const [result] = simulateRateChanges(rules, [makeRes()]);
    // 200 * 1.10 = 220, then + 15 = 235
    expect(result.new_rate).toBe(235);
    expect(result.applied_rules).toBe("Rule A, Rule B");
  });

  it("preserves original_rate in the result", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">50" },
        action: { adjust_rate_percent: 50 },
      }),
    ];
    const [result] = simulateRateChanges(rules, [makeRes()]);
    expect(result.original_rate).toBe(200);
    expect(result.new_rate).toBe(300);
  });

  it("handles multiple reservations independently", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">80" },
        action: { adjust_rate_percent: 10 },
      }),
    ];
    const reservations = [
      makeRes({ room_type: "Standard", occupancy_percentage: 90, current_rate: 100 }),
      makeRes({ room_type: "Deluxe", occupancy_percentage: 50, current_rate: 200 }),
    ];
    const results = simulateRateChanges(rules, reservations);
    expect(results[0].new_rate).toBe(110); // rule fires
    expect(results[1].new_rate).toBe(200); // rule doesn't fire
  });

  it("rounds to two decimal places", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">50" },
        action: { adjust_rate_percent: 33 },
      }),
    ];
    const res = [makeRes({ current_rate: 100 })];
    const [result] = simulateRateChanges(rules, res);
    expect(result.new_rate).toBe(133); // 100 * 1.33 = 133.00
  });
});

/* ── Condition matching (tested via simulateRateChanges) ──────── */

describe("condition matching", () => {
  it("handles > operator", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">80" },
        action: { adjust_rate_dollars: 10 },
      }),
    ];
    // exactly 80 should NOT match (> not >=)
    expect(simulateRateChanges(rules, [makeRes({ occupancy_percentage: 80 })])[0].new_rate).toBe(200);
    expect(simulateRateChanges(rules, [makeRes({ occupancy_percentage: 81 })])[0].new_rate).toBe(210);
  });

  it("handles < operator", () => {
    const rules = [
      makeRule({
        conditions: { booking_window: "<5" },
        action: { adjust_rate_dollars: 20 },
      }),
    ];
    expect(simulateRateChanges(rules, [makeRes({ booking_window: 5 })])[0].new_rate).toBe(200);
    expect(simulateRateChanges(rules, [makeRes({ booking_window: 4 })])[0].new_rate).toBe(220);
  });

  it("handles = operator", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: "=75" },
        action: { adjust_rate_dollars: 5 },
      }),
    ];
    expect(simulateRateChanges(rules, [makeRes({ occupancy_percentage: 75 })])[0].new_rate).toBe(205);
    expect(simulateRateChanges(rules, [makeRes({ occupancy_percentage: 76 })])[0].new_rate).toBe(200);
  });

  it("handles numeric equality (no operator prefix)", () => {
    const rules = [
      makeRule({
        conditions: { pickup_rate: "3" },
        action: { adjust_rate_dollars: 10 },
      }),
    ];
    expect(simulateRateChanges(rules, [makeRes({ pickup_rate: 3 })])[0].new_rate).toBe(210);
    expect(simulateRateChanges(rules, [makeRes({ pickup_rate: 4 })])[0].new_rate).toBe(200);
  });

  it("requires all conditions to match (AND logic)", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">80", booking_window: "<10" },
        action: { adjust_rate_dollars: 50 },
      }),
    ];
    // only occ matches
    expect(
      simulateRateChanges(rules, [makeRes({ occupancy_percentage: 90, booking_window: 20 })])[0].new_rate,
    ).toBe(200);
    // only window matches
    expect(
      simulateRateChanges(rules, [makeRes({ occupancy_percentage: 50, booking_window: 5 })])[0].new_rate,
    ).toBe(200);
    // both match
    expect(
      simulateRateChanges(rules, [makeRes({ occupancy_percentage: 90, booking_window: 5 })])[0].new_rate,
    ).toBe(250);
  });

  it("skips rule when condition references unknown field", () => {
    const rules = [
      makeRule({
        conditions: { nonexistent_field: ">50" },
        action: { adjust_rate_dollars: 100 },
      }),
    ];
    expect(simulateRateChanges(rules, [makeRes()])[0].new_rate).toBe(200);
  });

  it("filters by room type", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">50" },
        action: { adjust_rate_dollars: 30 },
        room_types: ["Deluxe"],
      }),
    ];
    // Standard should be skipped
    expect(simulateRateChanges(rules, [makeRes({ room_type: "Standard" })])[0].new_rate).toBe(200);
    // Deluxe should match
    expect(simulateRateChanges(rules, [makeRes({ room_type: "Deluxe" })])[0].new_rate).toBe(230);
  });

  it("empty room_types array means all room types", () => {
    const rules = [
      makeRule({
        conditions: { occupancy_percentage: ">50" },
        action: { adjust_rate_dollars: 10 },
        room_types: [],
      }),
    ];
    expect(simulateRateChanges(rules, [makeRes({ room_type: "Standard" })])[0].new_rate).toBe(210);
    expect(simulateRateChanges(rules, [makeRes({ room_type: "Suite" })])[0].new_rate).toBe(210);
  });
});
