import { describe, expect, it } from "vitest";
import {
  computeGuardrailSuggestions,
  computeInitialGuardrails,
  computeRuleSuggestions,
  type ExistingRuleSummary,
  type InitialGuardrailInput,
} from "../../../supabase/functions/_shared/onboarding/suggest";
import { computeStarterRules } from "../../../supabase/functions/_shared/onboarding/generate-rules";

const PACE_SPECS = computeStarterRules({ daysOfHistory: 400 });
const OCC_REF = { surgePct: 85, peakPct: 95 };

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
    has_booking_speed: false,
    ...o,
  };
}

function bookingSpeedRule(o: Partial<ExistingRuleSummary> = {}): ExistingRuleSummary {
  return rule({
    id: "bs1",
    name: "Pace rule",
    is_pickup_rule: true,
    occupancy_operator: null,
    occupancy_threshold: null,
    has_booking_speed: true,
    ...o,
  });
}

describe("computeRuleSuggestions", () => {
  it("offers the whole pace ladder to a hotel with no rules", () => {
    const out = computeRuleSuggestions([], PACE_SPECS, null);
    const adds = out.filter((s) => s.suggestion_type === "add_rule");
    expect(adds).toHaveLength(5);
    for (const a of adds) {
      const spec = (a as { spec: { condition: Record<string, unknown> } }).spec;
      expect(spec.condition.booking_speed_operator).toBeDefined();
    }
  });

  it("stays silent about pace once ANY booking-speed rule exists — their setup is theirs", () => {
    const out = computeRuleSuggestions([bookingSpeedRule()], PACE_SPECS, null);
    expect(out.filter((s) => s.suggestion_type === "add_rule")).toHaveLength(0);
  });

  it("suggests adjusting an occupancy threshold that drifted far from the data's marks", () => {
    const existing = [
      rule({ id: "a", name: "High season bump", occupancy_threshold: 0.7 }),
      bookingSpeedRule(),
    ];
    const out = computeRuleSuggestions(existing, PACE_SPECS, OCC_REF);
    const adjusts = out.filter((s) => s.suggestion_type === "adjust_rule");
    expect(adjusts).toHaveLength(1);
    expect(adjusts[0]).toMatchObject({
      rule_id: "a",
      rule_name: "High season bump",
      suggested_threshold: 0.85,
    });
  });

  it("never suggests touching an occupancy rule within tolerance of the marks", () => {
    const existing = [
      rule({ id: "a", occupancy_threshold: 0.88 }),
      rule({ id: "b", occupancy_threshold: 0.93 }),
      bookingSpeedRule(),
    ];
    const out = computeRuleSuggestions(existing, PACE_SPECS, OCC_REF);
    expect(out.filter((s) => s.suggestion_type === "adjust_rule")).toHaveLength(0);
  });

  it("ignores disabled rules when judging pace coverage", () => {
    const out = computeRuleSuggestions([bookingSpeedRule({ is_active: false })], PACE_SPECS, null);
    expect(out.filter((s) => s.suggestion_type === "add_rule")).toHaveLength(5);
  });

  it("makes no occupancy adjustments without a reference", () => {
    const existing = [rule({ id: "a", occupancy_threshold: 0.4 }), bookingSpeedRule()];
    expect(computeRuleSuggestions(existing, PACE_SPECS, null)).toHaveLength(0);
  });
});

describe("computeInitialGuardrails", () => {
  const rtIn = (o: Partial<InitialGuardrailInput>): InitialGuardrailInput => ({
    room_type_id: "rt1",
    name: "Deluxe King",
    floor_price: 1.0, // schema default = unset
    ceiling_price: 99999.99, // schema default = unset
    observed_p99_rate: 400,
    observed_median_rate: 220,
    row_count: 500,
    ...o,
  });

  it("fills both guardrails from the data when everything is at defaults", () => {
    const out = computeInitialGuardrails([rtIn({})]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ field: "ceiling_price", value: 600 }); // p99 400 * 1.5
    expect(out[1]).toMatchObject({ field: "floor_price", value: 90 }); // median 220 * 0.4 -> 88 -> 90
  });

  it("NEVER touches a guardrail a human (or the strategy answers) already set", () => {
    expect(computeInitialGuardrails([rtIn({ floor_price: 45, ceiling_price: 350 })])).toHaveLength(0);
    // One set, one default: only the default gets filled.
    const out = computeInitialGuardrails([rtIn({ floor_price: 60 })]);
    expect(out).toHaveLength(1);
    expect(out[0].field).toBe("ceiling_price");
  });

  it("a fat-fingered max cannot inflate the ceiling — p99 is the basis", () => {
    const out = computeInitialGuardrails([rtIn({ observed_p99_rate: 418 })]);
    expect(out.find((g) => g.field === "ceiling_price")!.value).toBeLessThan(1000);
  });

  it("keeps the floor below the ceiling, even against a human-set low ceiling", () => {
    // Median 220 would put the data floor at 90 — fine normally, but this
    // room type has a human-set $80 ceiling, so no floor is applied.
    const out = computeInitialGuardrails([rtIn({ ceiling_price: 80 })]);
    expect(out).toHaveLength(0);
  });

  it("skips suspect room types and thin data", () => {
    expect(computeInitialGuardrails([rtIn({})], new Set(["rt1"]))).toHaveLength(0);
    expect(computeInitialGuardrails([rtIn({ row_count: 10 })])).toHaveLength(0);
    expect(
      computeInitialGuardrails([rtIn({ observed_p99_rate: null, observed_median_rate: null })]),
    ).toHaveLength(0);
  });

  it("enforces the minimum data floor for very cheap properties", () => {
    const out = computeInitialGuardrails([rtIn({ observed_median_rate: 18, observed_p99_rate: 40 })]);
    const floor = out.find((g) => g.field === "floor_price");
    expect(floor!.value).toBe(10); // 18 * 0.4 = 7.2 -> clamped to MIN_DATA_FLOOR
  });
});

describe("computeGuardrailSuggestions", () => {
  const rt = (o: Partial<Parameters<typeof computeGuardrailSuggestions>[0][number]>) => ({
    room_type_id: "rt1",
    name: "Deluxe King",
    floor_price: 1.0, // schema default = unset
    ceiling_price: 99999.99, // schema default = unset
    observed_p99_rate: 400,
    ...o,
  });

  it("fills unset guardrails, preferring the user's own strategy answers", () => {
    const out = computeGuardrailSuggestions([rt({})], { floor: 79, ceiling: 500 });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ field: "floor_price", suggested: 79 });
    // Their stated ceiling (500) beats the p99-derived 600.
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
    expect(out[0]).toMatchObject({ field: "ceiling_price", suggested: 600 }); // p99 400 * 1.5
  });

  it("a single fat-fingered rate cannot inflate the suggested ceiling", () => {
    // The $24,000 typo scenario: max is absurd but p99 stays sane, and the
    // ceiling suggestion follows p99 — the typo never becomes the baseline.
    const out = computeGuardrailSuggestions([rt({ observed_p99_rate: 418 })], {
      floor: null,
      ceiling: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].suggested).toBeLessThan(1000);
  });

  it("suggests no guardrails for room types flagged as probably-not-rooms", () => {
    const out = computeGuardrailSuggestions(
      [rt({})],
      { floor: 79, ceiling: 500 },
      new Set(["rt1"]),
    );
    expect(out).toHaveLength(0);
  });

  it("suggests nothing when there is nothing to go on", () => {
    const out = computeGuardrailSuggestions([rt({ observed_p99_rate: null })], {
      floor: null,
      ceiling: null,
    });
    expect(out).toHaveLength(0);
  });
});
