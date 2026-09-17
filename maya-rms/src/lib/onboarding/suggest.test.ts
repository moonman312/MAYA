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
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    signal_room_type_ids: ["rt1"],
    affected_room_type_ids: ["rt1"],
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

  it("does not re-offer the pace ladder when it's merely paused, not gone (regression)", () => {
    // A disabled booking-speed rule still counts as "someone owns pace
    // coverage here" — pausing the ladder is a normal seasonal action, not
    // an invitation to re-offer all 5 rules as fresh adds and create active
    // duplicates of a set the owner will likely re-enable later.
    const out = computeRuleSuggestions([bookingSpeedRule({ is_active: false })], PACE_SPECS, null);
    expect(out.filter((s) => s.suggestion_type === "add_rule")).toHaveLength(0);
  });

  it("makes no occupancy adjustments without a reference", () => {
    const existing = [rule({ id: "a", occupancy_threshold: 0.4 }), bookingSpeedRule()];
    expect(computeRuleSuggestions(existing, PACE_SPECS, null)).toHaveLength(0);
  });

  it("recommends deleting a raw-pickup rule only once the pace ladder actually already exists", () => {
    const pickupRule = rule({
      id: "pk1",
      name: "Old pickup spike",
      is_pickup_rule: true,
      occupancy_operator: null,
      occupancy_threshold: null,
      pickup_operator: "gt",
      pickup_threshold: 6,
    });
    // The ladder is merely being PROPOSED (a sibling add_rule finding), not
    // live yet — each finding resolves independently, so suggesting removal
    // here on a "the pace rules now cover this" rationale would be false if
    // the owner accepts the removal and dismisses the adds.
    const offered = computeRuleSuggestions([pickupRule], PACE_SPECS, null);
    expect(offered.filter((s) => s.suggestion_type === "remove_rule")).toHaveLength(0);

    // Pace rules genuinely already exist — the pickup rule really does conflict.
    const existing = computeRuleSuggestions([pickupRule, bookingSpeedRule()], PACE_SPECS, null);
    const removes = existing.filter((s) => s.suggestion_type === "remove_rule");
    expect(removes).toHaveLength(1);
    expect(removes[0]).toMatchObject({ rule_id: "pk1", rule_name: "Old pickup spike" });
  });

  it("never suggests removing a pickup rule the ladder's scope doesn't actually contain", () => {
    const pickup = (o: Partial<ExistingRuleSummary>) =>
      rule({
        id: "pk1",
        name: "Scoped pickup",
        is_pickup_rule: true,
        occupancy_operator: null,
        occupancy_threshold: null,
        pickup_operator: "gt",
        pickup_threshold: 6,
        ...o,
      });
    const removesFor = (bs: ExistingRuleSummary, pk: ExistingRuleSummary) =>
      computeRuleSuggestions([bs, pk], PACE_SPECS, null).filter(
        (s) => s.suggestion_type === "remove_rule",
      );

    // Pickup prices a room type the ladder doesn't touch — e.g. a Penthouse
    // added to the PMS after the ladder was generated.
    expect(
      removesFor(
        bookingSpeedRule({ affected_room_type_ids: ["rt1", "rt2"] }),
        pickup({ affected_room_type_ids: ["rt-penthouse"] }),
      ),
    ).toHaveLength(0);
    // Partial overlap is still not containment.
    expect(
      removesFor(
        bookingSpeedRule({ affected_room_type_ids: ["rt1"] }),
        pickup({ affected_room_type_ids: ["rt1", "rt2"] }),
      ),
    ).toHaveLength(0);
    // Ladder only runs weekdays; pickup covers all days.
    expect(
      removesFor(bookingSpeedRule({ dow_mask: 31 }), pickup({ dow_mask: 127 })),
    ).toHaveLength(0);
    // Ladder windowed to one season; pickup is always-on.
    expect(
      removesFor(
        bookingSpeedRule({ start_date: "2026-06-01", end_date: "2026-08-31" }),
        pickup({}),
      ),
    ).toHaveLength(0);
    // A ladder rule with no signal or no affected room types never fires,
    // so it covers nothing.
    expect(removesFor(bookingSpeedRule({ signal_room_type_ids: [] }), pickup({}))).toHaveLength(0);
    expect(
      removesFor(
        bookingSpeedRule({ affected_room_type_ids: [] }),
        pickup({ affected_room_type_ids: [] }),
      ),
    ).toHaveLength(0);
    // A ladder watching only some of the room types does not replace a
    // pickup rule that watched others, even where the prices land.
    expect(
      removesFor(
        bookingSpeedRule({ signal_room_type_ids: ["rt-standard"], affected_room_type_ids: ["rt1"] }),
        pickup({ signal_room_type_ids: ["rt1"], affected_room_type_ids: ["rt1"] }),
      ),
    ).toHaveLength(0);
    // A PAUSED ladder covers nothing either — it also suppresses re-offering
    // the adds, so without this a hotel with a paused ladder would get
    // removal suggestions with no active coverage anywhere.
    expect(removesFor(bookingSpeedRule({ is_active: false }), pickup({}))).toHaveLength(0);
  });

  it("still suggests removal when the ladder's scope genuinely contains the pickup rule's", () => {
    const pickup = (o: Partial<ExistingRuleSummary>) =>
      rule({
        id: "pk1",
        name: "Scoped pickup",
        is_pickup_rule: true,
        occupancy_operator: null,
        occupancy_threshold: null,
        pickup_operator: "gt",
        pickup_threshold: 6,
        ...o,
      });
    const removesFor = (bs: ExistingRuleSummary, pk: ExistingRuleSummary) =>
      computeRuleSuggestions([bs, pk], PACE_SPECS, null).filter(
        (s) => s.suggestion_type === "remove_rule",
      );

    // Ladder watches more room types than the pickup rule did.
    expect(
      removesFor(
        bookingSpeedRule({ signal_room_type_ids: ["rt1", "rt2"] }),
        pickup({ signal_room_type_ids: ["rt2"] }),
      ),
    ).toHaveLength(1);
    // Ladder covers more room types than the pickup rule prices.
    expect(
      removesFor(
        bookingSpeedRule({ affected_room_type_ids: ["rt1", "rt2", "rt3"] }),
        pickup({ affected_room_type_ids: ["rt2"] }),
      ),
    ).toHaveLength(1);
    // Weekend-only pickup under an all-days ladder.
    expect(
      removesFor(bookingSpeedRule({ dow_mask: 127 }), pickup({ dow_mask: 96 })),
    ).toHaveLength(1);
    // Always-on ladder covers a date-windowed pickup rule.
    expect(
      removesFor(
        bookingSpeedRule({}),
        pickup({ start_date: "2026-12-01", end_date: "2026-12-31" }),
      ),
    ).toHaveLength(1);
    // Annual windows compare month-day with year-end wrap, same as the
    // engine: a Nov-Feb ladder contains a Dec-Jan pickup rule.
    expect(
      removesFor(
        bookingSpeedRule({ is_annual: true, start_date: "2026-11-01", end_date: "2027-02-28" }),
        pickup({ is_annual: true, start_date: "2026-12-01", end_date: "2027-01-31" }),
      ),
    ).toHaveLength(1);
  });

  it("never flags booking-speed rules or disabled pickup rules as conflicts", () => {
    const out = computeRuleSuggestions(
      [
        bookingSpeedRule(),
        rule({
          id: "pk2",
          is_active: false,
          is_pickup_rule: true,
          occupancy_operator: null,
          occupancy_threshold: null,
          pickup_operator: "gt",
          pickup_threshold: 4,
        }),
      ],
      PACE_SPECS,
      null,
    );
    expect(out.filter((s) => s.suggestion_type === "remove_rule")).toHaveLength(0);
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

  it("does not set a p99-derived ceiling below MIN_ROWS_TO_TRUST_P99, even though the floor still applies", () => {
    // The review's exact reproduction: 49 nights @ $200 plus one $10,000
    // fat-finger (n=50) gives percentile_cont(0.99) ~5198 — at that row
    // count the outlier IS most of what p99 measures, so "p99 x 1.5, never
    // the raw max" was false. Below MIN_ROWS_TO_TRUST_P99 the ceiling must
    // stay unset rather than land at a contaminated $7,800 on a $200 room.
    const out = computeInitialGuardrails([
      rtIn({ row_count: 50, observed_median_rate: 200, observed_p99_rate: 5198 }),
    ]);
    expect(out.find((g) => g.field === "ceiling_price")).toBeUndefined();
    expect(out.find((g) => g.field === "floor_price")).toMatchObject({ value: 80 }); // median-based, unaffected
  });

  it("sets the p99-derived ceiling again once row_count clears MIN_ROWS_TO_TRUST_P99", () => {
    const out = computeInitialGuardrails([rtIn({ row_count: 200, observed_p99_rate: 400 })]);
    expect(out.find((g) => g.field === "ceiling_price")).toMatchObject({ value: 600 });
  });

  it("never proposes a ceiling below a floor the strategy projection already set (regression)", () => {
    // projectStrategyOntoRoomTypes runs first and can set floor_price on
    // every active room type regardless of that room type's own rates — a
    // cheap add-on-ish room type (p99 80) under a $150 answered floor would
    // otherwise get a ceiling patch of 120, violating floor<=ceiling and
    // getting silently rejected by the DB.
    const out = computeInitialGuardrails([
      rtIn({ row_count: 200, floor_price: 150, observed_p99_rate: 80, observed_median_rate: 70 }),
    ]);
    expect(out.find((g) => g.field === "ceiling_price")).toBeUndefined();
  });

  it("still proposes the ceiling when it genuinely clears the already-set floor", () => {
    const out = computeInitialGuardrails([
      rtIn({ row_count: 200, floor_price: 90, observed_p99_rate: 400, observed_median_rate: 220 }),
    ]);
    expect(out.find((g) => g.field === "ceiling_price")).toMatchObject({ value: 600 });
  });
});

