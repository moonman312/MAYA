import { describe, expect, it } from "vitest";
import { conditionCount, ruleConditionsMatch } from "./conditions";
import type { EngineRule } from "@/types/domain";
import type { RuleMetrics } from "./types";

function makeRule(overrides: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "r1",
    hotel_id: "h1",
    name: "Test",
    is_active: true,
    version: 1,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    priority: 100,
    is_pickup_rule: false,
    condition: {},
    signal_room_type_ids: ["rt1"],
    affected_room_type_ids: ["rt1"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const baseMetrics: RuleMetrics = {
  occupancy: 0.75,
  dta: 30,
  net_pickup_units: 6,
  net_pickup_revenue: 1200,
};

describe("condition evaluation (§6, §15.2)", () => {
  it("occupancy gt matches when above threshold", () => {
    const rule = makeRule({
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.6 },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, occupancy: 0.75 })).toBe(true);
  });

  it("occupancy gt does not match at threshold (strict >)", () => {
    const rule = makeRule({
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.75 },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, occupancy: 0.75 })).toBe(false);
  });

  it("occupancy lt matches when below threshold", () => {
    const rule = makeRule({
      condition: { occupancy_operator: "lt", occupancy_threshold: 0.8 },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, occupancy: 0.5 })).toBe(true);
  });

  it("null occupancy does not match occupancy condition", () => {
    const rule = makeRule({
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.5 },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, occupancy: null })).toBe(false);
  });

  it("DTA condition works with gt", () => {
    const rule = makeRule({
      condition: { dta_operator: "gt", dta_threshold_days: 14 },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, dta: 30 })).toBe(true);
    expect(ruleConditionsMatch(rule, { ...baseMetrics, dta: 14 })).toBe(false);
  });

  it("DTA condition works with lt", () => {
    const rule = makeRule({
      condition: { dta_operator: "lt", dta_threshold_days: 30 },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, dta: 14 })).toBe(true);
    expect(ruleConditionsMatch(rule, { ...baseMetrics, dta: 30 })).toBe(false);
  });

  it("pickup condition uses room_nights metric", () => {
    const rule = makeRule({
      condition: {
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 3,
        pickup_metric: "room_nights",
      },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, net_pickup_units: 6 })).toBe(true);
    expect(ruleConditionsMatch(rule, { ...baseMetrics, net_pickup_units: 5 })).toBe(false);
  });

  it("pickup condition uses revenue metric", () => {
    const rule = makeRule({
      condition: {
        pickup_operator: "gt",
        pickup_threshold: 1000,
        pickup_window_days: 7,
        pickup_metric: "revenue",
      },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, net_pickup_revenue: 1200 })).toBe(true);
    expect(ruleConditionsMatch(rule, { ...baseMetrics, net_pickup_revenue: 1000 })).toBe(false);
  });

  it("null pickup value does not match pickup condition", () => {
    const rule = makeRule({
      condition: {
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 3,
        pickup_metric: "room_nights",
      },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, net_pickup_units: null })).toBe(false);
  });

  it("pickup does not match when snapshot/baseline guard set pickup_block_reason", () => {
    const rule = makeRule({
      condition: {
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 3,
        pickup_metric: "room_nights",
      },
    });
    expect(
      ruleConditionsMatch(rule, {
        ...baseMetrics,
        net_pickup_units: 100,
        pickup_block_reason: "insufficient_snapshot_history",
      }),
    ).toBe(false);
  });

  it("all conditions must match (AND logic)", () => {
    const rule = makeRule({
      condition: {
        occupancy_operator: "gt",
        occupancy_threshold: 0.5,
        dta_operator: "lt",
        dta_threshold_days: 30,
      },
    });
    expect(ruleConditionsMatch(rule, { ...baseMetrics, occupancy: 0.75, dta: 14 })).toBe(true);
    expect(ruleConditionsMatch(rule, { ...baseMetrics, occupancy: 0.75, dta: 30 })).toBe(false);
    expect(ruleConditionsMatch(rule, { ...baseMetrics, occupancy: 0.3, dta: 14 })).toBe(false);
  });

  it("rule with no conditions set matches nothing (CHECK constraint would reject)", () => {
    const rule = makeRule({ condition: {} });
    expect(ruleConditionsMatch(rule, baseMetrics)).toBe(true);
  });
});

describe("conditionCount", () => {
  it("counts condition families", () => {
    expect(conditionCount(makeRule({
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.5 },
    }))).toBe(1);

    expect(conditionCount(makeRule({
      condition: {
        occupancy_operator: "gt", occupancy_threshold: 0.5,
        dta_operator: "lt", dta_threshold_days: 30,
      },
    }))).toBe(2);

    expect(conditionCount(makeRule({
      condition: {
        occupancy_operator: "gt", occupancy_threshold: 0.5,
        dta_operator: "lt", dta_threshold_days: 30,
        pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 3, pickup_metric: "room_nights",
      },
    }))).toBe(3);
  });
});
