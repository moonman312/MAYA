import { describe, expect, it } from "vitest";
import { isoDatePlus, simulate, type SimRoomType, type SimScenario } from "./simulator";
import type { EngineRule } from "@/types/domain";

const STANDARD: SimRoomType = {
  id: "rt-standard",
  name: "Standard",
  total_rooms: 20,
  floor_price: 100,
  ceiling_price: 400,
};
const SUITE: SimRoomType = {
  id: "rt-suite",
  name: "Suite",
  total_rooms: 10,
  floor_price: 200,
  ceiling_price: 900,
};

function makeRule(over: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "r1",
    hotel_id: "h1",
    name: "Test rule",
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
    condition: { occupancy_operator: "gt", occupancy_threshold: 0.6 },
    signal_room_type_ids: [STANDARD.id],
    affected_room_type_ids: [STANDARD.id],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function scenario(over: Partial<SimScenario> = {}): SimScenario {
  return {
    stayDate: "2026-10-15", // a Thursday
    evalDate: "2026-09-15",
    hotelTimeZone: "UTC",
    rooms: {
      [STANDARD.id]: { basePrice: 200, occupancyPct: 80, pickupUnits: 0 },
      [SUITE.id]: { basePrice: 400, occupancyPct: 80, pickupUnits: 0 },
    },
    bookingSpeedLevel: null,
    bookingSpeedWindowDays: 7,
    ...over,
  };
}

describe("simulate: it runs the real engine, not a lookalike", () => {
  it("fires an occupancy rule and applies the engine's percent math", () => {
    const [standard] = simulate([makeRule()], [STANDARD], scenario());
    expect(standard.outcomes[0].fired).toBe(true);
    expect(standard.finalPrice).toBe(220); // 200 * 1.10
    expect(standard.clampedBy).toBe("none");
  });

  it("does not fire when occupancy sits below the threshold", () => {
    const s = scenario({
      rooms: {
        [STANDARD.id]: { basePrice: 200, occupancyPct: 50, pickupUnits: 0 },
        [SUITE.id]: { basePrice: 400, occupancyPct: 50, pickupUnits: 0 },
      },
    });
    const [standard] = simulate([makeRule()], [STANDARD], s);
    expect(standard.outcomes[0].fired).toBe(false);
    expect(standard.outcomes[0].skipReason).toBe("condition_not_met");
    expect(standard.finalPrice).toBe(200);
  });

  it("treats equality as no match, exactly like the engine (never >=)", () => {
    // 60% of 20 rooms = 12 booked, occupancy 0.6, threshold 0.6.
    const s = scenario({
      rooms: {
        [STANDARD.id]: { basePrice: 200, occupancyPct: 60, pickupUnits: 0 },
        [SUITE.id]: { basePrice: 400, occupancyPct: 60, pickupUnits: 0 },
      },
    });
    const [standard] = simulate([makeRule()], [STANDARD], s);
    expect(standard.outcomes[0].fired).toBe(false);
  });

  it("stacks percents multiplicatively in rule_id order, like applyAdjustments", () => {
    const rules = [
      makeRule({ id: "r-b", action_value: 7 }),
      makeRule({ id: "r-a", action_value: 5 }),
    ];
    const [standard] = simulate(rules, [STANDARD], scenario());
    // 200 * 1.05 * 1.07 — order is a wash for percents, but the specs must be sorted
    expect(standard.ladder.map((l) => l.rule_id)).toEqual(["r-a", "r-b"]);
    expect(standard.finalPrice).toBeCloseTo(224.7, 2);
  });

  it("applies ladder effects before pickup effects", () => {
    const rules = [
      makeRule({ id: "r-ladder", action_value: 10 }),
      makeRule({
        id: "r-pickup",
        is_pickup_rule: true,
        action_type: "fixed",
        action_value: 15,
        condition: { pickup_operator: "gt", pickup_threshold: 2, pickup_metric: "room_nights" },
      }),
    ];
    const s = scenario({
      rooms: {
        [STANDARD.id]: { basePrice: 200, occupancyPct: 80, pickupUnits: 5 },
        [SUITE.id]: { basePrice: 400, occupancyPct: 80, pickupUnits: 0 },
      },
    });
    const [standard] = simulate(rules, [STANDARD], s);
    // 200 * 1.10 = 220, then + 15 = 235. Fixed-first would give 236.5.
    expect(standard.finalPrice).toBe(235);
  });
});

describe("simulate: clamping is the engine's, not a second opinion", () => {
  it("caps at the ceiling and says so", () => {
    const [standard] = simulate(
      [makeRule({ action_value: 200 })],
      [STANDARD],
      scenario(),
    );
    expect(standard.preClampPrice).toBe(600);
    expect(standard.finalPrice).toBe(400);
    expect(standard.clampedBy).toBe("ceiling");
  });

  it("floors a deep discount rather than emitting it", () => {
    const [standard] = simulate(
      [makeRule({ action_direction: "decrease", action_value: 90 })],
      [STANDARD],
      scenario(),
    );
    expect(standard.finalPrice).toBe(100);
    expect(standard.clampedBy).toBe("floor");
  });
});

describe("simulate: scope", () => {
  it("previews a switched-off rule but reports that it is off", () => {
    const [standard] = simulate([makeRule({ is_active: false })], [STANDARD], scenario());
    expect(standard.outcomes[0].isActive).toBe(false);
    expect(standard.outcomes[0].fired).toBe(true);
    expect(standard.finalPrice).toBe(220);
  });

  it("blames the date window when the stay date falls outside it", () => {
    const rule = makeRule({ start_date: "2026-12-01", end_date: "2026-12-31" });
    const [standard] = simulate([rule], [STANDARD], scenario());
    expect(standard.outcomes[0].skipReason).toBe("date_window");
  });

  it("blames the day of week when only the DOW mask excludes it", () => {
    // 2026-10-15 is a Thursday (ISO weekday 4, bit 8). Allow everything but that.
    const rule = makeRule({ dow_mask: 127 - 8 });
    const [standard] = simulate([rule], [STANDARD], scenario());
    expect(standard.outcomes[0].skipReason).toBe("day_of_week");
  });

  it("skips a room type the rule does not price", () => {
    const results = simulate([makeRule()], [STANDARD, SUITE], scenario());
    const suite = results.find((r) => r.roomType.id === SUITE.id)!;
    expect(suite.outcomes[0].skipReason).toBe("not_affected");
    expect(suite.finalPrice).toBe(400);
  });

  it("reads occupancy from the SIGNAL room types, not the priced one", () => {
    // Watch the suites (quiet), price the standards (busy). The rule must not
    // fire off the standards' 90%.
    const rule = makeRule({
      signal_room_type_ids: [SUITE.id],
      affected_room_type_ids: [STANDARD.id],
    });
    const s = scenario({
      rooms: {
        [STANDARD.id]: { basePrice: 200, occupancyPct: 90, pickupUnits: 0 },
        [SUITE.id]: { basePrice: 400, occupancyPct: 20, pickupUnits: 0 },
      },
    });
    const standard = simulate([rule], [STANDARD, SUITE], s)[0];
    expect(standard.outcomes[0].occupancySeen).toBeCloseTo(0.2, 5);
    expect(standard.outcomes[0].fired).toBe(false);
  });

  it("flags a rule with no room types attached instead of silently dropping it", () => {
    const rule = makeRule({ affected_room_type_ids: [], signal_room_type_ids: [] });
    const [standard] = simulate([rule], [STANDARD], scenario());
    expect(standard.outcomes[0].skipReason).toBe("no_room_types");
  });
});

describe("simulate: days to arrival", () => {
  it("computes DTA from the stay date and the evaluation date", () => {
    const rule = makeRule({
      condition: { dta_operator: "lt", dta_threshold_days: 40 },
    });
    const [standard] = simulate([rule], [STANDARD], scenario());
    expect(standard.outcomes[0].dta).toBe(30);
    expect(standard.outcomes[0].fired).toBe(true);
  });

  it("does not fire a last-minute rule for a far-out stay date", () => {
    const rule = makeRule({ condition: { dta_operator: "lt", dta_threshold_days: 7 } });
    const [standard] = simulate([rule], [STANDARD], scenario());
    expect(standard.outcomes[0].fired).toBe(false);
  });
});

describe("simulate: booking speed refuses to guess", () => {
  const speedRule = makeRule({
    is_pickup_rule: true,
    condition: {
      booking_speed_operator: "at_least",
      booking_speed_level: "faster",
      booking_speed_window_days: 7,
    },
  });

  it("does not fire when the scenario has no booking-speed history", () => {
    const [standard] = simulate([speedRule], [STANDARD], scenario({ bookingSpeedLevel: null }));
    expect(standard.outcomes[0].fired).toBe(false);
    expect(standard.outcomes[0].skipReason).toBe("condition_not_met");
  });

  it("fires when the scenario sets a fast enough level", () => {
    const s = scenario({ bookingSpeedLevel: "much_faster" });
    const [standard] = simulate([speedRule], [STANDARD], s);
    expect(standard.outcomes[0].fired).toBe(true);
    expect(standard.finalPrice).toBe(220);
  });

  it("does not fire when the level is below what the rule asks for", () => {
    const s = scenario({ bookingSpeedLevel: "slower" });
    const [standard] = simulate([speedRule], [STANDARD], s);
    expect(standard.outcomes[0].fired).toBe(false);
  });
});

describe("simulate: pickup metrics", () => {
  it("sums pickup room nights across the signal set", () => {
    const rule = makeRule({
      is_pickup_rule: true,
      signal_room_type_ids: [STANDARD.id, SUITE.id],
      affected_room_type_ids: [STANDARD.id],
      condition: { pickup_operator: "gt", pickup_threshold: 6, pickup_metric: "room_nights" },
    });
    const s = scenario({
      rooms: {
        [STANDARD.id]: { basePrice: 200, occupancyPct: 50, pickupUnits: 4 },
        [SUITE.id]: { basePrice: 400, occupancyPct: 50, pickupUnits: 4 },
      },
    });
    const standard = simulate([rule], [STANDARD, SUITE], s)[0];
    expect(standard.outcomes[0].fired).toBe(true); // 8 > 6
  });

  it("values a revenue-metric rule at the base prices the owner set", () => {
    const rule = makeRule({
      is_pickup_rule: true,
      condition: { pickup_operator: "gt", pickup_threshold: 1500, pickup_metric: "revenue" },
    });
    const s = scenario({
      rooms: {
        [STANDARD.id]: { basePrice: 200, occupancyPct: 50, pickupUnits: 8 },
        [SUITE.id]: { basePrice: 400, occupancyPct: 50, pickupUnits: 0 },
      },
    });
    const [standard] = simulate([rule], [STANDARD], s);
    expect(standard.outcomes[0].fired).toBe(true); // 8 * 200 = 1600 > 1500
  });
});

describe("simulate: a room type with no scenario input", () => {
  it("prices from zero rather than throwing", () => {
    const s = scenario({ rooms: {} });
    const [standard] = simulate([makeRule()], [STANDARD], s);
    expect(standard.basePrice).toBe(0);
    // No occupancy data means an occupancy rule cannot fire.
    expect(standard.outcomes[0].skipReason).toBe("no_occupancy_data");
    // Zero is below the floor, so the guardrail still applies.
    expect(standard.finalPrice).toBe(100);
  });
});

describe("simulate: the room-type list is the whole catalog", () => {
  it("loses sight of a signal room type that is left out of the list", () => {
    // Documents the contract rather than endorsing it: pass a partial catalog
    // and a rule watching an omitted room type reads as having no occupancy.
    const rule = makeRule({
      signal_room_type_ids: [SUITE.id],
      affected_room_type_ids: [STANDARD.id],
    });
    const partial = simulate([rule], [STANDARD], scenario())[0];
    expect(partial.outcomes[0].skipReason).toBe("no_occupancy_data");

    const whole = simulate([rule], [STANDARD, SUITE], scenario())[0];
    expect(whole.outcomes[0].skipReason).toBe(null);
  });
});

describe("isoDatePlus", () => {
  it("moves forward by whole days on the UTC calendar", () => {
    expect(isoDatePlus(30, new Date("2026-09-15T23:30:00Z"))).toBe("2026-10-15");
  });

  it("crosses a year boundary correctly", () => {
    expect(isoDatePlus(1, new Date("2026-12-31T00:00:00Z"))).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(isoDatePlus(1, new Date("2028-02-28T00:00:00Z"))).toBe("2028-02-29");
  });
});
