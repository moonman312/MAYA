import { describe, expect, it } from "vitest";
import { basePriceKey, selectPickupWinner } from "./pickup";
import type { EngineRule } from "@/types/domain";
import type { PickupCandidate, RuleMetrics } from "./types";

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
    is_pickup_rule: true,
    condition: {
      dta_operator: "lt",
      dta_threshold_days: 30,
      pickup_operator: "gt",
      pickup_threshold: 5,
      pickup_window_days: 3,
      pickup_metric: "room_nights",
    },
    signal_room_type_ids: ["rt1"],
    affected_room_type_ids: ["rt1"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const baseMetrics: RuleMetrics = {
  occupancy: 0.5,
  dta: 14,
  net_pickup_units: 6,
  net_pickup_revenue: 1200,
};

function makeCandidate(rule: EngineRule, rtId: string = "rt1", stayDate: string = "2026-07-15"): PickupCandidate {
  return {
    rule,
    metrics: baseMetrics,
    stay_date: stayDate,
    baseline_ts: "2026-07-12T02:30:00Z",
    affected_room_type_id: rtId,
    eval_ts: "2026-07-15T02:30:00Z",
    signal_booked_units_start: 10,
    signal_booked_units_end: 16,
    signal_booked_revenue_start: 2000,
    signal_booked_revenue_end: 3200,
  };
}

describe("pickup competition (§7.3, §15.5)", () => {
  it("single candidate wins unopposed", () => {
    const c = makeCandidate(makeRule());
    const winner = selectPickupWinner([c], new Map());
    expect(winner).toBe(c);
  });

  it("higher priority wins (step 1)", () => {
    const ruleA = makeRule({ id: "rA", priority: 100 });
    const ruleB = makeRule({ id: "rB", priority: 200 });
    const cA = makeCandidate(ruleA);
    const cB = makeCandidate(ruleB);
    const winner = selectPickupWinner([cA, cB], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("more specific rule wins on priority tie (step 2)", () => {
    const ruleA = makeRule({
      id: "rA",
      priority: 100,
      condition: {
        dta_operator: "lt",
        dta_threshold_days: 30,
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 3,
        pickup_metric: "room_nights",
      },
    });
    const ruleB = makeRule({
      id: "rB",
      priority: 100,
      condition: {
        occupancy_operator: "gt",
        occupancy_threshold: 0.4,
        dta_operator: "lt",
        dta_threshold_days: 30,
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 3,
        pickup_metric: "room_nights",
      },
    });
    const cA = makeCandidate(ruleA);
    const cB = makeCandidate(ruleB);
    const winner = selectPickupWinner([cA, cB], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("stricter pickup threshold wins on specificity tie (step 3, gt)", () => {
    const ruleA = makeRule({ id: "rA", condition: { ...makeRule().condition, pickup_threshold: 5, pickup_operator: "gt" } });
    const ruleB = makeRule({ id: "rB", condition: { ...makeRule().condition, pickup_threshold: 8, pickup_operator: "gt" } });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("stricter pickup threshold wins on specificity tie (step 3, lt)", () => {
    const ruleA = makeRule({ id: "rA", condition: { ...makeRule().condition, pickup_threshold: 5, pickup_operator: "lt" } });
    const ruleB = makeRule({ id: "rB", condition: { ...makeRule().condition, pickup_threshold: 3, pickup_operator: "lt" } });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("rB");
  });

  it("larger adjustment value wins (step 4)", () => {
    const ruleA = makeRule({ id: "rA", action_value: 5 });
    const ruleB = makeRule({ id: "rB", action_value: 10 });
    const sd = "2026-07-15";
    const winner = selectPickupWinner(
      [makeCandidate(ruleA, "rt1", sd), makeCandidate(ruleB, "rt1", sd)],
      new Map([[basePriceKey(sd, "rt1"), 100]]),
    );
    expect(winner!.rule.id).toBe("rB");
  });

  it("older rule wins (step 5)", () => {
    const ruleA = makeRule({ id: "rA", created_at: "2026-01-01T00:00:00Z" });
    const ruleB = makeRule({ id: "rB", created_at: "2026-06-01T00:00:00Z" });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("rA");
  });

  it("lower id wins as final tie-break (step 6)", () => {
    const ruleA = makeRule({ id: "aaa" });
    const ruleB = makeRule({ id: "bbb" });
    const winner = selectPickupWinner([makeCandidate(ruleA), makeCandidate(ruleB)], new Map());
    expect(winner!.rule.id).toBe("aaa");
  });

  it("winner selection is deterministic across repeated calls", () => {
    const ruleA = makeRule({ id: "rA", priority: 150 });
    const ruleB = makeRule({ id: "rB", priority: 100 });
    const candidates = [makeCandidate(ruleA), makeCandidate(ruleB)];
    const basePrices = new Map<string, number>();

    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const w = selectPickupWinner(candidates, basePrices);
      results.add(w!.rule.id);
    }
    expect(results.size).toBe(1);
    expect(results.has("rA")).toBe(true);
  });

  it("per-room competition: overlapping affected sets compete on shared rooms (§13.2)", () => {
    const ruleX = makeRule({
      id: "rX",
      priority: 100,
      action_value: 5,
      affected_room_type_ids: ["standard"],
    });
    const ruleY = makeRule({
      id: "rY",
      priority: 100,
      action_value: 10,
      affected_room_type_ids: ["standard", "deluxe"],
      condition: {
        ...makeRule().condition,
        pickup_threshold: 5,
        pickup_operator: "gt",
      },
    });

    const sd = "2026-07-15";
    const stdWinner = selectPickupWinner(
      [makeCandidate(ruleX, "standard", sd), makeCandidate(ruleY, "standard", sd)],
      new Map([[basePriceKey(sd, "standard"), 100]]),
    );
    expect(stdWinner!.rule.id).toBe("rY");

    const dlxWinner = selectPickupWinner(
      [makeCandidate(ruleY, "deluxe", sd)],
      new Map([[basePriceKey(sd, "deluxe"), 200]]),
    );
    expect(dlxWinner!.rule.id).toBe("rY");
  });

  it("empty candidates returns null", () => {
    expect(selectPickupWinner([], new Map())).toBeNull();
  });
});
