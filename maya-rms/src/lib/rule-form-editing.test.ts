/**
 * Opening a saved rule in the builder and saving it unchanged saves the same
 * rule: ruleConditionToRows is conditionRowsToRuleCondition's inverse for
 * every condition the builder can make and the ones it can't pick itself
 * (a starter rule's "exactly Slower"), and ruleToBuilderForm fills every
 * setting. draftBehaviourKey tells a new name from a change to what the rule
 * does.
 */
import { describe, expect, it } from "vitest";
import type { EngineRule, RuleCondition } from "@/types/domain";
import {
  builderDraft,
  conditionRowsToRuleCondition,
  draftBehaviourKey,
  ruleConditionForInsert,
  ruleConditionToRows,
  ruleToBuilderForm,
} from "./rule-form";

const CONDITIONS: [string, RuleCondition][] = [
  ["occupancy above", { occupancy_operator: "gt", occupancy_threshold: 0.8 }],
  ["occupancy below, with decimals", { occupancy_operator: "lt", occupancy_threshold: 0.5725 }],
  ["days before arrival", { dta_operator: "lt", dta_threshold_days: 14 }],
  ["pickup, its own wait", { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: 2 }],
  ["pickup revenue, waits its window", { pickup_operator: "lt", pickup_threshold: 1250.5, pickup_window_days: 3, pickup_metric: "revenue" }],
  ["booking speed, the compare the level gives", { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 2 }],
  ["booking speed, exactly Slower (a starter rule)", { booking_speed_operator: "is", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 7 }],
  ["booking speed, at most Normal", { booking_speed_operator: "at_most", booking_speed_level: "normal", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 }],
  [
    "every kind at once",
    {
      occupancy_operator: "gt",
      occupancy_threshold: 0.6,
      dta_operator: "gt",
      dta_threshold_days: 30,
      pickup_operator: "gt",
      pickup_threshold: 2,
      pickup_window_days: 1,
      pickup_metric: "room_nights",
      booking_speed_operator: "at_least",
      booking_speed_level: "faster",
      booking_speed_window_days: 30,
      booking_speed_cooldown_days: 14,
    },
  ],
];

describe("a saved condition in the builder's rows", () => {
  it.each(CONDITIONS)("%s: saved again unchanged", (_name, condition) => {
    const rows = ruleConditionToRows(condition);
    expect(ruleConditionForInsert(conditionRowsToRuleCondition(rows))).toEqual(ruleConditionForInsert(condition));
  });

  it("puts the rows in the builder's order, one per kind", () => {
    const rows = ruleConditionToRows(CONDITIONS[8][1]);
    expect(rows.map((r) => r.metric)).toEqual(["occupancy", "booking_speed", "booking_window", "pickup"]);
    expect(rows[0].value).toBe("60");
  });

  it("choosing another level drops the kept compare and takes the level's own", () => {
    const [row] = ruleConditionToRows(CONDITIONS[6][1]);
    expect(row.booking_speed_operator).toBe("is");
    const moved = { ...row, booking_speed_level: "much_slower", booking_speed_operator: undefined };
    expect(conditionRowsToRuleCondition([moved]).booking_speed_operator).toBe("at_most");
  });
});

const RT = { std: "rt-std", suite: "rt-suite", court: "rt-court" };
const OPTIONS = [
  { id: RT.std, name: "Standard", counts_as_room: true },
  { id: RT.suite, name: "Suite", counts_as_room: true },
  { id: RT.court, name: "Court", counts_as_room: false },
];
const counting = (id: string) => id !== RT.court;

function rule(over: Partial<EngineRule>): EngineRule {
  return {
    id: "r1",
    hotel_id: "h1",
    name: "Busy nights",
    is_active: true,
    version: 2,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    priority: 100,
    is_pickup_rule: false,
    condition: { occupancy_operator: "gt", occupancy_threshold: 0.8 },
    signal_room_type_ids: [RT.std, RT.suite],
    affected_room_type_ids: [RT.std, RT.suite],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    undo_on_cancellation: true,
    ...over,
  };
}

describe("a saved rule in the builder", () => {
  it("fills the name, the amount and its direction, the lists and the undo box", () => {
    const form = ruleToBuilderForm(rule({ action_type: "fixed", action_direction: "decrease", action_value: 12.5, undo_on_cancellation: false }), counting);
    expect(form).toMatchObject({ name: "Busy nights", direction: "decrease", percent: "", dollars: "12.5", split: false, selected: [RT.std, RT.suite], undo: false });
  });

  it("ticks 'different room types' when the rule measures something other than it changes", () => {
    const form = ruleToBuilderForm(rule({ signal_room_type_ids: [RT.std], affected_room_type_ids: [RT.std, RT.suite] }), counting);
    expect(form).toMatchObject({ split: true, selected: [RT.std], changeIds: [RT.std, RT.suite] });
    // A court it also changes, but never measures, is one list.
    expect(ruleToBuilderForm(rule({ affected_room_type_ids: [RT.std, RT.suite, RT.court] }), counting).split).toBe(false);
  });

  it.each([
    ["one list", rule({})],
    ["split lists", rule({ signal_room_type_ids: [RT.std], affected_room_type_ids: [RT.suite] })],
    ["a fixed cut on a booking speed rule", rule({ action_type: "fixed", action_direction: "decrease", action_value: 20, condition: CONDITIONS[6][1] })],
  ])("%s: saved again unchanged", (_name, r) => {
    const form = ruleToBuilderForm(r, counting);
    const built = builderDraft({ ...form }, OPTIONS);
    if (!("draft" in built)) throw new Error(built.error);
    const d = built.draft as { condition: RuleCondition; action: Record<string, number>; signal_room_type_ids: string[]; affected_room_type_ids: string[]; undo_on_cancellation: boolean };
    expect(ruleConditionForInsert(d.condition)).toEqual(ruleConditionForInsert(r.condition));
    const signed = r.action_direction === "decrease" ? -r.action_value : r.action_value;
    expect(d.action).toEqual(r.action_type === "percent" ? { adjust_rate_percent: signed } : { adjust_rate_dollars: signed });
    expect([...d.signal_room_type_ids].sort()).toEqual([...r.signal_room_type_ids].sort());
    expect([...d.affected_room_type_ids].sort()).toEqual([...r.affected_room_type_ids].sort());
    expect(d.undo_on_cancellation).toBe(r.undo_on_cancellation);
  });
});

describe("a new name, or a change to what the rule does", () => {
  const draft = (over: Record<string, unknown> = {}) => {
    const built = builderDraft({ ...ruleToBuilderForm(rule({}), counting), ...over }, OPTIONS);
    if (!("draft" in built)) throw new Error(built.error);
    return built.draft;
  };

  it("a new name alone keeps the key", () => {
    expect(draftBehaviourKey(draft({ name: "Renamed" }))).toBe(draftBehaviourKey(draft()));
  });

  it("the amount, the lists or the undo box change it", () => {
    const base = draftBehaviourKey(draft());
    expect(draftBehaviourKey(draft({ percent: "12" }))).not.toBe(base);
    expect(draftBehaviourKey(draft({ selected: [RT.std] }))).not.toBe(base);
    expect(draftBehaviourKey(draft({ undo: false }))).not.toBe(base);
  });

  it("says what is missing before anything is sent", () => {
    expect(builderDraft({ ...ruleToBuilderForm(rule({}), counting), direction: "" }, OPTIONS)).toEqual({
      error: "Choose whether this rule increases or decreases the rate.",
    });
  });
});
