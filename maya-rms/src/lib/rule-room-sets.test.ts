/**
 * Measured and changed room types: the helpers the builder, the rule card
 * and the change log share, and what the store accepts.
 */
import { describe, expect, it } from "vitest";
import { RoomTypeSetError, defaultSignalIds, measuresDifferently, roomTypeIdListError, ruleRoomTypesLabel } from "./rule-form";
import { createRule, listRules, updateRule } from "./rules-store";
import { fakeSupabase, type FakeRow } from "./engine/fake-supabase.test";

const counting = new Set(["std", "dlx", "ph"]);
const isCounting = (id: string) => counting.has(id);

describe("defaultSignalIds", () => {
  it("measures the counting types among the picked ones, or all of them when none count", () => {
    expect(defaultSignalIds(["std", "court", "ph"], isCounting)).toEqual(["std", "ph"]);
    expect(defaultSignalIds(["court"], isCounting)).toEqual(["court"]);
    expect(defaultSignalIds([], isCounting)).toEqual([]);
  });
});

describe("measuresDifferently", () => {
  it("compares only types that count, in any order", () => {
    expect(measuresDifferently(["dlx", "std"], ["std", "dlx"], isCounting)).toBe(false);
    expect(measuresDifferently(["std"], ["std", "court"], isCounting)).toBe(false);
    expect(measuresDifferently(["court"], ["court"], isCounting)).toBe(false);
    expect(measuresDifferently(["std", "dlx"], ["ph"], isCounting)).toBe(true);
    expect(measuresDifferently(["std"], ["std", "ph"], isCounting)).toBe(true);
  });
});

describe("ruleRoomTypesLabel", () => {
  const NAMES: Record<string, string> = { std: "Standard", dlx: "Deluxe", ph: "Penthouse", court: "Court" };
  const rule = (signal: string[], affected: string[], names: string[]) => ({
    room_types: names,
    signal_room_type_ids: signal,
    affected_room_type_ids: affected,
    signal_room_types: signal.map((id) => ({ id, name: NAMES[id] })),
  });

  it("reads exactly as before when the rule measures what it changes", () => {
    expect(ruleRoomTypesLabel(rule(["std", "dlx"], ["std", "dlx"], ["Standard", "Deluxe"]), isCounting)).toBe(
      "Standard, Deluxe",
    );
    expect(ruleRoomTypesLabel(rule(["std"], ["std", "court"], ["Standard", "Court"]), isCounting)).toBe("Standard, Court");
    expect(ruleRoomTypesLabel({ room_types: [] }, isCounting)).toBe("All");
    expect(ruleRoomTypesLabel({ room_types: ["Suite"] }, isCounting)).toBe("Suite");
  });

  it("names both sets when they differ", () => {
    expect(ruleRoomTypesLabel(rule(["std", "dlx"], ["ph"], ["Suites"]), isCounting)).toBe(
      "Watches Standard, Deluxe · Changes Suites",
    );
  });

  it("names only the watched types that count as rooms, as the engine and change log do", () => {
    expect(ruleRoomTypesLabel(rule(["std", "court"], ["ph"], ["Penthouse"]), isCounting)).toBe("Watches Standard · Changes Penthouse");
    // A name missing from the embed never shifts another type's name onto its id.
    expect(
      ruleRoomTypesLabel(
        { ...rule(["court", "dlx"], ["ph"], ["Penthouse"]), signal_room_types: [{ id: "dlx", name: "Deluxe" }] },
        isCounting,
      ),
    ).toBe("Watches Deluxe · Changes Penthouse");
  });
});

describe("roomTypeIdListError", () => {
  it("allows an absent list and refuses empty or malformed ones", () => {
    expect(roomTypeIdListError(undefined, "measure")).toBeNull();
    expect(roomTypeIdListError(["a"], "measure")).toBeNull();
    expect(roomTypeIdListError([], "measure")).toBe("Pick at least one room type to measure.");
    expect(roomTypeIdListError([], "change")).toBe("Pick at least one room type to change.");
    expect(roomTypeIdListError(null, "change")).toBe("Invalid room types.");
    expect(roomTypeIdListError([""], "change")).toBe("Invalid room types.");
  });
});

