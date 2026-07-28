import { describe, expect, it } from "vitest";
import {
  computeGuardrailSuggestions,
  computeRuleSuggestions,
  type ExistingRuleSummary,
} from "../../../supabase/functions/_shared/onboarding/suggest";
import { computeStarterRules } from "../../../supabase/functions/_shared/onboarding/generate-rules";

function specs() {
  // This series yields p80 -> 85% and p95 -> 95% thresholds.
  const occ: number[] = [];
  for (let i = 0; i < 700; i++) occ.push(i % 100 < 20 ? 0.9 : 0.5);
  return computeStarterRules({
    dailyOccupancyFractions: occ,
    totalRooms: 40,
    pricingConfidence: null,
  });
}

function rule(o: Partial<ExistingRuleSummary>): ExistingRuleSummary {
  return {
    id: "r1",
    name: "My rule",
    is_active: true,
    is_pickup_rule: false,
    occupancy_operator: "gt",
    occupancy_threshold: 0.85,
    pickup_operator: null,
    pickup_threshold: null,
    ...o,
  };
}

describe("computeRuleSuggestions", () => {
  it("suggests everything for a hotel with no rules", () => {
    const out = computeRuleSuggestions([], specs());
    expect(out.filter((s) => s.suggestion_type === "add_rule")).toHaveLength(3);
  });

  it("stays silent when existing rules already match the data", () => {
    const existing = [
      rule({ id: "a", occupancy_threshold: 0.85 }),
      rule({ id: "b", occupancy_threshold: 0.95 }),
      rule({
        id: "c",
        is_pickup_rule: true,
        occupancy_operator: null,
        occupancy_threshold: null,
        pickup_operator: "gt",
        pickup_threshold: 6,
      }),
    ];
    expect(computeRuleSuggestions(existing, specs())).toHaveLength(0);
  });

  it("suggests adjusting a threshold that drifted far from the data", () => {
    const existing = [
      rule({ id: "a", name: "High season bump", occupancy_threshold: 0.7 }),
      rule({
        id: "c",
        is_pickup_rule: true,
        occupancy_operator: null,
        occupancy_threshold: null,
        pickup_operator: "gt",
        pickup_threshold: 6,
      }),
    ];
    const out = computeRuleSuggestions(existing, specs());
    const adjusts = out.filter((s) => s.suggestion_type === "adjust_rule");
    expect(adjusts.length).toBeGreaterThanOrEqual(1);
    expect(adjusts[0]).toMatchObject({ rule_id: "a", rule_name: "High season bump" });
  });

  it("never suggests touching a rule within tolerance of the data", () => {
    // 88/93 vs the data's 85/95 — close enough; silence.
    const existing = [
      rule({ id: "a", occupancy_threshold: 0.88 }),
      rule({ id: "b", occupancy_threshold: 0.93 }),
      rule({
        id: "c",
        is_pickup_rule: true,
        occupancy_operator: null,
        occupancy_threshold: null,
        pickup_operator: "gt",
        pickup_threshold: 4,
      }),
    ];
    const out = computeRuleSuggestions(existing, specs());
    expect(out.filter((s) => s.suggestion_type === "adjust_rule")).toHaveLength(0);
  });

  it("suggests a pickup rule when none exists", () => {
    const existing = [rule({ id: "a" }), rule({ id: "b", occupancy_threshold: 0.95 })];
    const out = computeRuleSuggestions(existing, specs());
    const adds = out.filter((s) => s.suggestion_type === "add_rule");
    expect(adds).toHaveLength(1);
    expect((adds[0] as { spec: { is_pickup_rule: boolean } }).spec.is_pickup_rule).toBe(true);
  });

  it("ignores disabled rules when judging coverage", () => {
    const existing = [rule({ id: "a", is_active: false })];
    const out = computeRuleSuggestions(existing, specs());
    // Disabled rule covers nothing — all three should be suggested.
    expect(out.filter((s) => s.suggestion_type === "add_rule")).toHaveLength(3);
  });
});

describe("computeGuardrailSuggestions", () => {
  const rt = (o: Partial<Parameters<typeof computeGuardrailSuggestions>[0][number]>) => ({
    room_type_id: "rt1",
    name: "Deluxe King",
    floor_price: 1.0, // schema default = unset
    ceiling_price: 99999.99, // schema default = unset
    observed_max_rate: 400,
    ...o,
  });

  it("fills unset guardrails", () => {
    const out = computeGuardrailSuggestions([rt({})], { floor: 79, ceiling: 500 });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ field: "floor_price", suggested: 79 });
    expect(out[1]).toMatchObject({ field: "ceiling_price", suggested: 500 });
  });

  it("NEVER questions a guardrail a human already set", () => {
    const out = computeGuardrailSuggestions(
      [rt({ floor_price: 45, ceiling_price: 350 })],
      { floor: 79, ceiling: 500 }, // data disagrees — doesn't matter
    );
    expect(out).toHaveLength(0);
  });

  it("derives a ceiling from observed rates when no strategy answer exists", () => {
    const out = computeGuardrailSuggestions([rt({})], { floor: null, ceiling: null });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ field: "ceiling_price", suggested: 500 }); // 400 * 1.25
  });

  it("suggests nothing when there is nothing to go on", () => {
    const out = computeGuardrailSuggestions([rt({ observed_max_rate: null })], {
      floor: null,
      ceiling: null,
    });
    expect(out).toHaveLength(0);
  });
});
