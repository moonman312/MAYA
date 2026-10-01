/**
 * PIE's rules and limits as MAYA rules, floors and ceilings, from read rows
 * (made-up names and numbers): merging screenshots, the mapping, the notes,
 * the sentences.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING_HORIZON_DAYS } from "../../../supabase/functions/_shared/pms/pricing-window";
import {
  PIE_COPY,
  PRICING_WINDOW_NIGHTS,
  actionOf,
  canApplyTogether,
  inverseOf,
  orderedIds,
  planImport,
  planLimits,
  windowConditions,
  type ImportItem,
  type MayaRoomType,
} from "./map";
import { mergeReads } from "./merge";
import type { PieRowRead, ScreenshotRead } from "./read";
import { daysPhrase, draftSentence } from "./sentence";

const ROOMS: MayaRoomType[] = [
  { id: "rt-garden", name: "Garden Room", counts_as_room: true, floor_price: 80, ceiling_price: 600 },
  { id: "rt-tree", name: "Tree House - ADA", counts_as_room: true, floor_price: 120, ceiling_price: 900 },
  { id: "rt-loft", name: "Loft", counts_as_room: true, floor_price: 1, ceiling_price: 99999.99 },
  { id: "rt-court", name: "Tennis Court", counts_as_room: false, floor_price: 10, ceiling_price: 50 },
];
const ROOM_IDS = ["rt-garden", "rt-tree", "rt-loft"];
const TODAY = "2026-10-01";

function rowOf(name: string, description: string, o: Partial<PieRowRead> = {}): PieRowRead {
  return {
    name,
    description,
    mode: "auto",
    type: "occupancy",
    typeText: "Occupancy",
    active: true,
    startDate: "N/A",
    endDate: "N/A",
    cutOff: false,
    y: 0,
    ...o,
  };
}

function shot(rows: PieRowRead[], limits: ScreenshotRead["limits"] = { master: null, byType: [] }): ScreenshotRead {
  return { width: 2000, height: 1200, columns: null, rows, limits };
}

let seq = 0;
const random = () => `${(++seq).toString(16).padStart(8, "a")}-0000-4000-8000-000000000000`;

function plan(rows: PieRowRead[], limits?: ScreenshotRead["limits"]) {
  return planImport(mergeReads([shot(rows, limits)]), ROOMS, { today: TODAY, random });
}

const only = (items: ImportItem[], name: string) => items.find((i) => i.pie.name === name)!;

describe("merging screenshots", () => {
  it("keeps each rule once, in the order first seen", () => {
    const a = rowOf("Busy", "Raise rate by 10.00 % when occupancy is greater than 60.00 %");
    const b = rowOf("Quiet", "Lower rate by 5.00 % when occupancy is lower than 20.00 %");
    const c = rowOf("Peak", "Raise rate by 15.00 % when occupancy is greater than 90.00 %");
    const merged = mergeReads([shot([a, b]), shot([b, c])]);
    expect(merged.rules.map((r) => r.name)).toEqual(["Busy", "Quiet", "Peak"]);
    expect(merged.rules.map((r) => r.shot)).toEqual([0, 0, 1]);
  });

  it("keeps two rules with the same name but different descriptions", () => {
    const merged = mergeReads([
      shot([
        rowOf("Busy", "Raise rate by 10.00 % when occupancy is greater than 60.00 %"),
        rowOf("Busy", "Raise rate by 10.00 % when occupancy is greater than 80.00 %"),
      ]),
    ]);
    expect(merged.rules).toHaveLength(2);
  });

  it("swaps a row one screenshot cut off for the whole read of it in another", () => {
    const cut = rowOf("close-in dip", "Lower rate by 10.00 % when occupancy is lower than 30.00 % and xx", { cutOff: true });
    const whole = rowOf("close-in dip", "Lower rate by 10.00 % when occupancy is lower than 30.00 % and when booking today-4 days in advance");
    const first = rowOf("Busy", "Raise rate by 10.00 % when occupancy is greater than 60.00 %");
    expect(mergeReads([shot([first, cut]), shot([whole])]).rules.map((r) => [r.name, r.cutOff])).toEqual([
      ["Busy", false],
      ["close-in dip", false],
    ]);
    // Whole first, cut later: the cut read adds nothing.
    expect(mergeReads([shot([whole]), shot([cut])]).rules.map((r) => r.cutOff)).toEqual([false]);
    // Cut in both: once.
    expect(mergeReads([shot([cut]), shot([cut])]).rules).toHaveLength(1);
  });

  it("merges the limits and the master pair, the first read of each winning", () => {
    const merged = mergeReads([
      shot([], { master: { min: 99, max: null }, byType: [{ name: "Garden Room", min: 109, max: 450 }] }),
      shot([], { master: { min: 50, max: 2500 }, byType: [{ name: "garden  room", min: 1, max: 2 }, { name: "Loft", min: 150, max: 700 }] }),
      shot([]),
    ]);
    expect(merged.master).toEqual({ min: 99, max: 2500 });
    expect(merged.limits).toEqual([
      { name: "Garden Room", min: 109, max: 450 },
      { name: "Loft", min: 150, max: 700 },
    ]);
    expect(merged.unread).toEqual([2]);
  });
});

describe("PIE rules as MAYA rules", () => {
  it("makes a raise with a window from A days into one rule, on the property's rooms", () => {
    const { items } = plan([rowOf("Early bird", "Raise rate by 10.00 % when occupancy is greater than 31.00 % and when booking 80-800 days in advance")]);
    expect(items[0]).toMatchObject({ status: "ready", ticked: true, on: true, notes: [], reason: null });
    expect(items[0].drafts).toHaveLength(1);
    expect(items[0].drafts[0]).toMatchObject({
      rule_name: "Early bird",
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.31, dta_operator: "gt", dta_threshold_days: 79 },
      action: { adjust_rate_percent: 10 },
      signal_room_type_ids: ROOM_IDS,
      affected_room_type_ids: ROOM_IDS,
      room_types: ["Garden Room", "Tree House - ADA", "Loft"],
      undo_on_cancellation: true,
      start_date: null,
      end_date: null,
      conditions: { occupancy_percentage: ">31", booking_window: ">79" },
    });
  });

  it("makes a window from today into 'fewer than B + 1 days', and a window past the pricing window into none", () => {
    const { items } = plan([
      rowOf("Slow close-in", "Lower rate by 10.00 % when occupancy is lower than 20.00 % and when booking today-28 days in advance"),
      rowOf("Always", "Raise rate by 5.00 % when occupancy is greater than 50.00 % and when booking today-999 days in advance"),
    ]);
    expect(items[0].drafts[0]).toMatchObject({
      condition: { occupancy_operator: "lt", occupancy_threshold: 0.2, dta_operator: "lt", dta_threshold_days: 29 },
      action: { adjust_rate_percent: -10 },
    });
    expect(items[1].drafts[0].condition).toEqual({ occupancy_operator: "gt", occupancy_threshold: 0.5 });
  });

  it("splits a window bounded at both ends into a rule and its exact undo beyond B days", () => {
    const { items } = plan([
      rowOf("Mid", "Raise rate by 10.00 % when occupancy is greater than 50.00 % and when booking 14-60 days in advance"),
      rowOf("Mid cut", "Lower rate by 20.00 when occupancy is lower than 30.00 % and when booking 7-30 days in advance"),
    ]);
    expect(items[0].drafts.map((d) => [d.rule_name, d.condition.dta_operator, d.condition.dta_threshold_days, d.action])).toEqual([
      ["Mid", "gt", 13, { adjust_rate_percent: 10 }],
      ["Mid, beyond 60 days", "gt", 60, { adjust_rate_percent: -9.0909 }],
    ]);
    expect(items[0].notes).toEqual([PIE_COPY.split(60, true)]);
    expect(items[1].notes).toEqual([PIE_COPY.split(30, false)]);
    expect(items[1].drafts.map((d) => d.action)).toEqual([{ adjust_rate_dollars: -20 }, { adjust_rate_dollars: 20 }]);
  });

  it("works out the inverse of a percent to 4 places, and an amount's opposite", () => {
    expect(inverseOf("percent", "raise", 10)).toEqual({ direction: "lower", amount: 9.0909 });
    expect(inverseOf("percent", "lower", 10)).toEqual({ direction: "raise", amount: 11.1111 });
    expect(inverseOf("percent", "lower", 100)).toBeNull();
    expect(inverseOf("fixed", "raise", 7.5)).toEqual({ direction: "lower", amount: 7.5 });
    expect(actionOf("fixed", "lower", 12.5)).toEqual({ adjust_rate_dollars: -12.5 });
  });

  it("drops a bound at or beyond the last night MAYA prices", () => {
    expect(PRICING_WINDOW_NIGHTS).toBe(DEFAULT_PRICING_HORIZON_DAYS);
    expect(windowConditions({ from: 10, to: 395 })).toEqual({ first: { dta_operator: "gt", dta_threshold_days: 9 }, undoBeyond: null });
    expect(windowConditions({ from: 10, to: 394 })).toEqual({ first: { dta_operator: "gt", dta_threshold_days: 9 }, undoBeyond: 394 });
    expect(windowConditions({ from: 0, to: 396 })).toEqual({ first: null, undoBeyond: null });
    expect(windowConditions(null)).toEqual({ first: null, undoBeyond: null });
  });

  it("keeps a fixed amount, and creates a rule off when its switch was off", () => {
    const { items } = plan([rowOf("Flat", "Raise rate by 25.00 when occupancy is greater than 70.00 %", { active: false })]);
    expect(items[0]).toMatchObject({ status: "ready", on: false, ticked: true });
    expect(items[0].drafts[0].action).toEqual({ adjust_rate_dollars: 25 });
  });

  it("notes a Manual rule, and a switch that couldn't be seen (added off)", () => {
    const { items } = plan([
      rowOf("Suggest", "Raise rate by 5.00 % when occupancy is greater than 70.00 %", { mode: "manual" }),
      rowOf("Unseen", "Raise rate by 5.00 % when occupancy is greater than 75.00 %", { active: null }),
    ]);
    expect(items[0].notes).toEqual([PIE_COPY.manual]);
    expect(items[1]).toMatchObject({ on: false, notes: [PIE_COPY.switchUnknown], status: "ready" });
  });

  it("lists Restriction and Compset rules as not imported, with a reason", () => {
    const { items } = plan([
      rowOf("Min stay", "Set minimum stay to 2 nights when occupancy is greater than 90.00 %", { type: "restriction", typeText: "Restriction" }),
      rowOf("Follow comps", "Raise rate by 5.00 % when the compset average is higher", { type: "compset", typeText: "Compset" }),
      rowOf("Weird", "Do something else", { type: "other", typeText: "Pickup" }),
    ]);
    expect(items.map((i) => [i.status, i.reason, i.drafts.length, i.ticked])).toEqual([
      ["not_imported", PIE_COPY.restriction, 0, false],
      ["not_imported", PIE_COPY.compset, 0, false],
      ["not_imported", PIE_COPY.otherType, 0, false],
    ]);
  });

  it("imports a rate rule whose TYPE was misread", () => {
    const { items } = plan([rowOf("Busy", "Raise rate by 5.00 % when occupancy is greater than 70.00 %", { type: "other", typeText: "Occupanc0" })]);
    expect(items[0].status).toBe("ready");
  });

  it("marks a cut-off row to finish in the builder, and an unreadable one not imported", () => {
    const { items } = plan([
      rowOf("close-in dip", "Lower rate by 10.00 % when occupancy is lower than 30.00 % and qe 4 xv", { cutOff: true, active: false }),
      rowOf("Torn", "Raise rate by 10.00 % when occ", { cutOff: true }),
      rowOf("Smudge", "Raise rate by 10.00 % when pickup is greater than 4"),
    ]);
    expect(items[0]).toMatchObject({ status: "needs_edit", reason: PIE_COPY.cutOff, ticked: false, on: false });
    // What was read, ready to finish: no window yet.
    expect(items[0].drafts[0].condition).toEqual({ occupancy_operator: "lt", occupancy_threshold: 0.3 });
    expect(items[1]).toMatchObject({ status: "needs_edit", reason: PIE_COPY.cutOff, drafts: [] });
    expect(items[2]).toMatchObject({ status: "not_imported", reason: PIE_COPY.unreadable });
  });

  it("matches 'or equal to' within 0.01%, and doesn't import 'equal to'", () => {
    const { items } = plan([
      rowOf("Ge", "Raise rate by 5.00 % when occupancy is greater than or equal to 60.00 %"),
      rowOf("Le", "Lower rate by 5.00 % when occupancy is less than or equal to 20.00 %"),
      rowOf("Eq", "Raise rate by 5.00 % when occupancy is equal to 50.00 %"),
    ]);
    expect(items[0].drafts[0].condition).toEqual({ occupancy_operator: "gt", occupancy_threshold: 0.5999 });
    expect(items[0].notes).toEqual([PIE_COPY.orEqual("more", "59.99")]);
    expect(items[1].drafts[0].condition).toEqual({ occupancy_operator: "lt", occupancy_threshold: 0.2001 });
    expect(items[2]).toMatchObject({ status: "not_imported", reason: PIE_COPY.equalTo });
  });

  it("maps room type wording to MAYA's room types, by name", () => {
    const { items } = plan([
      rowOf("Combined", "Raise rate by 5.00 % when combined occupancy of garden room, TREE HOUSE-ADA is greater than 60.00 %"),
      rowOf("Each", "Raise rate by 5.00 % when individual occupancy of Garden Room and Loft is greater than 60.00 %"),
      rowOf("Unknown", "Raise rate by 5.00 % when individual occupancy is greater than 60.00 %"),
      rowOf("Missing", "Raise rate by 5.00 % when combined occupancy of Yurt is greater than 60.00 %"),
    ]);
    expect(only(items, "Combined").drafts.map((d) => [d.signal_room_type_ids, d.affected_room_type_ids])).toEqual([
      [["rt-garden", "rt-tree"], ["rt-garden", "rt-tree"]],
    ]);
    expect(only(items, "Each").drafts.map((d) => [d.rule_name, d.signal_room_type_ids])).toEqual([
      ["Each (Garden Room)", ["rt-garden"]],
      ["Each (Loft)", ["rt-loft"]],
    ]);
    expect(only(items, "Unknown")).toMatchObject({ status: "needs_edit", reason: PIE_COPY.scopeUnknown, ticked: false });
    expect(only(items, "Unknown").drafts[0].affected_room_type_ids).toEqual(ROOM_IDS);
    expect(only(items, "Missing")).toMatchObject({ status: "needs_edit", reason: PIE_COPY.scopeUnmatched(["Yurt"]) });
  });

  it("maps START and END dates to the nights a rule covers", () => {
    const { items } = plan([
      rowOf("Autumn", "Raise rate by 5.00 % when occupancy is greater than 60.00 %", { startDate: "10/15/2026", endDate: "11/30/2026" }),
      rowOf("Ambiguous", "Raise rate by 5.00 % when occupancy is greater than 60.00 %", { startDate: "11/03/2026", endDate: "N/A" }),
      rowOf("Over", "Raise rate by 5.00 % when occupancy is greater than 60.00 %", { startDate: "01/15/2026", endDate: "02/20/2026" }),
      rowOf("Smudged", "Raise rate by 5.00 % when occupancy is greater than 60.00 %", { startDate: "someday" }),
    ]);
    expect(only(items, "Autumn").drafts[0]).toMatchObject({ start_date: "2026-10-15", end_date: "2026-11-30" });
    expect(only(items, "Autumn").ticked).toBe(true);
    expect(only(items, "Ambiguous")).toMatchObject({ status: "ready", ticked: false, notes: [PIE_COPY.datesAmbiguous] });
    expect(only(items, "Over")).toMatchObject({ status: "ready", ticked: false, notes: [PIE_COPY.datesPassed] });
    expect(only(items, "Smudged")).toMatchObject({ status: "not_imported", reason: PIE_COPY.datesUnreadable });
  });

  it("flags a fixed amount and a percent that can be on the same night, and only those", () => {
    const { items } = plan([
      rowOf("Pct", "Raise rate by 10.00 % when occupancy is greater than 60.00 %"),
      rowOf("Flat", "Raise rate by 5.00 when occupancy is greater than 80.00 %"),
      rowOf("Flat low", "Lower rate by 5.00 when occupancy is lower than 30.00 %"),
    ]);
    expect(only(items, "Pct").notes).toEqual([PIE_COPY.mixed]);
    expect(only(items, "Flat").notes).toEqual([PIE_COPY.mixed]);
    // Under 30% and over 60% are never true together.
    expect(only(items, "Flat low").notes).toEqual([]);
  });

  it("knows when two rules can both be on", () => {
    const base = { conditions: {}, room_types: [], undo_on_cancellation: true, rule_name: "x", start_date: null, end_date: null };
    const a = { ...base, condition: { occupancy_operator: "gt" as const, occupancy_threshold: 0.5, dta_operator: "lt" as const, dta_threshold_days: 10 }, action: { adjust_rate_percent: 5 }, signal_room_type_ids: ["a"], affected_room_type_ids: ["a"] };
    const b = { ...a, condition: { occupancy_operator: "gt" as const, occupancy_threshold: 0.7, dta_operator: "gt" as const, dta_threshold_days: 8 }, action: { adjust_rate_dollars: 5 } };
    expect(canApplyTogether(a, b)).toBe(true);
    expect(canApplyTogether(a, { ...b, condition: { ...b.condition, dta_threshold_days: 9 } })).toBe(false);
    expect(canApplyTogether(a, { ...b, affected_room_type_ids: ["b"] })).toBe(false);
    expect(canApplyTogether({ ...a, end_date: "2026-01-01" }, { ...b, start_date: "2026-02-01" })).toBe(false);
  });

  it("gives the drafts ids that sort in the screenshot's order", () => {
    const ids = orderedIds(12, () => "0f1e2d3c-4b5a-4968-8776-655443322110");
    expect(ids[0]).toBe("0f1e2d00-4b5a-4968-8776-655443322110");
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(12);
    const { items } = plan([
      rowOf("A", "Raise rate by 10.00 % when occupancy is greater than 50.00 % and when booking 14-60 days in advance"),
      rowOf("B", "Raise rate by 10.00 % when occupancy is greater than 60.00 %"),
    ]);
    const all = items.flatMap((i) => i.drafts.map((d) => d.id));
    expect(all).toHaveLength(3);
    expect([...all].sort()).toEqual(all);
  });
});

describe("price limits as floors and ceilings", () => {
  it("sets each type's own row, the master pair on the rest, and lists names with no type", () => {
    const merged = {
      master: { min: 90, max: 2000 },
      limits: [
        { name: "garden room ", min: 100, max: 500 },
        { name: "Tree House-ADA", min: 120, max: 900 },
        { name: "Yurt", min: 60, max: 300 },
      ],
    };
    expect(planLimits(merged, ROOMS)).toEqual({
      changes: [
        { roomTypeId: "rt-garden", name: "Garden Room", floor: 100, ceiling: 500, current: { floor: 80, ceiling: 600 }, from: "own", problem: null },
        // Tree House: its row matches what it has, so nothing changes.
        { roomTypeId: "rt-loft", name: "Loft", floor: 90, ceiling: 2000, current: { floor: 1, ceiling: 99999.99 }, from: "master", problem: null },
        { roomTypeId: "rt-court", name: "Tennis Court", floor: 90, ceiling: 2000, current: { floor: 10, ceiling: 50 }, from: "master", problem: null },
      ],
      unmatched: ["Yurt"],
    });
  });

  it("keeps the current number for a side PIE doesn't give, and says when a pair can't be set", () => {
    const merged = { master: { min: null, max: 700 }, limits: [{ name: "Garden Room", min: 650, max: 600 }] };
    const { changes } = planLimits(merged, ROOMS.slice(0, 3));
    expect(changes.find((c) => c.name === "Garden Room")).toMatchObject({ floor: 650, ceiling: 600, problem: "Its minimum is above its maximum." });
    expect(changes.find((c) => c.name === "Loft")).toMatchObject({ floor: 1, ceiling: 700, from: "master", problem: null });
  });

  it("does nothing without limits in view", () => {
    expect(planLimits({ master: null, limits: [] }, ROOMS)).toEqual({ changes: [], unmatched: [] });
  });
});

describe("the review's sentence", () => {
  it("says each rule plainly", () => {
    const { items } = plan([
      rowOf("Early", "Raise rate by 10.00 % when occupancy is greater than 31.00 % and when booking 80-800 days in advance"),
      rowOf("Late", "Lower rate by 12.50 when occupancy is lower than 20.00 % and when booking today-28 days in advance"),
      rowOf("Mid", "Raise rate by 10.00 % when combined occupancy of Loft is greater than 50.00 % and when booking 14-60 days in advance", {
        startDate: "10/15/2026",
        endDate: "11/30/2026",
      }),
      rowOf("Same day", "Lower rate by 5.00 % when occupancy is lower than 30.00 % and when booking today-0 days in advance"),
    ]);
    const say = (i: number, d = 0) => draftSentence(items[i].drafts[d], { symbol: "$", roomTypes: ROOMS });
    expect(say(0)).toBe("Raise the price 10% when sellable occupancy is over 31%, 80 or more days before arrival.");
    expect(say(1)).toBe("Lower the price $12.50 when sellable occupancy is under 20%, 28 or fewer days before arrival.");
    expect(say(2)).toBe("Raise the price 10% when sellable occupancy is over 50%, 14 or more days before arrival, on Loft, for nights Oct 15, 2026 to Nov 30, 2026.");
    expect(say(2, 1)).toBe(
      "Lower the price 9.0909% when sellable occupancy is over 50%, 61 or more days before arrival, on Loft, for nights Oct 15, 2026 to Nov 30, 2026.",
    );
    expect(say(3)).toBe("Lower the price 5% when sellable occupancy is under 30%, on the day of arrival.");
    expect(daysPhrase("lt", 2)).toBe("1 or fewer days before arrival");
  });
});