describe("the rules store with separate sets", () => {
  const roomTypes: FakeRow[] = [
    { id: "std", hotel_id: "h1", name: "Standard", is_active: true, counts_as_room: true },
    { id: "dlx", hotel_id: "h1", name: "Deluxe", is_active: true, counts_as_room: true },
    { id: "ph", hotel_id: "h1", name: "Penthouse", is_active: true, counts_as_room: true },
    { id: "other", hotel_id: "h2", name: "Elsewhere", is_active: true, counts_as_room: true },
  ];
  const input = {
    rule_name: "Entry level pace",
    conditions: {},
    condition: { booking_speed_operator: "at_least" as const, booking_speed_level: "faster", booking_speed_window_days: 7 as const },
    action: { adjust_rate_percent: 15 },
    room_types: [],
  };

  it("stores each set as sent, keeping only this hotel's room types", async () => {
    const { client, tables } = fakeSupabase({ room_types: roomTypes });
    await createRule({ ...input, signal_room_type_ids: ["std", "dlx", "other"], affected_room_type_ids: ["ph", "other"] }, client, "h1");
    expect(tables.rule_signal_room_type.map((r) => r.room_type_id)).toEqual(["std", "dlx"]);
    expect(tables.rule_affected_room_type.map((r) => r.room_type_id)).toEqual(["ph"]);
  });

  it("refuses an empty set, or one with nothing of this hotel's, before writing anything", async () => {
    for (const sets of [
      { signal_room_type_ids: [], affected_room_type_ids: ["ph"] },
      { signal_room_type_ids: ["other"], affected_room_type_ids: ["ph"] },
      { signal_room_type_ids: ["std"], affected_room_type_ids: ["other"] },
    ]) {
      const { client, tables } = fakeSupabase({ room_types: roomTypes });
      await expect(createRule({ ...input, ...sets }, client, "h1")).rejects.toBeInstanceOf(RoomTypeSetError);
      expect(tables.pricing_rules ?? []).toEqual([]);
    }
  });

  it("lists a rule with both sets and the measured names", async () => {
    const rules: FakeRow[] = [
      {
        id: "r1", hotel_id: "h1", name: "Entry level pace", is_active: true, priority: 100, created_at: "2026-01-01",
        action_type: "percent", action_direction: "increase", action_value: 15,
        rule_condition: [],
        rule_signal_room_type: [{ room_type_id: "std", room_types: { name: "Standard" } }, { room_type_id: "dlx", room_types: { name: "Deluxe" } }],
        rule_affected_room_type: [{ room_type_id: "ph", room_types: { name: "Penthouse" } }],
      },
    ];
    const { client } = fakeSupabase({ pricing_rules: rules });
    const [listed] = await listRules(client, "h1");
    expect(listed.signal_room_type_ids).toEqual(["std", "dlx"]);
    expect(listed.affected_room_type_ids).toEqual(["ph"]);
    expect(listed.signal_room_types).toEqual([
      { id: "std", name: "Standard" },
      { id: "dlx", name: "Deluxe" },
    ]);
    expect(ruleRoomTypesLabel(listed, isCounting)).toBe("Watches Standard, Deluxe · Changes Penthouse");
  });

  it("updates a set only to this hotel's room types, and refuses an empty one untouched", async () => {
    const seed = () => ({
      room_types: roomTypes,
      pricing_rules: [{ id: "r1", hotel_id: "h1", version: 1 }],
      rule_signal_room_type: [{ rule_id: "r1", room_type_id: "std" }],
      rule_affected_room_type: [{ rule_id: "r1", room_type_id: "std" }],
    });
    const empty = fakeSupabase(seed());
    await expect(updateRule("r1", { signal_room_type_ids: [] }, empty.client)).rejects.toBeInstanceOf(RoomTypeSetError);
    expect(empty.tables.pricing_rules[0].version).toBe(1);

    const { client, tables } = fakeSupabase(seed());
    expect(await updateRule("r1", { signal_room_type_ids: ["dlx", "other"], affected_room_type_ids: ["ph"] }, client)).toBe(true);
    expect(tables.rule_signal_room_type.map((r) => r.room_type_id)).toEqual(["dlx"]);
    expect(tables.rule_affected_room_type.map((r) => r.room_type_id)).toEqual(["ph"]);
    await expect(updateRule("r1", { affected_room_type_ids: ["other"] }, client)).rejects.toThrow("Pick at least one room type to change.");
    expect(tables.rule_affected_room_type.map((r) => r.room_type_id)).toEqual(["ph"]);
  });
});
