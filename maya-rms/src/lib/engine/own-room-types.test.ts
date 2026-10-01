/**
 * A rule only ever changes its own hotel's prices (audit A24).
 *
 * A standard rule writes its changes to ladder_rule_state, which has no
 * hotel column and is read by room type. A rule row naming another hotel's
 * room type (the app never offers one, but a row written straight through
 * the database's API could) used to make one hotel's run write a change on
 * the other's room type, and the other hotel's run then priced with it.
 * Both engine copies leave such a room type out of the rule, and read only
 * the changes of the hotel's own rules, a paused one included.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateHotel } from "./evaluate";
import { evaluateHotel as edgeEvaluateHotel } from "../../../supabase/functions/_shared/engine/evaluate";
import { fakeSupabase, type FakeRow } from "./fake-supabase.test";

const EVAL_TS = "2026-09-16T12:00:00Z";
const D0 = "2026-09-16";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(EVAL_TS));
});
afterAll(() => vi.useRealTimers());
afterEach(() => vi.restoreAllMocks());

const ruleRow = (over: Partial<FakeRow> & { id: string; hotel_id: string; affected: string[]; signals: string[] }): FakeRow => {
  const { affected, signals, ...rest } = over;
  return {
    name: "Busy",
    is_active: true,
    version: 1,
    priority: 100,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "decrease",
    action_value: 50,
    is_pickup_rule: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.5 }],
    rule_signal_room_type: signals.map((room_type_id) => ({ room_type_id })),
    rule_affected_room_type: affected.map((room_type_id) => ({ room_type_id })),
    ...rest,
  };
};

/** Juniper Lodge (h1, Garden Room) and Harbour Inn (h2, Loft), both busy on D0. */
function seed(extra: Record<string, FakeRow[]> = {}): Record<string, FakeRow[]> {
  const booked = (hotel: string, rt: string) =>
    Array.from({ length: 16 }, (_, i) => ({
      id: `${hotel}-b${i}`,
      hotel_id: hotel,
      stay_date: D0,
      room_type_id: rt,
      base_rate: 100,
      current_rate: 100,
      created_at: "2026-09-01T00:00:00Z",
    }));
  return {
    hotels: [
      { id: "h1", timezone: "UTC" },
      { id: "h2", timezone: "UTC" },
    ],
    room_types: [
      { id: "garden", hotel_id: "h1", name: "Garden Room", is_active: true, total_rooms: 20, floor_price: 10, ceiling_price: 1000, counts_as_room: true },
      { id: "garden-old", hotel_id: "h1", name: "Old Garden Room", is_active: false, total_rooms: 4, floor_price: 10, ceiling_price: 1000, counts_as_room: true },
      { id: "loft", hotel_id: "h2", name: "Loft", is_active: true, total_rooms: 20, floor_price: 10, ceiling_price: 1000, counts_as_room: true },
    ],
    reservations: [...booked("h1", "garden"), ...booked("h2", "loft")],
    base_rate_calendar: [
      { hotel_id: "h1", stay_date: D0, room_type_id: "garden", price: 100 },
      { hotel_id: "h2", stay_date: D0, room_type_id: "loft", price: 200 },
    ],
    pricing_rules: [
      // Juniper Lodge's rule, with Harbour Inn's Loft and its own switched-off room type on its list.
      ruleRow({ id: "r-h1", hotel_id: "h1", affected: ["garden", "loft", "garden-old"], signals: ["garden"] }),
    ],
    ...extra,
  };
}

const price = (tables: Record<string, FakeRow[]>, hotel: string, rt: string) =>
  tables.published_price.find((p) => p.hotel_id === hotel && p.room_type_id === rt && p.stay_date === D0)?.price;

describe.each([
  ["app", evaluateHotel],
  ["edge", edgeEvaluateHotel],
])("a rule never changes another hotel's prices (%s copy)", (_copy, evaluate) => {
  it("a rule naming another hotel's room type changes only its own hotel's, and says so", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(seed());

    await evaluate(client, "h1", EVAL_TS, 1);
    expect(price(tables, "h1", "garden")).toBe(50);
    const states = tables.ladder_rule_state.map((s) => `${s.rule_id}|${s.room_type_id}`).sort();
    // The switched-off room type of its own hotel stays on its list, as it always has.
    expect(states).toEqual(["r-h1|garden", "r-h1|garden-old"]);
    const lines = err.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines.filter((l) => l.step === "rule_room_types")).toEqual([
      expect.objectContaining({ hotelId: "h1", ruleId: "r-h1", roomTypeId: "loft" }),
    ]);

    // Harbour Inn's run is not touched by it.
    await evaluate(client, "h2", EVAL_TS, 1);
    expect(price(tables, "h2", "loft")).toBe(200);
  });

  it("a change another hotel's rule already wrote on this hotel's room type is left out of its price", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(
      seed({
        ladder_rule_state: [
          { rule_id: "r-h1", rule_version: 1, stay_date: D0, room_type_id: "loft", is_active: true, activated_at: "2026-09-15T00:00:00Z", last_evaluated_at: "2026-09-15T00:00:00Z", action_kind: "percent", action_direction: "decrease", action_value: 50 },
        ],
      }),
    );

    await evaluate(client, "h2", EVAL_TS, 1);
    expect(price(tables, "h2", "loft")).toBe(200);
    const lines = err.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines.filter((l) => l.step === "ladder_effects")).toEqual([expect.objectContaining({ hotelId: "h2", ruleIds: ["r-h1"] })]);
  });

  it("a paused rule of the hotel's own keeps its change on the price", async () => {
    const { client, tables } = fakeSupabase(
      seed({
        pricing_rules: [
          ruleRow({ id: "r-h2-paused", hotel_id: "h2", is_active: false, affected: ["loft"], signals: ["loft"], action_direction: "increase", action_value: 10 }),
        ],
        ladder_rule_state: [
          { rule_id: "r-h2-paused", rule_version: 1, stay_date: D0, room_type_id: "loft", is_active: true, activated_at: "2026-09-15T00:00:00Z", last_evaluated_at: "2026-09-15T00:00:00Z", action_kind: "percent", action_direction: "increase", action_value: 10 },
        ],
      }),
    );

    await evaluate(client, "h2", EVAL_TS, 1);
    expect(price(tables, "h2", "loft")).toBe(220);
  });
});
