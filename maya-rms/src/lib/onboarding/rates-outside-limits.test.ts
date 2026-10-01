/**
 * The go-live confirm's count: nights whose own rate in the PMS sits outside
 * a room type's floor or ceiling, in the pricing window (Jake, 2026-09-30,
 * audit A21).
 */
import { describe, expect, it } from "vitest";
import { nightsWithRateOutsideLimits } from "@/lib/onboarding/rates-outside-limits";
import { fakeSupabase, missingColumn, type FakeRow } from "../engine/fake-supabase.test";

const HOTEL = "hotel-1";
/** Thursday 1 October 2026, midday UTC. */
const NOW = new Date("2026-10-01T12:00:00Z");

const rate = (stay_date: string, room_type_id: string, price: number, extra: FakeRow = {}): FakeRow => ({
  hotel_id: HOTEL,
  stay_date,
  room_type_id,
  price,
  pms_removed_at: null,
  ...extra,
});

function juniperLodge(opts: { returnedThrough?: string | null } = {}) {
  return fakeSupabase({
    hotels: [{ id: HOTEL, timezone: "UTC" }],
    room_types: [
      { id: "rt-king", hotel_id: HOTEL, is_active: true, floor_price: 150, ceiling_price: 400 },
      { id: "rt-suite", hotel_id: HOTEL, is_active: true, floor_price: 300, ceiling_price: 900 },
      { id: "rt-gone", hotel_id: HOTEL, is_active: false, floor_price: 150, ceiling_price: 400 },
    ],
    pms_connections: [
      {
        hotel_id: HOTEL,
        status: "connected",
        updated_at: "2026-10-01T00:00:00Z",
        base_rates_returned_through: opts.returnedThrough === undefined ? "2026-10-06" : opts.returnedThrough,
      },
    ],
    base_rate_calendar: [
      rate("2026-09-30", "rt-king", 100), // yesterday
      rate("2026-10-01", "rt-king", 120), // under the floor
      rate("2026-10-01", "rt-suite", 950), // over the ceiling, the same night
      rate("2026-10-02", "rt-king", 200), // inside
      rate("2026-10-03", "rt-king", 0), // closed: not priced
      rate("2026-10-04", "rt-king", 450), // over, but a typed price goes out as typed
      rate("2026-10-05", "rt-king", 110, { pms_removed_at: "2026-09-29T00:00:00Z" }), // removed in the PMS
      rate("2026-10-06", "rt-suite", 250), // under the floor
      rate("2026-10-06", "rt-gone", 100), // a room type no longer sold
      rate("2026-10-07", "rt-king", 130), // past the last night the PMS returned
      rate("2026-10-20", "rt-king", 130), // past the window
    ],
    manual_price: [
      { hotel_id: HOTEL, stay_date: "2026-10-04", room_type_id: "rt-king", price: 450, cleared_at: null },
      { hotel_id: HOTEL, stay_date: "2026-10-06", room_type_id: "rt-suite", price: 250, cleared_at: "2026-09-30T00:00:00Z" },
    ],
  });
}

describe("nightsWithRateOutsideLimits", () => {
  it("counts each night once, from today through the window, on the rate the engine prices on", async () => {
    const db = juniperLodge();
    // 1 October (two room types) and 6 October. The cleared typed price on
    // the 6th no longer stands.
    expect(await nightsWithRateOutsideLimits(db.client, HOTEL, 10, NOW)).toBe(2);
  });

  it("reads to the end of the window when no read has said how far the rates go", async () => {
    const db = juniperLodge({ returnedThrough: null });
    expect(await nightsWithRateOutsideLimits(db.client, HOTEL, 10, NOW)).toBe(3);
    // A shorter window stops before the 6th.
    expect(await nightsWithRateOutsideLimits(db.client, HOTEL, 3, NOW)).toBe(1);
  });

  it("leaves out a type unticked as a room that no rule changes, as the push does, and counts it once a rule does", async () => {
    // The A22 flow: "Harbour Conference Suite" got the import's limits while
    // unanswered, then the owner unticked it. Its own low rate sits under the
    // floor, but the push sends nothing for it.
    const db = juniperLodge();
    db.tables.room_types.push({ id: "rt-conf", hotel_id: HOTEL, is_active: true, floor_price: 150, ceiling_price: 400, counts_as_room: false });
    db.tables.base_rate_calendar.push(rate("2026-10-02", "rt-conf", 140));
    expect(await nightsWithRateOutsideLimits(db.client, HOTEL, 10, NOW)).toBe(2);

    db.tables.pricing_rules = [{ id: "rule-1", hotel_id: HOTEL, rule_affected_room_type: [{ room_type_id: "rt-conf" }] }];
    expect(await nightsWithRateOutsideLimits(db.client, HOTEL, 10, NOW)).toBe(3);
  });

  it("counts every type as a room before the counts_as_room column exists", async () => {
    const db = fakeSupabase(
      {
        hotels: [{ id: HOTEL, timezone: "UTC" }],
        room_types: [{ id: "rt-conf", hotel_id: HOTEL, is_active: true, floor_price: 150, ceiling_price: 400 }],
        pms_connections: [{ hotel_id: HOTEL, status: "connected", updated_at: "2026-10-01T00:00:00Z", base_rates_returned_through: "2026-10-06" }],
        base_rate_calendar: [rate("2026-10-02", "rt-conf", 140)],
      },
      { fault: (call) => (call.table === "room_types" && call.columns.includes("counts_as_room") ? missingColumn("room_types", "counts_as_room") : null) },
    );
    expect(await nightsWithRateOutsideLimits(db.client, HOTEL, 10, NOW)).toBe(1);
  });

  it("is 0 for a property whose rates all sit inside", async () => {
    const db = juniperLodge();
    db.tables.room_types = db.tables.room_types.map((r) => ({ ...r, floor_price: 1, ceiling_price: 99999.99 }));
    expect(await nightsWithRateOutsideLimits(db.client, HOTEL, 10, NOW)).toBe(0);
  });

  it("still counts on a database without the removed-in-the-PMS column, and says nothing without the calendar", async () => {
    // Before that migration the rows simply have no such column.
    const tables = juniperLodge().tables;
    tables.base_rate_calendar = tables.base_rate_calendar.map(({ pms_removed_at: _gone, ...row }) => (void _gone, row));
    const before = fakeSupabase(
      tables,
      {
        fault: (call) =>
          call.table === "base_rate_calendar" && call.columns.includes("pms_removed_at")
            ? missingColumn("base_rate_calendar", "pms_removed_at")
            : null,
      },
    );
    // The 5th now counts: nothing says the PMS removed it.
    expect(await nightsWithRateOutsideLimits(before.client, HOTEL, 10, NOW)).toBe(3);

    const none = fakeSupabase(juniperLodge().tables, {
      fault: (call) =>
        call.table === "base_rate_calendar"
          ? { code: "PGRST205", message: "Could not find the table 'public.base_rate_calendar' in the schema cache" }
          : null,
    });
    expect(await nightsWithRateOutsideLimits(none.client, HOTEL, 10, NOW)).toBeNull();
  });
});
