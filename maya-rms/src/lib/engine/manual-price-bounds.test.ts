/**
 * A manual price is published as it is. The floor and ceiling hold MAYA's own
 * moves; a $0 comp night, or a price the hotel set in its PMS under the floor
 * or over the ceiling, is the person's number. Rules stacked on it are still
 * clamped, to bounds widened only as far as the manual price.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { evaluateHotel } from "./evaluate";
import { priceBounds } from "./pricing";
import { priceBounds as sharedPriceBounds } from "../../../supabase/functions/_shared/engine/pricing";
import { fakeSupabase, missingColumn, type FakeRow } from "./fake-supabase.test";

const EVAL_TS = "2026-09-16T12:00:00Z";
const D0 = "2026-09-16";
const SET_AT = "2026-09-15T00:00:00Z";

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

const manual = (stay_date: string, price: number, more: FakeRow = {}): FakeRow => ({
  hotel_id: "h1", stay_date, room_type_id: "rt1", price, set_by: "user-1", set_at: SET_AT, cleared_at: null, ...more,
});

const busyRule = (action_type: "percent" | "fixed", action_direction: "increase" | "decrease", action_value: number) => ({
  id: "r1", hotel_id: "h1", name: "Busy", is_active: true, version: 1, priority: 100,
  start_date: null, end_date: null, is_annual: false, dow_mask: 127,
  action_type, action_direction, action_value, is_pickup_rule: false,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  rule_condition: [{ occupancy_operator: "gt", occupancy_threshold: 0.5 }],
  rule_signal_room_type: [{ room_type_id: "rt1" }],
  rule_affected_room_type: [{ room_type_id: "rt1" }],
});

const booked = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `b${i}`, hotel_id: "h1", stay_date: D0, room_type_id: "rt1",
    base_rate: 100, current_rate: 100, created_at: "2026-09-01T00:00:00Z",
  }));

/** A rule that fired after the manual price was set: active and not suppressed, so it stacks. */
const firedAfter = (action_kind: string, action_direction: string, action_value: number): FakeRow => ({
  rule_id: "r1", rule_version: 1, stay_date: D0, room_type_id: "rt1", is_active: true, suppressed_at: null,
  action_kind, action_direction, action_value,
});

afterEach(() => vi.restoreAllMocks());

describe("priceBounds", () => {
  it("widens the floor and ceiling only as far as a manual price, and leaves MAYA's own bases alone", () => {
    for (const fn of [priceBounds, sharedPriceBounds]) {
      expect(fn(89, 1000, 0, "manual")).toEqual({ floor: 0, ceiling: 1000 });
      expect(fn(89, 1000, 50, "manual")).toEqual({ floor: 50, ceiling: 1000 });
      expect(fn(89, 1000, 1500, "manual")).toEqual({ floor: 89, ceiling: 1500 });
      expect(fn(89, 1000, 150, "manual")).toEqual({ floor: 89, ceiling: 1000 });
      expect(fn(89, 1000, 0, "calendar")).toEqual({ floor: 89, ceiling: 1000 });
      expect(fn(89, 1000, 1500, "reservation")).toEqual({ floor: 89, ceiling: 1000 });
    }
  });
});

