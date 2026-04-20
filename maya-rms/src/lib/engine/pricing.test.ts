import { describe, expect, it } from "vitest";
import { applyAdjustments, clampPrice } from "./pricing";
import type { AdjustmentSpec } from "./types";

describe("pricing math (§10, §15.6)", () => {
  it("applies fixed increase", () => {
    const adj: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "fixed", action_direction: "increase", action_value: 20 },
    ];
    expect(applyAdjustments(100, adj, [])).toBe(120);
  });

  it("applies fixed decrease", () => {
    const adj: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "fixed", action_direction: "decrease", action_value: 20 },
    ];
    expect(applyAdjustments(100, adj, [])).toBe(80);
  });

  it("applies percent increase", () => {
    const adj: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 10 },
    ];
    expect(applyAdjustments(100, adj, [])).toBe(110);
  });

  it("applies percent decrease", () => {
    const adj: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "percent", action_direction: "decrease", action_value: 10 },
    ];
    expect(applyAdjustments(100, adj, [])).toBe(90);
  });

  it("stacks percents multiplicatively (§13.1)", () => {
    const adj: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 5 },
      { rule_id: "r2", action_kind: "percent", action_direction: "increase", action_value: 7 },
    ];
    // 100 * 1.05 * 1.07 = 112.35
    expect(applyAdjustments(100, adj, [])).toBeCloseTo(112.35, 2);
  });

  it("applies ladder then pickup in order (§10.2)", () => {
    const ladder: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 10 },
    ];
    const pickup: AdjustmentSpec[] = [
      { rule_id: "r2", action_kind: "fixed", action_direction: "increase", action_value: 15 },
    ];
    // 100 * 1.10 = 110, then + 15 = 125
    expect(applyAdjustments(100, ladder, pickup)).toBe(125);
  });

  it("mixed percent and fixed compose correctly", () => {
    const ladder: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 10 },
      { rule_id: "r2", action_kind: "fixed", action_direction: "increase", action_value: 20 },
    ];
    // 100 * 1.10 = 110, then + 20 = 130
    expect(applyAdjustments(100, ladder, [])).toBe(130);
  });
});

describe("clamping (§10.3, §15.6)", () => {
  it("ceiling clamp actually caps", () => {
    const result = clampPrice(250, 50, 200);
    expect(result.final).toBe(200);
    expect(result.clamped_by).toBe("ceiling");
  });

  it("floor clamp actually floors", () => {
    const result = clampPrice(30, 50, 200);
    expect(result.final).toBe(50);
    expect(result.clamped_by).toBe("floor");
  });

  it("no clamping when in range", () => {
    const result = clampPrice(150, 50, 200);
    expect(result.final).toBe(150);
    expect(result.clamped_by).toBe("none");
  });

  it("extreme negative adjustments clamp to floor, never produce negative prices", () => {
    const adj: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "percent", action_direction: "decrease", action_value: 200 },
    ];
    const preClamp = applyAdjustments(100, adj, []);
    expect(preClamp).toBe(-100);
    const result = clampPrice(preClamp, 10, 500);
    expect(result.final).toBe(10);
    expect(result.clamped_by).toBe("floor");
  });

  it("price exactly at floor is not clamped", () => {
    const result = clampPrice(50, 50, 200);
    expect(result.final).toBe(50);
    expect(result.clamped_by).toBe("none");
  });

  it("price exactly at ceiling is not clamped", () => {
    const result = clampPrice(200, 50, 200);
    expect(result.final).toBe(200);
    expect(result.clamped_by).toBe("none");
  });
});

describe("scenario: base-price change between runs (§13.4)", () => {
  it("adjustment spec, not frozen dollar delta, is reapplied", () => {
    const adj: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 10 },
    ];
    // Run 1: base = 100
    expect(applyAdjustments(100, adj, [])).toBe(110);
    // Run 2: base = 120 (base changed, same spec)
    expect(applyAdjustments(120, adj, [])).toBe(132);
  });
});

describe("scenario: pickup re-fire stacking (§13.3)", () => {
  it("two pickup events stack multiplicatively", () => {
    const pickup: AdjustmentSpec[] = [
      { rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 8 },
      { rule_id: "r1", action_kind: "percent", action_direction: "increase", action_value: 8 },
    ];
    // base * 1.08 * 1.08
    expect(applyAdjustments(100, [], pickup)).toBeCloseTo(116.64, 2);
  });
});