describe("computeGuardrailSuggestions", () => {
  const rt = (o: Partial<Parameters<typeof computeGuardrailSuggestions>[0][number]>) => ({
    room_type_id: "rt1",
    name: "Deluxe King",
    floor_price: 1.0, // schema default = unset
    ceiling_price: 99999.99, // schema default = unset
    observed_p99_rate: 400,
    observed_median_rate: 220,
    row_count: 500,
    ...o,
  });
  const NO_ANSWERS = { floor: null, ceiling: null };

  it("fills unset guardrails, preferring the user's own strategy answers", () => {
    const out = computeGuardrailSuggestions([rt({})], { floor: 79, ceiling: 500 });
    expect(out).toHaveLength(2);
    // Their stated floor (79) beats the median-derived 90.
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
    // Nor with no answers, where the data would otherwise fill both.
    expect(computeGuardrailSuggestions([rt({ floor_price: 45, ceiling_price: 350 })], NO_ANSWERS)).toHaveLength(0);
  });

  it("derives both guardrails from observed rates when no strategy answer exists", () => {
    const out = computeGuardrailSuggestions([rt({})], NO_ANSWERS);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ field: "floor_price", suggested: 90 }); // median 220 * 0.4 -> 88 -> 90
    expect(out[1]).toMatchObject({ field: "ceiling_price", suggested: 600 }); // p99 400 * 1.5
  });

  it("suggests exactly what a first import would have written from the same data", () => {
    const cases = [
      rt({}),
      rt({ observed_median_rate: 18, observed_p99_rate: 40 }), // clamped to MIN_DATA_FLOOR
      rt({ observed_median_rate: 137.5, observed_p99_rate: 263 }), // rounding both ways
      rt({ row_count: 50, observed_median_rate: 200, observed_p99_rate: 5198 }), // floor only
      rt({ row_count: 30 }), // right at the floor's row bar
      rt({ floor_price: 60 }), // one set, one default
      rt({ ceiling_price: 300 }),
      rt({ floor_price: 700 }), // a set floor above what the data would cap at
    ];
    for (const c of cases) {
      const suggested = computeGuardrailSuggestions([c], NO_ANSWERS).map((s) => [s.field, s.suggested]);
      const written = computeInitialGuardrails([c]).map((g) => [g.field, g.value]);
      expect(suggested.sort()).toEqual(written.sort());
    }
  });

  it("uses the same row-count bars as the first import: 30 nights for a floor, 200 for a ceiling", () => {
    expect(computeGuardrailSuggestions([rt({ row_count: 29 })], NO_ANSWERS)).toHaveLength(0);
    const at30 = computeGuardrailSuggestions([rt({ row_count: 30 })], NO_ANSWERS);
    expect(at30.map((s) => s.field)).toEqual(["floor_price"]);
    const at200 = computeGuardrailSuggestions([rt({ row_count: 200 })], NO_ANSWERS);
    expect(at200.map((s) => s.field)).toEqual(["floor_price", "ceiling_price"]);
  });

  it("a single fat-fingered rate cannot inflate the suggested ceiling", () => {
    // The $24,000 typo scenario: max is absurd but p99 stays sane, and the
    // ceiling suggestion follows p99 — the typo never becomes the baseline.
    const out = computeGuardrailSuggestions([rt({ observed_p99_rate: 418 })], NO_ANSWERS);
    expect(out.find((s) => s.field === "ceiling_price")!.suggested).toBeLessThan(1000);
  });

  it("suggests no guardrails for room types flagged as probably-not-rooms", () => {
    expect(
      computeGuardrailSuggestions([rt({})], { floor: 79, ceiling: 500 }, new Set(["rt1"])),
    ).toHaveLength(0);
    // The data-derived pair is skipped just the same.
    expect(computeGuardrailSuggestions([rt({})], NO_ANSWERS, new Set(["rt1"]))).toHaveLength(0);
  });

  it("does not suggest a p99-derived ceiling below MIN_ROWS_TO_TRUST_P99 (refresh mode has the same exposure)", () => {
    const out = computeGuardrailSuggestions(
      [rt({ row_count: 50, observed_median_rate: 200, observed_p99_rate: 5198 })],
      NO_ANSWERS,
    );
    expect(out.find((s) => s.field === "ceiling_price")).toBeUndefined();
    // The median-based floor has no such problem.
    expect(out.find((s) => s.field === "floor_price")).toMatchObject({ suggested: 80 });
  });

  it("still lets the owner's own strategy ceiling apply even when p99 is untrusted", () => {
    const out = computeGuardrailSuggestions(
      [rt({ row_count: 50, observed_p99_rate: 5198 })],
      { floor: null, ceiling: 450 },
    );
    expect(out.find((s) => s.field === "ceiling_price")).toMatchObject({ suggested: 450 });
  });

  it("suggests nothing when there is nothing to go on", () => {
    const out = computeGuardrailSuggestions(
      [rt({ observed_p99_rate: null, observed_median_rate: null })],
      NO_ANSWERS,
    );
    expect(out).toHaveLength(0);
  });

  it("never suggests a floor that meets or exceeds the ceiling it's about to suggest (regression)", () => {
    // The review's exact reproduction: strategy.floor=150 (a hotel-wide
    // answer keyed to standard rooms) against a Budget Single whose own
    // p99 is 90 — a floor=150/ceiling=140 pair is impossible to accept,
    // since whichever field lands second violates floor<=ceiling and 500s.
    // Nor does a lower data floor stand in for the answer the owner gave.
    const out = computeGuardrailSuggestions([rt({ observed_p99_rate: 90, observed_median_rate: 70 })], {
      floor: 150,
      ceiling: null,
    });
    expect(out.find((s) => s.field === "floor_price")).toBeUndefined();
    expect(out.find((s) => s.field === "ceiling_price")).toMatchObject({ suggested: 140 });
  });

  it("also skips the floor when it would only tie the ceiling (a fixed-price pin, not just a violation)", () => {
    const out = computeGuardrailSuggestions([rt({ observed_p99_rate: 100 })], {
      floor: 150,
      ceiling: null,
    });
    expect(out.find((s) => s.field === "ceiling_price")).toMatchObject({ suggested: 150 });
    expect(out.find((s) => s.field === "floor_price")).toBeUndefined();
  });

  it("still suggests the floor when it genuinely clears the ceiling target", () => {
    const out = computeGuardrailSuggestions([rt({ observed_p99_rate: 400 })], {
      floor: 79,
      ceiling: null,
    });
    expect(out.find((s) => s.field === "floor_price")).toMatchObject({ suggested: 79 });
    expect(out.find((s) => s.field === "ceiling_price")).toMatchObject({ suggested: 600 });
  });

  it("checks the floor against an already-set ceiling too, not just a freshly-computed one", () => {
    const out = computeGuardrailSuggestions([rt({ ceiling_price: 120 })], {
      floor: 150,
      ceiling: null,
    });
    expect(out.find((s) => s.field === "floor_price")).toBeUndefined();
  });

  it("never suggests a ceiling at or under a floor someone already set", () => {
    // p99 400 would cap at 600, and an owner answer of 500 would too, but
    // this room type's floor is already 700: either card would 500 on accept.
    expect(computeGuardrailSuggestions([rt({ floor_price: 700 })], NO_ANSWERS)).toHaveLength(0);
    expect(computeGuardrailSuggestions([rt({ floor_price: 700 })], { floor: null, ceiling: 500 })).toHaveLength(0);
    expect(computeGuardrailSuggestions([rt({ floor_price: 600 })], NO_ANSWERS)).toHaveLength(0);
    expect(computeGuardrailSuggestions([rt({ floor_price: 590 })], NO_ANSWERS)).toMatchObject([
      { field: "ceiling_price", suggested: 600 },
    ]);
  });

  it("holds the data floor to the same floor-below-ceiling bar", () => {
    // Median 220 gives a data floor of 90: over a human-set $80 ceiling, and
    // tying a room type that has only ever sold at $10 (under 200 rows, so
    // its own p99 is the bound), neither is suggested.
    expect(
      computeGuardrailSuggestions([rt({ ceiling_price: 80 })], NO_ANSWERS).find((s) => s.field === "floor_price"),
    ).toBeUndefined();
    expect(
      computeGuardrailSuggestions(
        [rt({ row_count: 50, observed_median_rate: 10, observed_p99_rate: 10 })],
        NO_ANSWERS,
      ),
    ).toHaveLength(0);
  });

  it("says where each number came from, in plain words", () => {
    const fromData = computeGuardrailSuggestions([rt({})], NO_ANSWERS);
    expect(fromData.map((s) => s.rationale)).toEqual([
      "Deluxe King has typically sold for $220 a night, so MAYA suggests a floor of $90.",
      "Deluxe King has rarely sold for more than $400 a night, so MAYA suggests a ceiling of $600.",
    ]);
    const fromAnswers = computeGuardrailSuggestions([rt({})], { floor: 79.5, ceiling: 500 });
    expect(fromAnswers.map((s) => s.rationale)).toEqual([
      "You said the lowest rate you'd accept is $79.50, so MAYA suggests that as the floor.",
      "You said the most you'd charge for a night is $500, so MAYA suggests that as the ceiling.",
    ]);
    for (const s of [...fromData, ...fromAnswers]) expect(s.rationale).not.toMatch(/[—–]/);
  });

  it("rounds the observed rates it quotes and uses the hotel's currency", () => {
    const [floor, ceiling] = computeGuardrailSuggestions(
      [rt({ observed_median_rate: 1234.4, observed_p99_rate: 2399.6 })],
      NO_ANSWERS,
      new Set(),
      "EUR",
    );
    expect(floor.rationale).toBe("Deluxe King has typically sold for €1,234 a night, so MAYA suggests a floor of €495.");
    expect(ceiling.rationale).toBe(
      "Deluxe King has rarely sold for more than €2,400 a night, so MAYA suggests a ceiling of €3,600.",
    );
    const [chf] = computeGuardrailSuggestions([rt({})], NO_ANSWERS, new Set(), "CHF");
    expect(chf.rationale).toContain("CHF 220");
  });
});