describe("what the engine publishes for an open manual price", () => {
  it("publishes a manual 0 as 0, and a price under the floor or over the ceiling as it is", async () => {
    const { client, tables } = fakeSupabase(
      seed({
        base_rate_calendar: [0, 1, 2, 3].map((i) => ({ hotel_id: "h1", stay_date: addDays(D0, i), room_type_id: "rt1", price: 200 })),
        manual_price: [manual(D0, 0), manual(addDays(D0, 1), 50), manual(addDays(D0, 2), 1500)],
      }),
    );

    await evaluateHotel(client, "h1", EVAL_TS, 4);

    const prices = Object.fromEntries(tables.published_price.map((r) => [r.stay_date, r.price]));
    expect(prices).toEqual({ [D0]: 0, [addDays(D0, 1)]: 50, [addDays(D0, 2)]: 1500, [addDays(D0, 3)]: 200 });
    const audit = tables.evaluation_audit.find((r) => r.stay_date === D0)!;
    expect(audit).toMatchObject({ final_price: 0 });
    expect((audit.details as Record<string, unknown>).clamped_by).toBe("none");
  });

  it("keeps a comp night at 0 under a percent rule that fires on top", async () => {
    const { client, tables } = fakeSupabase(
      seed({
        pricing_rules: [busyRule("percent", "increase", 10)],
        reservations: booked(16),
        manual_price: [manual(D0, 0)],
        ladder_rule_state: [firedAfter("percent", "increase", 10)],
      }),
    );

    await evaluateHotel(client, "h1", EVAL_TS, 1);

    expect(tables.published_price[0]).toMatchObject({ stay_date: D0, price: 0, base_price: 0 });
  });

  it("stacks a later rule on a price under the floor, and never takes it further out than the person put it", async () => {
    const run = async (manualPrice: number, kind: "percent" | "fixed", direction: "increase" | "decrease", value: number) => {
      const { client, tables } = fakeSupabase(
        seed({
          pricing_rules: [busyRule(kind, direction, value)],
          reservations: booked(16),
          manual_price: [manual(D0, manualPrice)],
          ladder_rule_state: [firedAfter(kind, direction, value)],
        }),
      );
      await evaluateHotel(client, "h1", EVAL_TS, 1);
      return tables.published_price[0].price;
    };

    // 50 + 10% moves toward the floor: allowed.
    expect(await run(50, "percent", "increase", 10)).toBe(55);
    // 50 - 10% would go further under the floor: held at the manual price.
    expect(await run(50, "percent", "decrease", 10)).toBe(50);
    // A comp night less $20 stays at 0, never negative.
    expect(await run(0, "fixed", "decrease", 20)).toBe(0);
    // And no rule raises a comp night, whatever the limits leave room for:
    // a fixed amount walks 0 up to 20, then 40, and the owner reads that a
    // night they gave away is being sold.
    expect(await run(0, "fixed", "increase", 20)).toBe(0);
    // Over the ceiling, an increase is held at the manual price; a decrease comes back toward it.
    expect(await run(1500, "percent", "increase", 10)).toBe(1500);
    expect(await run(1500, "percent", "decrease", 10)).toBe(1350);
    // An ordinary manual price is clamped exactly as before.
    expect(await run(950, "percent", "increase", 10)).toBe(1000);
  });

  it("keeps a comp night at 0 under a ladder rule that raises a fixed amount, and the audit says so", async () => {
    // A ladder rule whose condition starts holding after the price is typed
    // is a fresh trigger and applies on top, which for a fixed raise walks
    // a comp night up. It is still the owner's 0: nothing raises it, and the
    // audit lists only the effects that moved the number.
    const { client, tables } = fakeSupabase(
      seed({
        pricing_rules: [busyRule("fixed", "increase", 20)],
        reservations: booked(16),
        manual_price: [manual(D0, 0)],
        ladder_rule_state: [firedAfter("fixed", "increase", 20)],
      }),
    );

    await evaluateHotel(client, "h1", EVAL_TS, 1);

    expect(tables.published_price[0]).toMatchObject({ stay_date: D0, price: 0, base_price: 0 });
    const details = tables.evaluation_audit[0].details as Record<string, unknown>;
    expect(details.active_ladder_effects).toEqual([]);
    expect(details.application_order).toEqual([]);
    expect(details.pre_clamp_price).toBe("0.00");
    expect(details.clamped_by).toBe("none");
  });

  it("marks a price changed in the PMS in the audit row, and leaves a typed one's row as it was", async () => {
    const { client, tables } = fakeSupabase(
      seed({
        manual_price: [
          manual(D0, 180, { set_by: null, source: "pms", pms_type: "cloudbeds" }),
          manual(addDays(D0, 1), 150, { source: "maya", pms_type: null }),
        ],
      }),
    );

    await evaluateHotel(client, "h1", EVAL_TS, 2);

    const details = (d: string) => tables.evaluation_audit.find((r) => r.stay_date === d)!.details as Record<string, unknown>;
    expect(details(D0).manual_override).toEqual({ set_by: null, set_at: SET_AT, source: "pms", pms_type: "cloudbeds" });
    expect(details(addDays(D0, 1)).manual_override).toEqual({ set_by: "user-1", set_at: SET_AT });
  });

  it("still reads manual prices on a database that has no source column yet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = fakeSupabase(seed({ manual_price: [manual(D0, 140)] }), {
      fault: (c) => (c.table === "manual_price" && c.columns.includes("source") ? missingColumn("manual_price", "source") : null),
    });

    await evaluateHotel(client, "h1", EVAL_TS, 1);

    expect(tables.published_price[0]).toMatchObject({ price: 140 });
    expect((tables.evaluation_audit[0].details as Record<string, unknown>).manual_override).toEqual({ set_by: "user-1", set_at: SET_AT });
  });
});
