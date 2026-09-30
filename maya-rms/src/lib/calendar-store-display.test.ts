/**
 * The calendar carries the property's Settings choices with the month it
 * already loads (one more read in the same batch, never a second request),
 * and the two numbers the day cell can now show: ADR and RevPAR, counted on
 * the room types that count as rooms, as occupancy is.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CALENDAR_DISPLAY } from "./calendar-display";
import { clearCalendarHistoryCache, dayRates, getCalendar } from "./calendar-store";
import { fakeSupabase, missingColumn, type FakeCall, type FakeRow } from "./engine/fake-supabase.test";

vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "h1" }));

function calendarDb(seed: Record<string, FakeRow[]>, opts: Parameters<typeof fakeSupabase>[1] = {}) {
  const { client, calls } = fakeSupabase(seed, opts) as ReturnType<typeof fakeSupabase> & { calls: FakeCall[] };
  const paged = { range: async () => ({ data: [], error: null }) };
  (client as unknown as { rpc: unknown }).rpc = () => paged;
  return { client: client as unknown as SupabaseClient, calls };
}

const booking = (id: string, room_type_id: string, rate: number) => ({
  id,
  hotel_id: "h1",
  stay_date: "2026-10-10",
  room_type_id,
  base_rate: rate,
  current_rate: rate,
});

const base = {
  hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100, currency: "USD" }],
  room_types: [
    { id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 10, counts_as_room: true },
    { id: "rt2", hotel_id: "h1", name: "Meeting Room", is_active: true, total_rooms: 1, counts_as_room: false },
  ],
  // 4 Kings at $150 and the meeting room at $400.
  reservations: [...[1, 2, 3, 4].map((i) => booking(`k${i}`, "rt1", 150)), booking("m1", "rt2", 400)],
};

afterEach(() => {
  clearCalendarHistoryCache();
  vi.restoreAllMocks();
});

describe("the calendar's display settings", () => {
  it("come with the month, as the property saved them", async () => {
    const { client } = calendarDb({
      ...base,
      hotel_settings: [
        {
          hotel_id: "h1",
          calendar_big_metric: "price",
          calendar_small_metric_1: "adr",
          calendar_small_metric_2: null,
          calendar_price_room_type_id: "rt1",
          calendar_colors: "reversed",
        },
      ],
    });
    const cal = await getCalendar(2026, 10, client);
    expect(cal.display).toEqual({ big: "price", small: ["adr"], price_room_type_id: "rt1", colors: "reversed" });
  });

  it("are the calendar as it always was for a property that never chose, or a database before the migration", async () => {
    const none = await getCalendar(2026, 10, calendarDb(base).client);
    expect(none.display).toEqual(DEFAULT_CALENDAR_DISPLAY);

    clearCalendarHistoryCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = calendarDb(
      { ...base, hotel_settings: [{ hotel_id: "h1", simulation_mode: true }] },
      { fault: (c) => (c.table === "hotel_settings" && c.columns.includes("calendar_") ? missingColumn("hotel_settings", "calendar_big_metric") : null) },
    );
    const early = await getCalendar(2026, 10, client);
    expect(early.display).toEqual(DEFAULT_CALENDAR_DISPLAY);
    // The rest of the month is untouched by it.
    expect(early.days["10"].booked).toBe(4);
  });

  it("are read once per month, beside the month's other reads", async () => {
    const { client, calls } = calendarDb({ ...base, hotel_settings: [{ hotel_id: "h1", calendar_colors: "reversed" }] });
    await getCalendar(2026, 10, client);
    expect(calls.filter((c) => c.table === "hotel_settings")).toHaveLength(1);
  });

  it("are the default in demo mode", async () => {
    expect((await getCalendar(2026, 10)).display).toEqual(DEFAULT_CALENDAR_DISPLAY);
  });
});

describe("ADR and RevPAR on a day", () => {
  it("count only the room types that count as rooms, as occupancy does", async () => {
    const cal = await getCalendar(2026, 10, calendarDb(base).client);
    const day = cal.days["10"];
    // Occupancy: 4 of 10 Kings. The meeting room is out of it.
    expect(day).toMatchObject({ booked: 4, total: 10, occupancy_pct: 40 });
    // The revenue figure sums every type, as it always has.
    expect(day.revenue).toBe(1000);
    // ADR: $600 of King revenue over 4 Kings. RevPAR: over the 10 Kings you can sell.
    expect(day.adr).toBe(150);
    expect(day.sellable_revpar).toBe(60);
  });

  it("are null with nothing booked or nothing to sell", () => {
    expect(dayRates([{ revenue: 0, booked: 0, total_rooms: 10 }])).toEqual({ adr: null, sellable_revpar: 0 });
    expect(dayRates([{ revenue: 0, booked: 0, total_rooms: 0 }])).toEqual({ adr: null, sellable_revpar: null });
    expect(dayRates([])).toEqual({ adr: null, sellable_revpar: null });
  });

  it("round to cents", () => {
    expect(dayRates([{ revenue: 1000, booked: 3, total_rooms: 7 }])).toEqual({ adr: 333.33, sellable_revpar: 142.86 });
  });

  it("are on every demo day too", async () => {
    const cal = await getCalendar(2026, 6);
    for (const day of Object.values(cal.days)) {
      expect(day.adr).toBe(day.booked > 0 ? Math.round((day.revenue / day.booked) * 100) / 100 : null);
      expect(day.sellable_revpar).toBe(Math.round((day.revenue / day.total) * 100) / 100);
    }
  });
});
