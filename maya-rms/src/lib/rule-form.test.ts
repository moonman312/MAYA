import { describe, expect, it } from "vitest";
import {
  conditionRowsToRuleCondition,
  directionalBookingSpeedOperator,
  isRuleConditionEmpty,
  newConditionRow,
  ruleConditionForInsert,
} from "./rule-form";

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
