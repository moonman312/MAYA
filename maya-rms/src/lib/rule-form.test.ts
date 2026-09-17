import { describe, expect, it } from "vitest";
import { ruleWaitDays } from "@/lib/engine/pickup";
import type { EngineRule, RuleCondition } from "@/types/domain";
import {
  BOOKING_SPEED_WAIT_OPTIONS,
  DEFAULT_BOOKING_SPEED_WAIT_DAYS,
  RULE_FIRES_HELP,
  bookingSpeedWaitLabel,
  conditionRowsToRuleCondition,
  directionalBookingSpeedOperator,
  eventRuleWaitDays,
  isRuleConditionEmpty,
  newConditionRow,
  pickupWindowSetsWait,
  ruleConditionForInsert,
} from "./rule-form";

describe("threshold parsing rejects empty/negative instead of clamping to 0", () => {
  // Number("") and Number("  ") are both 0 and finite — a cleared field
  // used to silently become a legitimate "above 0%" condition, true for
  // every stay date with any booking at all.
  it("drops an occupancy row when the value is empty or whitespace", () => {
    for (const value of ["", "   "]) {
      const c = conditionRowsToRuleCondition([newConditionRow("occupancy", { value })]);
      expect(c.occupancy_operator).toBeUndefined();
      expect(isRuleConditionEmpty(c)).toBe(true);
    }
  });

  it("rejects a negative occupancy value rather than clamping it to 0", () => {
    const c = conditionRowsToRuleCondition([newConditionRow("occupancy", { value: "-5" })]);
    expect(c.occupancy_operator).toBeUndefined();
    expect(isRuleConditionEmpty(c)).toBe(true);
  });

  it("still accepts a genuine literal 0 — the string check, not the value, is the gate", () => {
    const c = conditionRowsToRuleCondition([newConditionRow("occupancy", { value: "0" })]);
    expect(c.occupancy_operator).toBe("gt");
    expect(c.occupancy_threshold).toBe(0);
    expect(isRuleConditionEmpty(c)).toBe(false);
  });

  it("clamps an occupancy value above 100 down to 100, but does not reject it", () => {
    const c = conditionRowsToRuleCondition([newConditionRow("occupancy", { value: "150" })]);
    expect(c.occupancy_threshold).toBe(1);
  });

  it("applies the same empty/negative rejection to booking window and pickup rows", () => {
    const bw = conditionRowsToRuleCondition([newConditionRow("booking_window", { value: "" })]);
    expect(bw.dta_operator).toBeUndefined();

    const bwNeg = conditionRowsToRuleCondition([newConditionRow("booking_window", { value: "-3" })]);
    expect(bwNeg.dta_operator).toBeUndefined();

    const pu = conditionRowsToRuleCondition([newConditionRow("pickup", { value: "" })]);
    expect(pu.pickup_operator).toBeUndefined();
  });

  it("a normal positive threshold still parses exactly as before", () => {
    const c = conditionRowsToRuleCondition([newConditionRow("occupancy", { value: "80" })]);
    expect(c.occupancy_operator).toBe("gt");
    expect(c.occupancy_threshold).toBe(0.8);
  });
});

describe("booking speed condition rows", () => {
  it("maps a booking speed row, deriving the one sane operator from the level", () => {
    const rows = [
      newConditionRow("booking_speed", {
        booking_speed_level: "much_slower",
        booking_speed_window_days: 30,
      }),
    ];
    const c = conditionRowsToRuleCondition(rows);
    expect(c).toEqual({
      booking_speed_operator: "at_most", // below Normal -> "that slow or slower"
      booking_speed_level: "much_slower",
      booking_speed_window_days: 30,
      booking_speed_cooldown_days: 7, // the builder's default: a week
    });
    expect(isRuleConditionEmpty(c)).toBe(false);
    expect(ruleConditionForInsert(c)).toEqual(c);
  });

  it("derives the operator from the level's side of Normal", () => {
    expect(directionalBookingSpeedOperator("stalled")).toBe("at_most");
    expect(directionalBookingSpeedOperator("slower")).toBe("at_most");
    expect(directionalBookingSpeedOperator("normal")).toBe("is");
    expect(directionalBookingSpeedOperator("faster")).toBe("at_least");
    expect(directionalBookingSpeedOperator("surging")).toBe("at_least");
  });

  it("drops rows with an unknown level key", () => {
    const rows = [
      newConditionRow("booking_speed", { booking_speed_level: "way_too_fast" }),
    ];
    const c = conditionRowsToRuleCondition(rows);
    expect(c.booking_speed_operator).toBeUndefined();
    expect(isRuleConditionEmpty(c)).toBe(true);
  });

  it("keeps the cooldown only when the family is present and sane", () => {
    expect(
      ruleConditionForInsert({
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 7,
        booking_speed_cooldown_days: 7.4,
      }).booking_speed_cooldown_days,
    ).toBe(7);
    expect(
      ruleConditionForInsert({
        occupancy_operator: "gt",
        occupancy_threshold: 0.7,
        booking_speed_cooldown_days: 7,
      }),
    ).toEqual({ occupancy_operator: "gt", occupancy_threshold: 0.7 });
  });

  it("combines with other families and defaults sensibly", () => {
    const rows = [
      newConditionRow("occupancy", { operator: "lt", value: "40" }),
      newConditionRow("booking_speed"),
    ];
    const c = conditionRowsToRuleCondition(rows);
    expect(c.occupancy_operator).toBe("lt");
    expect(c.booking_speed_operator).toBe("at_least"); // derived: faster is above Normal
    expect(c.booking_speed_level).toBe("faster");
    expect(c.booking_speed_window_days).toBe(7);
  });
});

