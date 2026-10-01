import { describe, expect, it } from "vitest";
import { pickupJudgesShortStretch, ruleWaitDays } from "@/lib/engine/pickup";
import type { EngineRule, RuleCondition } from "@/types/domain";
import {
  BOOKING_SPEED_WAIT_OPTIONS,
  DEFAULT_BOOKING_SPEED_WAIT_DAYS,
  FAR_OUT_CUT_GUARD_DAYS,
  FAR_OUT_CUT_GUARD_HELP,
  PICKUP_WAIT_SAME_AS_WINDOW_LABEL,
  FIRE_LOG_HELP,
  RULE_FIRES_HELP,
  bookingSpeedOwnWait,
  bookingSpeedSetsWait,
  bookingSpeedWaitLabel,
  builderDraft,
  conditionRowsToRuleCondition,
  directionalBookingSpeedOperator,
  eventRuleWaitDays,
  farOutCutFacts,
  farOutCutGuardRow,
  isFarOutCut,
  isRuleConditionEmpty,
  newConditionRow,
  pickupCountsLow,
  pickupOwnWait,
  pickupSetsWait,
  RATE_AMOUNT_BOTH,
  RATE_AMOUNT_MISSING,
  rowsAreFarOutCut,
  ruleActionError,
  ruleActionFromAmounts,
  ruleConditionForInsert,
  waitDaysLabel,
} from "./rule-form";

describe("one amount per rule", () => {
  it("uses whichever box has a number, signed by the direction", () => {
    expect(ruleActionFromAmounts("10", "", "increase")).toEqual({ action: { adjust_rate_percent: 10 } });
    expect(ruleActionFromAmounts("", "15", "decrease")).toEqual({ action: { adjust_rate_dollars: -15 } });
  });

  it("asks for an amount when neither box has one, and refuses both", () => {
    expect(ruleActionFromAmounts("", " ", "increase")).toEqual({ error: RATE_AMOUNT_MISSING });
    expect(ruleActionFromAmounts("10", "15", "increase")).toEqual({ error: RATE_AMOUNT_BOTH });
  });

  it("refuses a negative number in the box that has it", () => {
    expect(ruleActionFromAmounts("-5", "", "increase")).toMatchObject({ error: expect.stringMatching(/^Enter the percentage/) });
    expect(ruleActionFromAmounts("", "-5", "increase")).toMatchObject({ error: expect.stringMatching(/^Enter the amount/) });
  });

  it("finds both amounts in a request, whatever their values", () => {
    expect(ruleActionError({ adjust_rate_percent: 10, adjust_rate_dollars: 5 })).toBe(RATE_AMOUNT_BOTH);
    expect(ruleActionError({ adjust_rate_percent: 0, adjust_rate_dollars: null })).toBe(RATE_AMOUNT_BOTH);
    expect(ruleActionError({ adjust_rate_percent: 10 })).toBeNull();
    expect(ruleActionError({ adjust_rate_dollars: -5 })).toBeNull();
    expect(ruleActionError(undefined)).toBeNull();
  });
});

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

