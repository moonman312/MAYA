/**
 * Two ways a wrong price used to reach published_price, and from there the
 * PMS: a night the hotel has at 0 was clamped up to the floor, and a ladder
 * pass whose writes half failed still published prices assembled on top of
 * it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { pricesOnBase } from "./base-price";
import { evaluateHotel } from "./evaluate";
import { fakeSupabase, type FakeCall, type FakeRow } from "./fake-supabase.test";

const EVAL_TS = "2026-09-16T12:00:00Z";
const D0 = "2026-09-16";

function seed(extra: Record<string, FakeRow[]> = {}): Record<string, FakeRow[]> {
  return {
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: [
      { id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, floor_price: 89, ceiling_price: 1000, counts_as_room: true },
    ],
    reservations: [],
    pricing_rules: [],
    ...extra,
  };
}

const busyRule = {
  id: "r1", hotel_id: "h1", name: "Busy", is_active: true, version: 1, priority: 100,
  start_date: null, end_date: null, is_annual: false, dow_mask: 127,
  action_type: "percent", action_direction: "increase", action_value: 10, is_pickup_rule: false,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.5 }],
  rule_signal_room_type: [{ room_type_id: "rt1" }],
  rule_affected_room_type: [{ room_type_id: "rt1" }],
};

const booked = (n: number, baseRate: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `b${i}`, hotel_id: "h1", stay_date: D0, room_type_id: "rt1",
    base_rate: baseRate, current_rate: baseRate, created_at: "2026-09-01T00:00:00Z",
  }));

afterEach(() => vi.restoreAllMocks());

describe("pricesOnBase", () => {
  it("prices a positive base, and a zero only when someone typed it", () => {
    expect(pricesOnBase({ price: 120, source: "calendar" })).toBe(true);
    expect(pricesOnBase({ price: 0, source: "calendar" })).toBe(false);
    expect(pricesOnBase({ price: 0, source: "reservation" })).toBe(false);
    expect(pricesOnBase({ price: 0, source: "remembered" })).toBe(false);
    expect(pricesOnBase({ price: -5, source: "calendar" })).toBe(false);
    expect(pricesOnBase({ price: 0, source: "manual" })).toBe(true);
    expect(pricesOnBase({ price: NaN, source: "manual" })).toBe(false);
  });
});

describe("a night the PMS has at 0", () => {
  it("is left unpriced instead of floored, and an old floor price for it is removed", async () => {
    const { client, tables } = fakeSupabase(
      seed({
        base_rate_calendar: [
          { hotel_id: "h1", stay_date: D0, room_type_id: "rt1", price: 0 }, // closed
          { hotel_id: "h1", stay_date: addDays(D0, 1), room_type_id: "rt1", price: 0 }, // closed, but typed
          { hotel_id: "h1", stay_date: addDays(D0, 2), room_type_id: "rt1", price: 120 }, // open
        ],
        manual_price: [
          { id: "m1", hotel_id: "h1", stay_date: addDays(D0, 1), room_type_id: "rt1", price: 150, set_by: null, set_at: "2026-09-15T00:00:00Z", cleared_at: null },
        ],
        // What the engine used to leave behind: the floor, on a night meant to stay shut.
        published_price: [{ hotel_id: "h1", stay_date: D0, room_type_id: "rt1", price: 89, base_price: 0, computed_at: "2026-09-15T00:00:00Z" }],
      }),
    );

    await evaluateHotel(client, "h1", EVAL_TS, 3);

    const prices = Object.fromEntries(tables.published_price.map((r) => [r.stay_date, r.price]));
    expect(prices).toEqual({ [addDays(D0, 1)]: 150, [addDays(D0, 2)]: 120 });
    // Nothing in the change log claims MAYA priced it.
    expect(tables.evaluation_audit?.some((r) => r.stay_date === D0) ?? false).toBe(false);
  });

  it("is left unpriced when the base comes from a booking at 0, with no calendar", async () => {
    const { client, tables } = fakeSupabase(seed({ reservations: booked(2, 0) }));

    const result = await evaluateHotel(client, "h1", EVAL_TS, 1);

    expect(result.prices_published).toBe(0);
    expect(tables.published_price ?? []).toEqual([]);
  });
});

describe("a ladder pass whose writes did not all land", () => {
  it("fails the run before it publishes, so the last good prices stay", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stateWriteFails = (c: FakeCall) =>
      c.table === "ladder_rule_state" && c.op === "upsert" ? { code: "08006", message: "connection failure" } : null;
    const { client, tables } = fakeSupabase(
      seed({
        pricing_rules: [busyRule],
        reservations: booked(16, 100),
        published_price: [{ hotel_id: "h1", stay_date: D0, room_type_id: "rt1", price: 100, base_price: 100, computed_at: "2026-09-15T00:00:00Z" }],
      }),
      { fault: stateWriteFails },
    );

    await expect(evaluateHotel(client, "h1", EVAL_TS, 1)).rejects.toThrow(
      /Ladder writes failed for 1 row; the run stops before publishing\. First: ladder_rule_state activation: connection failure/,
    );

    // The +10% built on an activation that never landed was not published.
    expect(tables.published_price).toEqual([expect.objectContaining({ stay_date: D0, price: 100 })]);
    // The writes that could land did; the next run decides the rest again.
    expect(tables.ladder_transition_event).toHaveLength(1);
    expect(tables.ladder_rule_state ?? []).toEqual([]);
    expect(tables.evaluation_audit ?? []).toEqual([]);
  });

  it("fails the run when a deactivation stays unwritten", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deactivationFails = (c: FakeCall) =>
      c.table === "ladder_rule_state" && c.op === "update" ? { code: "57014", message: "canceling statement due to statement timeout" } : null;
    const { client, tables } = fakeSupabase(
      seed({
        pricing_rules: [busyRule],
        reservations: booked(2, 100), // quiet now
        ladder_rule_state: [
          { rule_id: "r1", rule_version: 1, stay_date: D0, room_type_id: "rt1", is_active: true, suppressed_at: null,
            action_kind: "percent", action_direction: "increase", action_value: 10 },
        ],
        published_price: [{ hotel_id: "h1", stay_date: D0, room_type_id: "rt1", price: 110, base_price: 100, computed_at: "2026-09-15T00:00:00Z" }],
      }),
      { fault: deactivationFails },
    );

    await expect(evaluateHotel(client, "h1", EVAL_TS, 1)).rejects.toThrow(/ladder_rule_state deactivation: canceling statement/);
    // The rule still reads as active, and the price that goes with it stands.
    expect(tables.ladder_rule_state[0].is_active).toBe(true);
    expect(tables.published_price[0].price).toBe(110);
  });
});