describe("the wait a booking speed rule keeps", () => {
  it("offers a day, two, three, a week and a fortnight, and starts on a week", () => {
    expect(BOOKING_SPEED_WAIT_OPTIONS.map((o) => o.days)).toEqual([1, 2, 3, 7, 14]);
    expect(BOOKING_SPEED_WAIT_OPTIONS.map((o) => o.label)).toEqual([
      "1 day",
      "2 days",
      "3 days",
      "1 week",
      "2 weeks",
    ]);
    expect(DEFAULT_BOOKING_SPEED_WAIT_DAYS).toBe(7);
    expect(newConditionRow("booking_speed").booking_speed_cooldown_days).toBe(7);
  });

  it("round-trips the chosen wait all the way to the row the API writes", () => {
    for (const option of BOOKING_SPEED_WAIT_OPTIONS) {
      const rows = [newConditionRow("booking_speed", { booking_speed_cooldown_days: option.days })];
      const c = conditionRowsToRuleCondition(rows);
      expect(c.booking_speed_cooldown_days).toBe(option.days);
      expect(ruleConditionForInsert(c).booking_speed_cooldown_days).toBe(option.days);
    }
  });

  it("never writes a wait the column would refuse, since stacking made zero mean every run", () => {
    expect(
      ruleConditionForInsert({
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 7,
        booking_speed_cooldown_days: 0,
      }).booking_speed_cooldown_days,
    ).toBe(1);
  });

  it("reads a rule saved before the choice existed as the week the engine gives it", () => {
    expect(bookingSpeedWaitLabel(null)).toBe("1 week");
    expect(bookingSpeedWaitLabel(undefined)).toBe("1 week");
    expect(bookingSpeedWaitLabel(1)).toBe("1 day");
    expect(bookingSpeedWaitLabel(2)).toBe("2 days");
    expect(bookingSpeedWaitLabel(14)).toBe("2 weeks");
    // A wait an API caller set that the builder does not offer still reads.
    expect(bookingSpeedWaitLabel(21)).toBe("3 weeks");
    expect(bookingSpeedWaitLabel(5)).toBe("5 days");
  });
});

describe("the wait shown is the wait the engine keeps", () => {
  const engineWait = (condition: RuleCondition) =>
    ruleWaitDays({ condition } as EngineRule);

  const cases: RuleCondition[] = [
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 1 },
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: null },
    { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 14 },
    { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" },
    { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" },
    // Mixed: the builder lets one rule carry both rows.
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 1, pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" },
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 14, pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" },
  ];

  it("gives the same number as ruleWaitDays for every shape the builder can save", () => {
    for (const condition of cases) {
      expect(
        eventRuleWaitDays({
          hasBookingSpeed: condition.booking_speed_operator != null,
          cooldownDays: condition.booking_speed_cooldown_days,
          hasPickup: condition.pickup_operator != null,
          pickupWindowDays: condition.pickup_window_days,
        }),
      ).toBe(engineWait(condition));
    }
  });

  it("says when the pickup lookback, not the dropdown, is what sets it", () => {
    const mixed = {
      hasBookingSpeed: true,
      cooldownDays: 1,
      hasPickup: true,
      pickupWindowDays: 7,
    };
    expect(eventRuleWaitDays(mixed)).toBe(7);
    expect(pickupWindowSetsWait(mixed)).toBe(true);
    expect(pickupWindowSetsWait({ ...mixed, cooldownDays: 14 })).toBe(false);
    expect(pickupWindowSetsWait({ ...mixed, hasPickup: false })).toBe(false);
  });
});

describe("what the rules table says a fire is", () => {
  it("counts every time the rule acted, repeats included, in plain words", () => {
    const words = [RULE_FIRES_HELP.title, ...RULE_FIRES_HELP.lines].join(" ");
    expect(words).toContain("once per night and room type");
    expect(words).toContain("more than once");
    expect(words).not.toContain("\u2014");
    expect(words).not.toMatch(/[<>]/);
  });
});