describe("the wait a pickup count rule keeps", () => {
  it("starts on the lookback window, saved as nothing, and offers the booking speed choices after it", () => {
    expect(newConditionRow("pickup").pickup_cooldown_days).toBeNull();
    expect(PICKUP_WAIT_SAME_AS_WINDOW_LABEL).toBe("Same as the lookback window");
    const c = conditionRowsToRuleCondition([newConditionRow("pickup", { value: "5", pickup_window_days: 7 })]);
    expect(c).toEqual({ pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" });
    expect(ruleConditionForInsert(c)).not.toHaveProperty("pickup_cooldown_days");
  });

  it("round-trips every chosen wait to the row the API writes", () => {
    for (const option of BOOKING_SPEED_WAIT_OPTIONS) {
      const rows = [newConditionRow("pickup", { value: "5", pickup_window_days: 7, pickup_cooldown_days: option.days })];
      const c = conditionRowsToRuleCondition(rows);
      expect(c.pickup_cooldown_days).toBe(option.days);
      expect(ruleConditionForInsert(c)).toEqual({
        pickup_operator: "gt",
        pickup_threshold: 5,
        pickup_window_days: 7,
        pickup_metric: "room_nights",
        pickup_cooldown_days: option.days,
      });
    }
  });

  it("never writes a wait the column would refuse, nor one without a pickup condition", () => {
    const pickup = { pickup_operator: "gt" as const, pickup_threshold: 5, pickup_window_days: 3 as const, pickup_metric: "room_nights" as const };
    expect(ruleConditionForInsert({ ...pickup, pickup_cooldown_days: 0 }).pickup_cooldown_days).toBe(1);
    expect(ruleConditionForInsert({ ...pickup, pickup_cooldown_days: 2.4 }).pickup_cooldown_days).toBe(2);
    expect(ruleConditionForInsert({ ...pickup, pickup_cooldown_days: null })).not.toHaveProperty("pickup_cooldown_days");
    expect(
      ruleConditionForInsert({ occupancy_operator: "gt", occupancy_threshold: 0.7, pickup_cooldown_days: 2 }),
    ).toEqual({ occupancy_operator: "gt", occupancy_threshold: 0.7 });
    // A row switched to another metric leaves its wait behind.
    const row = { ...newConditionRow("pickup", { pickup_cooldown_days: 2 }), metric: "occupancy" as const, value: "80" };
    expect(conditionRowsToRuleCondition([row])).not.toHaveProperty("pickup_cooldown_days");
  });

  it("says a number of days the way the dropdowns do", () => {
    expect(waitDaysLabel(1)).toBe("1 day");
    expect(waitDaysLabel(3)).toBe("3 days");
    expect(waitDaysLabel(7)).toBe("1 week");
    expect(waitDaysLabel(21)).toBe("3 weeks");
  });
});

describe("the wait shown is the wait the engine keeps", () => {
  // The engine's wait (ruleWaitDays), and for a count on low pickup the
  // whole window it must see after a change before it judges the night
  // again (pickupJudgesShortStretch).
  const engineWait = (condition: RuleCondition) => {
    const rule = { condition } as EngineRule;
    const lowWindow = condition.pickup_operator && !pickupJudgesShortStretch(rule) ? (condition.pickup_window_days ?? 3) : 0;
    return Math.max(ruleWaitDays(rule), lowWindow);
  };

  const cases: RuleCondition[] = [
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 1 },
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: null },
    { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 14 },
    { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" },
    { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" },
    // Mixed: the builder lets one rule carry both rows.
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 1, pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" },
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 14, pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" },
    // A wait chosen for the pickup condition, shorter and longer than its window.
    { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: 2 },
    { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights", pickup_cooldown_days: 14 },
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 3, pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
    { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 1, pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 1, pickup_metric: "room_nights", pickup_cooldown_days: 7 },
    // Low pickup with a wait shorter than its window: it keeps the window.
    { pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
    { pickup_operator: "gt", pickup_threshold: -2, pickup_window_days: 3, pickup_metric: "room_nights", pickup_cooldown_days: 2 },
    { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 7, booking_speed_cooldown_days: 2, pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
  ];

  it("gives the same number as ruleWaitDays for every shape the builder can save", () => {
    for (const condition of cases) {
      expect(
        eventRuleWaitDays({
          hasBookingSpeed: condition.booking_speed_operator != null,
          cooldownDays: condition.booking_speed_cooldown_days,
          hasPickup: condition.pickup_operator != null,
          pickupWindowDays: condition.pickup_window_days,
          pickupCooldownDays: condition.pickup_cooldown_days,
          pickupLow: pickupCountsLow(condition.pickup_operator, condition.pickup_threshold),
        }),
      ).toBe(engineWait(condition));
    }
  });

  it("calls a pickup count low exactly when the engine won't judge it on less than its window", () => {
    for (const [operator, threshold] of [
      ["gt", 5],
      ["gt", 0],
      ["gt", -1],
      ["lt", 3],
      ["lt", 0],
      ["lt", -2],
    ] as const) {
      const rule = { condition: { pickup_operator: operator, pickup_threshold: threshold } } as EngineRule;
      expect(pickupCountsLow(operator, threshold)).toBe(!pickupJudgesShortStretch(rule));
    }
    // An empty field reads as 0, as the engine reads a missing threshold.
    expect(pickupCountsLow("gt", Number(""))).toBe(false);
  });

  it("keeps a low pickup count's whole window when the wait chosen is shorter", () => {
    const low = { hasBookingSpeed: false, cooldownDays: null, hasPickup: true, pickupWindowDays: 7, pickupCooldownDays: 1, pickupLow: true };
    expect(pickupOwnWait(low)).toBe(7);
    expect(eventRuleWaitDays(low)).toBe(7);
    expect(eventRuleWaitDays({ ...low, pickupCooldownDays: 14 })).toBe(14);
    expect(eventRuleWaitDays({ ...low, pickupLow: false })).toBe(1);
  });

  it("says when the pickup lookback, not the dropdown, is what sets it", () => {
    const mixed = {
      hasBookingSpeed: true,
      cooldownDays: 1,
      hasPickup: true,
      pickupWindowDays: 7,
    };
    expect(eventRuleWaitDays(mixed)).toBe(7);
    expect(pickupSetsWait(mixed)).toBe(true);
    expect(pickupSetsWait({ ...mixed, cooldownDays: 14 })).toBe(false);
    expect(pickupSetsWait({ ...mixed, hasPickup: false })).toBe(false);
  });

  it("says which condition's wait decides it once a wait is chosen for the pickup one", () => {
    const mixed = { hasBookingSpeed: true, cooldownDays: 3, hasPickup: true, pickupWindowDays: 7, pickupCooldownDays: 1 };
    // The pickup wait chosen is shorter than its window, and than booking speed's.
    expect(eventRuleWaitDays(mixed)).toBe(3);
    expect(pickupSetsWait(mixed)).toBe(false);
    expect(bookingSpeedSetsWait(mixed)).toBe(true);
    expect(pickupOwnWait(mixed)).toBe(1);
    expect(bookingSpeedOwnWait(mixed)).toBe(3);
    const longer = { ...mixed, pickupCooldownDays: 14 };
    expect(eventRuleWaitDays(longer)).toBe(14);
    expect(pickupSetsWait(longer)).toBe(true);
    expect(bookingSpeedSetsWait(longer)).toBe(false);
    // Only a rule with both has one deciding over the other.
    expect(bookingSpeedSetsWait({ ...mixed, hasPickup: false })).toBe(false);
    // Left on the window, the pickup wait is the window.
    expect(pickupOwnWait({ ...mixed, pickupCooldownDays: null })).toBe(7);
  });
});

describe("what the rules table says a fire is", () => {
  it("counts every time the rule acted, repeats included, in plain words", () => {
    for (const help of [RULE_FIRES_HELP, FIRE_LOG_HELP]) {
      const words = [help.title, ...help.lines].join(" ");
      expect(words).toContain("once per night and room type");
      expect(words).toContain("in the last 90 days");
      expect(words).toContain("more than once");
      expect(words).not.toContain("\u2014");
      expect(words).not.toMatch(/[<>]/);
    }
    // Only the list's "?" says to click the number; the log's says what a row opens to.
    expect(RULE_FIRES_HELP.lines.join(" ")).toContain("Click the number");
    expect(FIRE_LOG_HELP.lines.join(" ")).toContain("Click a row");
  });
});

describe("a cut on low pickup with nothing to keep it near (A4)", () => {
  const pickupLow = newConditionRow("pickup", { operator: "lt", value: "1", pickup_window_days: 7 });
  const low: RuleCondition = { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 7, pickup_metric: "room_nights" };

  it("is a cut, a pickup row on Less than, and no booking window row", () => {
    expect(rowsAreFarOutCut([pickupLow], "decrease")).toBe(true);
    expect(rowsAreFarOutCut([pickupLow, newConditionRow("occupancy")], "decrease")).toBe(true);
    expect(rowsAreFarOutCut([pickupLow], "increase")).toBe(false);
    expect(rowsAreFarOutCut([pickupLow], "")).toBe(false);
    expect(rowsAreFarOutCut([newConditionRow("pickup", { operator: "gt", value: "1" })], "decrease")).toBe(false);
    // A booking window row the owner has not filled in yet is still a row on screen.
    expect(rowsAreFarOutCut([pickupLow, newConditionRow("booking_window", { value: "" })], "decrease")).toBe(false);
    expect(rowsAreFarOutCut([newConditionRow("occupancy", { operator: "lt", value: "30" })], "decrease")).toBe(false);
    expect(isFarOutCut(low, "decrease")).toBe(true);
    expect(isFarOutCut(low, "increase")).toBe(false);
    expect(isFarOutCut({ ...low, dta_operator: "lt", dta_threshold_days: 60 }, "decrease")).toBe(false);
    expect(isFarOutCut({ ...low, dta_operator: "gt", dta_threshold_days: 0 }, "decrease")).toBe(false);
    expect(isFarOutCut({ ...low, pickup_operator: "gt" }, "decrease")).toBe(false);
    expect(isFarOutCut(null, "decrease")).toBe(false);
  });

  it("the row the builder fills in is within 60 days of arrival, marked as filled in, and saves as that condition alone", () => {
    const row = farOutCutGuardRow();
    expect(FAR_OUT_CUT_GUARD_DAYS).toBe(60);
    expect(row).toMatchObject({ metric: "booking_window", operator: "lt", value: "60", prefilled: "far_out_cut" });
    expect(conditionRowsToRuleCondition([pickupLow, row])).toMatchObject({ pickup_operator: "lt", pickup_threshold: 1, dta_operator: "lt", dta_threshold_days: 60 });
    // Who filled the row in is not saved.
    expect(Object.keys(conditionRowsToRuleCondition([row]))).toEqual(["dta_operator", "dta_threshold_days"]);
    // Any other row starts as the owner's.
    expect(newConditionRow("booking_window")).not.toHaveProperty("prefilled");
  });

  it("saving never adds it: the draft is exactly the rows", () => {
    const values = { name: "Quiet", rows: [pickupLow], direction: "decrease" as const, percent: "4", dollars: "", selected: ["a"], split: false, changeIds: [], undo: true };
    const built = builderDraft(values, [{ id: "a", name: "Standard", counts_as_room: true }]);
    if ("error" in built) throw new Error(built.error);
    const condition = built.draft.condition as RuleCondition;
    expect(condition.pickup_operator).toBe("lt");
    expect(condition).not.toHaveProperty("dta_operator");
    expect(isFarOutCut(condition, "decrease")).toBe(true);
  });

  it("the popup's facts: the threshold, window and unit, and the wait the engine keeps", () => {
    expect(farOutCutFacts(low, "decrease")).toEqual({ threshold: 1, windowDays: 7, metric: "room_nights", waitDays: 7 });
    // A shorter wait chosen: low pickup holds it to the window. A longer one is kept.
    expect(farOutCutFacts({ ...low, pickup_cooldown_days: 1 }, "decrease")?.waitDays).toBe(7);
    expect(farOutCutFacts({ ...low, pickup_cooldown_days: 14 }, "decrease")?.waitDays).toBe(14);
    // With a booking speed row too, the longer of the two.
    const both: RuleCondition = { ...low, booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 14 };
    expect(farOutCutFacts(both, "decrease")?.waitDays).toBe(14);
    expect(farOutCutFacts({ ...low, pickup_metric: "revenue", pickup_threshold: 500, pickup_window_days: 1 }, "decrease")).toEqual({
      threshold: 500,
      windowDays: 1,
      metric: "revenue",
      waitDays: 1,
    });
    expect(farOutCutFacts(low, "increase")).toBeNull();
    expect(farOutCutFacts({ ...low, dta_operator: "lt", dta_threshold_days: 60 }, "decrease")).toBeNull();
    expect(farOutCutFacts({ ...low, pickup_operator: "gt" }, "decrease")).toBeNull();
    expect(farOutCutFacts(null, "decrease")).toBeNull();
  });

  it("the ? says why, in plain words", () => {
    const words = [FAR_OUT_CUT_GUARD_HELP.label, FAR_OUT_CUT_GUARD_HELP.title, ...FAR_OUT_CUT_GUARD_HELP.lines].join(" ");
    expect(words).toContain("every night ahead");
    expect(words).toContain("60 days of arrival");
    expect(words).toContain("remove the row");
    expect(words).not.toContain("\u2014");
    expect(words).not.toMatch(/MAYA (learns|knows|thinks)/);
  });
});
