import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clearCalendarHistoryCache, getCalendar, isCountingRoom, sellableRevparSeries } from "./calendar-store";
import { FakeRpcError, fakeSupabase, missingColumn, missingRelation, type FakeCall, type FakeError, type FakeRow } from "./engine/fake-supabase.test";
import { calendarDailyRevenue, calendarDailyRevenueV2 } from "./engine/scale-rpc-model.test";

vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "h1" }));

describe("getCalendar (demo mode — no Supabase)", () => {
  /* ── Structure ──────────────────────────────────────────────── */

  it("returns correct metadata for a known month", async () => {
    const cal = await getCalendar(2026, 3);
    expect(cal.year).toBe(2026);
    expect(cal.month).toBe(3);
    expect(cal.days_in_month).toBe(31);
    expect(cal.thresholds).toMatchObject({ low: 60, high: 80, basis: "revpar" });
    expect(cal.month_name).toContain("March");
    expect(cal.month_name).toContain("2026");
  });

  it("exposes RevPAR tercile thresholds for past and future", async () => {
    const cal = await getCalendar(2026, 3);
    for (const side of [cal.thresholds.past, cal.thresholds.future]) {
      expect(side.p33).toBeGreaterThan(0);
      expect(side.p67).toBeGreaterThanOrEqual(side.p33);
    }
  });

  it("reports a navigable range spanning the demo window", async () => {
    const cal = await getCalendar(2026, 3);
    expect(cal.range.min).toMatch(/^\d{4}-\d{2}$/);
    expect(cal.range.max).toMatch(/^\d{4}-\d{2}$/);
    expect(cal.range.min < cal.range.max).toBe(true);
  });

  it("has an entry for every day of the month", async () => {
    const cal = await getCalendar(2026, 2); // February 2026 — 28 days
    expect(cal.days_in_month).toBe(28);
    for (let d = 1; d <= 28; d++) {
      expect(cal.days[String(d)]).toBeDefined();
    }
    expect(cal.days["29"]).toBeUndefined();
  });

  it("handles leap year February", async () => {
    const cal = await getCalendar(2028, 2); // 2028 is a leap year
    expect(cal.days_in_month).toBe(29);
    expect(cal.days["29"]).toBeDefined();
  });

  it("first_weekday is valid (0–6)", async () => {
    const cal = await getCalendar(2026, 1);
    expect(cal.first_weekday).toBeGreaterThanOrEqual(0);
    expect(cal.first_weekday).toBeLessThanOrEqual(6);
  });

  /* ── Day data shape ─────────────────────────────────────────── */

  it("each day has required fields", async () => {
    const cal = await getCalendar(2026, 6);
    const day = cal.days["15"];
    expect(day).toHaveProperty("occupancy_pct");
    expect(day).toHaveProperty("booked");
    expect(day).toHaveProperty("total");
    expect(day).toHaveProperty("revenue");
    expect(day).toHaveProperty("weekday");
    expect(day).toHaveProperty("room_types");
    expect(day).toHaveProperty("revpar");
    expect(day).toHaveProperty("color");
  });

  it("each day carries a RevPAR consistent with its revenue and a valid color", async () => {
    const cal = await getCalendar(2026, 6);
    for (const key of Object.keys(cal.days)) {
      const day = cal.days[key];
      expect(day.revpar).toBe(Math.round((day.revenue / day.total) * 100) / 100);
      expect(["green", "orange", "red"]).toContain(day.color);
    }
  });

  it("demo cells carry no base or manual price", async () => {
    const cal = await getCalendar(2026, 3);
    for (const rt of cal.days["10"].room_types) {
      expect(rt.base_price).toBeNull();
      expect(rt.manual_price).toBeNull();
    }
  });

  it("every room type entry carries a numeric current_rate in demo mode", async () => {
    const cal = await getCalendar(2026, 6);
    for (const key of Object.keys(cal.days)) {
      for (const rt of cal.days[key].room_types) {
        expect(typeof rt.current_rate).toBe("number");
        expect(rt.current_rate).toBeGreaterThan(0);
      }
    }
  });

  it("weekday names are valid", async () => {
    const validDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const cal = await getCalendar(2026, 3);
    for (let d = 1; d <= 31; d++) {
      expect(validDays).toContain(cal.days[String(d)].weekday);
    }
  });

  /* ── Room types per day ─────────────────────────────────────── */

  it("includes three room types per day (Standard, Deluxe, Suite)", async () => {
    const cal = await getCalendar(2026, 4);
    const day = cal.days["10"];
    expect(day.room_types.length).toBe(3);
    const names = day.room_types.map((rt) => rt.name);
    expect(names).toContain("Standard");
    expect(names).toContain("Deluxe");
    expect(names).toContain("Suite");
  });

  it("room type totals match expected values", async () => {
    const cal = await getCalendar(2026, 7);
    const day = cal.days["1"];
    const std = day.room_types.find((rt) => rt.name === "Standard")!;
    const dlx = day.room_types.find((rt) => rt.name === "Deluxe")!;
    const ste = day.room_types.find((rt) => rt.name === "Suite")!;
    expect(std.total_rooms).toBe(40);
    expect(dlx.total_rooms).toBe(30);
    expect(ste.total_rooms).toBe(15);
  });

  /* ── Occupancy values ───────────────────────────────────────── */

  it("occupancy percentages are between 0 and 100", async () => {
    const cal = await getCalendar(2026, 8);
    for (const key of Object.keys(cal.days)) {
      const day = cal.days[key];
      expect(day.occupancy_pct).toBeGreaterThanOrEqual(0);
      expect(day.occupancy_pct).toBeLessThanOrEqual(100);
      for (const rt of day.room_types) {
        expect(rt.occupancy_pct).toBeGreaterThanOrEqual(0);
        expect(rt.occupancy_pct).toBeLessThanOrEqual(100);
      }
    }
  });

  it("booked count never exceeds total rooms", async () => {
    const cal = await getCalendar(2026, 5);
    for (const key of Object.keys(cal.days)) {
      const day = cal.days[key];
      expect(day.booked).toBeLessThanOrEqual(day.total);
      for (const rt of day.room_types) {
        expect(rt.booked).toBeLessThanOrEqual(rt.total_rooms);
      }
    }
  });

  it("aggregate day totals match sum of room types", async () => {
    const cal = await getCalendar(2026, 9);
    const day = cal.days["20"];
    const sumBooked = day.room_types.reduce((s, rt) => s + rt.booked, 0);
    const sumTotal = day.room_types.reduce((s, rt) => s + rt.total_rooms, 0);
    expect(day.booked).toBe(sumBooked);
    expect(day.total).toBe(sumTotal);
  });

  /* ── Revenue ────────────────────────────────────────────────── */

  it("revenue is non-negative", async () => {
    const cal = await getCalendar(2026, 10);
    for (const key of Object.keys(cal.days)) {
      expect(cal.days[key].revenue).toBeGreaterThanOrEqual(0);
      for (const rt of cal.days[key].room_types) {
        expect(rt.revenue).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /* ── Determinism ────────────────────────────────────────────── */

  it("produces identical results for same inputs", async () => {
    const a = await getCalendar(2026, 3);
    const b = await getCalendar(2026, 3);
    expect(a).toEqual(b);
  });

  it("produces different metadata for different months", async () => {
    const a = await getCalendar(2026, 3);
    const b = await getCalendar(2026, 4);
    expect(a.month_name).not.toBe(b.month_name);
    expect(a.month).toBe(3);
    expect(b.month).toBe(4);
    expect(a.days_in_month).toBe(31);
    expect(b.days_in_month).toBe(30);
  });
});

describe("createTtlCache", () => {
  it("serves the cached value within the TTL and reloads after expiry", async () => {
    let clock = 0;
    let loads = 0;
    const { createTtlCache } = await import("./calendar-store");
    const cache = createTtlCache<number>(5000, () => clock);
    const loader = async () => {
      loads += 1;
      return loads;
    };

    expect(await cache.getOrLoad("hotel-a", loader)).toBe(1);
    clock = 4999; // still fresh
    expect(await cache.getOrLoad("hotel-a", loader)).toBe(1);
    expect(loads).toBe(1);

    clock = 5001; // expired
    expect(await cache.getOrLoad("hotel-a", loader)).toBe(2);
    expect(loads).toBe(2);
  });

  it("caches per key — one hotel's history never leaks to another", async () => {
    const { createTtlCache } = await import("./calendar-store");
    const cache = createTtlCache<string>(5000, () => 0);
    expect(await cache.getOrLoad("hotel-a", async () => "a")).toBe("a");
    expect(await cache.getOrLoad("hotel-b", async () => "b")).toBe("b");
    expect(await cache.getOrLoad("hotel-a", async () => "never")).toBe("a");
  });

  it("clear() forces the next read to reload", async () => {
    const { createTtlCache } = await import("./calendar-store");
    const cache = createTtlCache<number>(5000, () => 0);
    let loads = 0;
    const loader = async () => ++loads;
    await cache.getOrLoad("k", loader);
    cache.clear();
    await cache.getOrLoad("k", loader);
    expect(loads).toBe(2);
  });
});

describe("createTtlCache stampede protection", () => {
  it("concurrent misses share one loader call", async () => {
    const { createTtlCache } = await import("./calendar-store");
    const cache = createTtlCache<number>(5000, () => 0);
    let loads = 0;
    const slowLoader = () =>
      new Promise<number>((resolve) => setTimeout(() => resolve(++loads), 20));

    const results = await Promise.all([
      cache.getOrLoad("k", slowLoader),
      cache.getOrLoad("k", slowLoader),
      cache.getOrLoad("k", slowLoader),
      cache.getOrLoad("k", slowLoader),
      cache.getOrLoad("k", slowLoader),
      cache.getOrLoad("k", slowLoader),
    ]);

    expect(loads).toBe(1);
    expect(results).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("a failed load is not cached — the next call retries", async () => {
    const { createTtlCache } = await import("./calendar-store");
    const cache = createTtlCache<number>(5000, () => 0);
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return 42;
    };
    await expect(cache.getOrLoad("k", flaky)).rejects.toThrow("transient");
    expect(await cache.getOrLoad("k", flaky)).toBe(42);
  });
});

/**
 * The engine's fake plus the one thing the calendar needs that it lacks: an
 * rpc that can be paged with .range(), the way loadHotelHistory reads the
 * revenue series.
 */
function calendarDb(seed: Record<string, FakeRow[]>, opts: Parameters<typeof fakeSupabase>[1] = {}) {
  const { client, tables } = fakeSupabase(seed, opts);
  const paged = { range: async () => ({ data: [], error: null }) };
  (client as unknown as { rpc: unknown }).rpc = () => paged;
  return { client: client as unknown as SupabaseClient, tables };
}

describe("getCalendar (Supabase) — sellable occupancy", () => {
  afterEach(() => {
    clearCalendarHistoryCache();
    vi.restoreAllMocks();
  });

  const booking = (id: string, stay_date: string, room_type_id: string) => ({
    id, hotel_id: "h1", stay_date, room_type_id, base_rate: 100, current_rate: 100,
  });

  it("divides by the sellable count, so the day card agrees with the change log", async () => {
    // 20 Kings, 5 blocked for the first half of October, 12 sold on the 10th.
    // The engine reads that night as 12/15 = 80% and a "above 70%" rule
    // fires; the card under the same "sellable occupancy" label must not say
    // 60%.
    const { client } = calendarDb({
      hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
      room_types: [
        { id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true },
        { id: "rt2", hotel_id: "h1", name: "Court", is_active: true, total_rooms: 3, counts_as_room: false },
      ],
      room_type_out_of_service: [
        { id: "o1", hotel_id: "h1", room_type_id: "rt1", start_date: "2026-10-01", end_date: "2026-10-15", units: 5, cleared_at: null },
      ],
      reservations: Array.from({ length: 12 }, (_, i) => booking(`b${i}`, "2026-10-10", "rt1")),
    });
    const cal = await getCalendar(2026, 10, client);
    const blocked = cal.days["10"];
    expect(blocked.total).toBe(15);
    expect(blocked.booked).toBe(12);
    expect(blocked.occupancy_pct).toBe(80);
    expect(blocked.room_types.find((r) => r.id === "rt1")).toMatchObject({ total_rooms: 15, occupancy_pct: 80 });
    // The court is still shown per cell but never in the day's denominator.
    expect(blocked.room_types.find((r) => r.id === "rt2")).toBeDefined();
    // Past the block the physical count is back.
    expect(cal.days["20"].total).toBe(20);
  });

  it("says the property's today and currency, so the day card can show both right", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-11T02:00:00Z"), toFake: ["Date"] });
    try {
      const { client } = calendarDb({
        // 02:00 UTC on the 11th is still the 10th in New York.
        hotels: [{ id: "h1", timezone: "America/New_York", total_rooms_per_type: 100, currency: "EUR" }],
        room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
      });
      const cal = await getCalendar(2026, 10, client);
      expect(cal.today).toBe("2026-10-10");
      expect(cal.currency).toBe("EUR");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says which nights ahead have no rate in the property system, and which are past what its last read returned", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z"), toFake: ["Date"] });
    try {
      const cal = (stay_date: string, room_type_id: string) => ({ hotel_id: "h1", stay_date, room_type_id, price: 200 });
      const { client } = calendarDb({
        hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
        room_types: [
          { id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true },
          { id: "rt2", hotel_id: "h1", name: "Queen", is_active: true, total_rooms: 10, counts_as_room: true },
        ],
        pms_connections: [{ id: "c1", hotel_id: "h1", pms_type: "cloudbeds", status: "connected", base_rates_returned_through: "2026-10-20", updated_at: "2026-10-01T00:00:00Z" }],
        // King has rates on record through the 25th (the 21st on is from an earlier read); Queen through the 12th only.
        base_rate_calendar: [
          ...Array.from({ length: 25 }, (_, i) => cal(`2026-10-${String(i + 1).padStart(2, "0")}`, "rt1")),
          ...Array.from({ length: 12 }, (_, i) => cal(`2026-10-${String(i + 1).padStart(2, "0")}`, "rt2")),
        ],
        // A typed price on a Queen night without a rate: priced on it, so not waiting.
        manual_price: [{ hotel_id: "h1", stay_date: "2026-10-15", room_type_id: "rt2", price: 180, set_at: "2026-10-09T10:00:00Z", cleared_at: null }],
        published_price: [{ hotel_id: "h1", stay_date: "2026-10-15", room_type_id: "rt2", price: 180, base_price: 180 }],
      });
      const month = await getCalendar(2026, 10, client);
      const cell = (day: number, rt: string) => month.days[String(day)].room_types.find((r) => r.id === rt)!;
      // A rate on record, inside what the last read returned: nothing to say.
      expect(cell(12, "rt1")).not.toHaveProperty("no_rate_in_pms");
      expect(cell(12, "rt2")).not.toHaveProperty("no_rate_in_pms");
      // No rate on record.
      expect(cell(13, "rt2").no_rate_in_pms).toBe(true);
      expect(cell(30, "rt1").no_rate_in_pms).toBe(true);
      // A row from an earlier read past the last night the PMS returned.
      expect(cell(21, "rt1").no_rate_in_pms).toBe(true);
      expect(cell(20, "rt1")).not.toHaveProperty("no_rate_in_pms");
      // A typed price is a starting price of its own.
      expect(cell(15, "rt2")).not.toHaveProperty("no_rate_in_pms");
      expect(cell(15, "rt2").manual_price?.price).toBe(180);
      // Past nights are never waiting.
      expect(cell(5, "rt2")).not.toHaveProperty("no_rate_in_pms");
      // Tonight counts.
      expect(cell(10, "rt2")).not.toHaveProperty("no_rate_in_pms");
      expect(cell(13, "rt1")).not.toHaveProperty("no_rate_in_pms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no price, and no rate there, for a night MAYA sent to past the last night the property system still returns", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z"), toFake: ["Date"] });
    try {
      const { client } = calendarDb({
        hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
        room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
        // The hotel deleted its rates from the 21st on; MAYA had sent 165 to the 20th and 22nd.
        pms_connections: [{ id: "c1", hotel_id: "h1", pms_type: "cloudbeds", status: "connected", base_rates_returned_through: "2026-10-20", updated_at: "2026-10-01T00:00:00Z" }],
        base_rate_calendar: [
          { hotel_id: "h1", stay_date: "2026-10-20", room_type_id: "rt1", price: 150 },
          { hotel_id: "h1", stay_date: "2026-10-22", room_type_id: "rt1", price: 150 },
          { hotel_id: "h1", stay_date: "2026-10-23", room_type_id: "rt1", price: 150 },
        ],
        manual_price: [{ hotel_id: "h1", stay_date: "2026-10-23", room_type_id: "rt1", price: 190, set_at: "2026-10-09T10:00:00Z", cleared_at: null }],
        published_price: [
          { hotel_id: "h1", stay_date: "2026-10-20", room_type_id: "rt1", price: 165, base_price: 150 },
          { hotel_id: "h1", stay_date: "2026-10-22", room_type_id: "rt1", price: 165, base_price: 150 },
          { hotel_id: "h1", stay_date: "2026-10-23", room_type_id: "rt1", price: 190, base_price: 190 },
        ],
      });
      const month = await getCalendar(2026, 10, client);
      const cell = (day: number) => month.days[String(day)].room_types[0];
      expect(cell(22)).toMatchObject({ current_price: null, current_rate: null, base_price: null, no_rate_in_pms: true });
      // Inside what the system returns: MAYA's price, as ever.
      expect(cell(20)).toMatchObject({ current_price: 165 });
      expect(cell(20)).not.toHaveProperty("no_rate_in_pms");
      // A typed price is priced and sent as typed, wherever the night is.
      expect(cell(23)).toMatchObject({ current_price: 190 });
      expect(cell(23)).not.toHaveProperty("no_rate_in_pms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says which nights MAYA stopped pricing because their rate was removed in the property system", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z"), toFake: ["Date"] });
    try {
      const removedAt = "2026-10-09T10:00:00Z";
      const { client } = calendarDb({
        hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
        room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
        pms_connections: [{ id: "c1", hotel_id: "h1", pms_type: "cloudbeds", status: "connected", base_rates_returned_through: "2026-10-31", updated_at: "2026-10-01T00:00:00Z" }],
        base_rate_calendar: [
          { hotel_id: "h1", stay_date: "2026-10-05", room_type_id: "rt1", price: 150, pms_removed_at: removedAt },
          { hotel_id: "h1", stay_date: "2026-10-14", room_type_id: "rt1", price: 150, pms_removed_at: removedAt },
          { hotel_id: "h1", stay_date: "2026-10-15", room_type_id: "rt1", price: 150, pms_removed_at: removedAt },
          { hotel_id: "h1", stay_date: "2026-10-16", room_type_id: "rt1", price: 150, pms_removed_at: removedAt },
          { hotel_id: "h1", stay_date: "2026-10-17", room_type_id: "rt1", price: 150, pms_removed_at: null },
        ],
        manual_price: [
          // Typed before the rate was removed: it waits with the night.
          { hotel_id: "h1", stay_date: "2026-10-15", room_type_id: "rt1", price: 200, set_at: "2026-10-08T10:00:00Z", cleared_at: null },
          // Typed since: priced and sent as typed.
          { hotel_id: "h1", stay_date: "2026-10-16", room_type_id: "rt1", price: 210, set_at: "2026-10-09T12:00:00Z", cleared_at: null },
        ],
        published_price: [{ hotel_id: "h1", stay_date: "2026-10-16", room_type_id: "rt1", price: 210, base_price: 210 }],
      });
      const month = await getCalendar(2026, 10, client);
      const cell = (day: number) => month.days[String(day)].room_types[0];
      expect(cell(14).rate_removed_in_pms).toBe(true);
      expect(cell(14)).not.toHaveProperty("no_rate_in_pms");
      expect(cell(15).rate_removed_in_pms).toBe(true);
      expect(cell(15).manual_price?.price).toBe(200);
      expect(cell(16)).not.toHaveProperty("rate_removed_in_pms");
      expect(cell(17)).not.toHaveProperty("rate_removed_in_pms");
      // Past nights say nothing.
      expect(cell(5)).not.toHaveProperty("rate_removed_in_pms");

      // Before the column: the rates on record read as before, and nothing is removed.
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const old = calendarDb(
        {
          hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
          room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
          pms_connections: [{ id: "c1", hotel_id: "h1", pms_type: "cloudbeds", status: "connected", base_rates_returned_through: "2026-10-31", updated_at: "2026-10-01T00:00:00Z" }],
          base_rate_calendar: [{ hotel_id: "h1", stay_date: "2026-10-14", room_type_id: "rt1", price: 150 }],
        },
        { fault: (c) => (c.table === "base_rate_calendar" && c.columns.includes("pms_removed_at") ? missingColumn("base_rate_calendar", "pms_removed_at") : null) },
      );
      const before = await getCalendar(2026, 10, old.client);
      expect(before.days["14"].room_types[0]).not.toHaveProperty("rate_removed_in_pms");
      expect(before.days["14"].room_types[0]).not.toHaveProperty("no_rate_in_pms");
      expect(before.days["15"].room_types[0].no_rate_in_pms).toBe(true);
      expect(err).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about rates on a Mews property, or with no connection, or before the column exists", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z"), toFake: ["Date"] });
    try {
      const seed = {
        hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
        room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
      };
      const mews = calendarDb({ ...seed, pms_connections: [{ id: "c1", hotel_id: "h1", pms_type: "mews", status: "connected" }] });
      expect((await getCalendar(2026, 10, mews.client)).days["15"].room_types[0]).not.toHaveProperty("no_rate_in_pms");
      const none = calendarDb({ ...seed, pms_connections: [] });
      expect((await getCalendar(2026, 10, none.client)).days["15"].room_types[0]).not.toHaveProperty("no_rate_in_pms");
      // Before the column: every rate on record counts, and a night without one still waits.
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const old = calendarDb(
        {
          ...seed,
          pms_connections: [{ id: "c1", hotel_id: "h1", pms_type: "cloudbeds", status: "connected", base_rates_refreshed_at: "2026-10-10T11:00:00Z" }],
          base_rate_calendar: [{ hotel_id: "h1", stay_date: "2026-10-15", room_type_id: "rt1", price: 200 }],
        },
        { fault: (c) => (c.table === "pms_connections" && c.columns.includes("base_rates_returned_through") ? missingColumn("pms_connections", "base_rates_returned_through") : null) },
      );
      const cal = await getCalendar(2026, 10, old.client);
      expect(cal.days["15"].room_types[0]).not.toHaveProperty("no_rate_in_pms");
      expect(cal.days["16"].room_types[0].no_rate_in_pms).toBe(true);
      expect(err).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about rates before MAYA's first read of them: an empty calendar then is MAYA's doing, not the system's", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z"), toFake: ["Date"] });
    try {
      const seed = {
        hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
        room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
        base_rate_calendar: [],
      };
      const flag = async (connection: Record<string, unknown>) => {
        const { client } = calendarDb({ ...seed, pms_connections: [{ id: "c1", hotel_id: "h1", pms_type: "cloudbeds", ...connection }] });
        return (await getCalendar(2026, 10, client)).days["15"].room_types[0].no_rate_in_pms ?? false;
      };
      // A pending connection, or a connected one in the minutes before the first tick: no read has happened.
      expect(await flag({ status: "pending" })).toBe(false);
      expect(await flag({ status: "connected", base_rates_refreshed_at: null, base_rates_returned_through: null })).toBe(false);
      // Once a read has recorded a refresh (or a returned night), an empty calendar is the system's answer.
      expect(await flag({ status: "connected", base_rates_refreshed_at: "2026-10-10T11:00:00Z" })).toBe(true);
      expect(await flag({ status: "connected", base_rates_returned_through: "2026-10-12" })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders on the physical count, once loudly, before the out-of-service table exists", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = calendarDb(
      {
        hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
        room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
      },
      { fault: (c) => (c.table === "room_type_out_of_service" ? missingRelation("room_type_out_of_service") : null) },
    );
    const cal = await getCalendar(2026, 10, client);
    expect(cal.days["10"].total).toBe(20);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("99_supabase_migration_room_type_out_of_service_v1.sql");
  });
});

describe("getCalendar (Supabase): revenue and average rate", () => {
  afterEach(() => {
    clearCalendarHistoryCache();
    vi.restoreAllMocks();
  });

  it("counts a booking with no rate as 0, and has no average rate for a night with nothing booked", async () => {
    const { client } = calendarDb({
      hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
      room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 10, counts_as_room: true }],
      reservations: [
        { id: "a", hotel_id: "h1", stay_date: "2026-10-10", room_type_id: "rt1", base_rate: 120, current_rate: 120 },
        { id: "b", hotel_id: "h1", stay_date: "2026-10-10", room_type_id: "rt1", base_rate: null, current_rate: null },
      ],
    });
    const cal = await getCalendar(2026, 10, client);
    expect(cal.days["10"].room_types[0]).toMatchObject({ booked: 2, revenue: 120, rate: 60 });
    expect(cal.days["10"].revenue).toBe(120);
    expect(cal.days["11"].room_types[0]).toMatchObject({ booked: 0, revenue: 0, rate: null });
  });

  it("counts each booking at the rate it has now, and the first rate only when the property system sent none since (A48)", async () => {
    const { client } = calendarDb({
      hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
      room_types: [{ id: "rt1", hotel_id: "h1", name: "Garden Room", is_active: true, total_rooms: 10, counts_as_room: true }],
      reservations: [
        // First read at 200, moved to 150 in the property system since.
        { id: "a", hotel_id: "h1", stay_date: "2026-10-05", room_type_id: "rt1", base_rate: 200, current_rate: 150 },
        // The property system sent no rate on its last read: the first one stands.
        { id: "b", hotel_id: "h1", stay_date: "2026-10-05", room_type_id: "rt1", base_rate: 180, current_rate: null },
      ],
    });
    const cal = await getCalendar(2026, 10, client);
    expect(cal.days["5"].room_types[0]).toMatchObject({ booked: 2, revenue: 330, rate: 165 });
    expect(cal.days["5"]).toMatchObject({ revenue: 330, adr: 165 });
  });
});

describe("sellableRevparSeries: what the colours rank", () => {
  const types = [
    { id: "king", total_rooms: 10, counts_as_room: true },
    { id: "court", total_rooms: 2, counts_as_room: false }, // the pickleball court
    { id: "suite", total_rooms: 5, counts_as_room: null }, // never classified: still a room
  ];

  it("divides each night's revenue by the rooms it could sell: rooms only, less rooms out of service", () => {
    const series = sellableRevparSeries(
      new Map([
        ["2026-10-01", 1500],
        ["2026-10-02", 1500],
      ]),
      types,
      [{ room_type_id: "king", start_date: "2026-10-02", end_date: "2026-10-02", units: 5 }],
      [],
    );
    expect(series).toEqual([
      { date: "2026-10-01", revpar: 100, closed: false },
      { date: "2026-10-02", revpar: 150, closed: false },
    ]);
    expect(isCountingRoom(undefined)).toBe(true);
    expect(isCountingRoom({ counts_as_room: false })).toBe(false);
  });

  it("marks a closed night, and is 0 for a night with nothing to sell", () => {
    expect(
      sellableRevparSeries(new Map([["2026-12-25", 400]]), [{ id: "king", total_rooms: 4 }], [{ room_type_id: "king", start_date: "2026-12-20", end_date: "2026-12-31", units: 9 }], [
        { start_date: "2026-12-24", end_date: "2026-12-26" },
      ]),
    ).toEqual([{ date: "2026-12-25", revpar: 0, closed: true }]);
  });
});

describe("getCalendar (Supabase): the colours rank the RevPAR each day shows", () => {
  afterEach(() => {
    clearCalendarHistoryCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** One night's bookings: n rooms of a type, each at `each`. */
  const nightOf = (stay: string, rt: string, n: number, each: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `${stay}-${rt}-${i}`, hotel_id: "h1", stay_date: stay, room_type_id: rt, base_rate: each, current_rate: each }));

  it("colours a night by its sellable RevPAR, past and future alike, not by every room type over every room", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z"), toFake: ["Date"] });
    const reservations = [
      // Ten ordinary nights ahead: King at 60 to 105 per room.
      ...Array.from({ length: 10 }, (_, i) => nightOf(`2026-10-${String(5 + i).padStart(2, "0")}`, "rt1", 5, 120 + 10 * i)).flat(),
      // The 15th: 500 of King with 6 of the 10 out of service, so 125 per room it could sell.
      ...nightOf("2026-10-15", "rt1", 4, 125),
      // The 16th: 550 of King, and a 2,000 court booking that is not a room.
      ...nightOf("2026-10-16", "rt1", 5, 110),
      ...nightOf("2026-10-16", "rt2", 1, 2000),
      // A past night, coloured the same way.
      ...nightOf("2026-09-28", "rt1", 2, 100),
    ];
    const { client } = fakeSupabase({
      hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
      room_types: [
        { id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 10, counts_as_room: true },
        { id: "rt2", hotel_id: "h1", name: "Court", is_active: true, total_rooms: 2, counts_as_room: false },
      ],
      room_type_out_of_service: [
        { id: "o1", hotel_id: "h1", room_type_id: "rt1", start_date: "2026-10-15", end_date: "2026-10-15", units: 6, cleared_at: null },
      ],
      reservations,
    });
    const cal = await getCalendar(2026, 10, client as unknown as SupabaseClient);
    expect(cal.days["15"]).toMatchObject({ total: 4, sellable_revpar: 125, revpar: 125, color: "green" });
    expect(cal.days["16"]).toMatchObject({ total: 10, sellable_revpar: 55, revpar: 55, color: "red" });
    // Every day is coloured by the RevPAR it shows.
    for (const day of Object.values(cal.days)) expect(day.revpar).toBe(day.sellable_revpar ?? 0);
    const sept = await getCalendar(2026, 9, client as unknown as SupabaseClient);
    expect(sept.days["28"]).toMatchObject({ sellable_revpar: 20, revpar: 20, color: "red" });
  });
});

describe("getCalendar (Supabase) on a property past the 1,000-row cap", () => {
  afterEach(() => {
    clearCalendarHistoryCache();
    vi.restoreAllMocks();
  });

  function bigMonth() {
    const types = ["rt1", "rt2", "rt3"].map((id, i) => ({
      id, hotel_id: "h1", name: `T${i}`, is_active: true, total_rooms: 60, counts_as_room: i < 2,
    }));
    const reservations: FakeRow[] = [];
    const published: FakeRow[] = [];
    let n = 0;
    for (let d = 1; d <= 31; d++) {
      const stay = `2026-10-${String(d).padStart(2, "0")}`;
      for (const [t, rt] of types.entries()) {
        for (let k = 0; k < 20 + ((d * 7 + t) % 25); k++) {
          n++;
          reservations.push({
            id: `r${String(n).padStart(6, "0")}`, hotel_id: "h1", stay_date: stay, room_type_id: rt.id,
            base_rate: n % 9 === 0 ? null : 100 + (n % 37) + 0.25,
            current_rate: n % 13 === 0 ? null : 120 + (n % 11) + 0.5,
          });
        }
        published.push({ hotel_id: "h1", stay_date: stay, room_type_id: rt.id, price: 150 + d, base_price: d % 3 ? 140 : null });
      }
      reservations.push({ id: `u${d}`, hotel_id: "h1", stay_date: stay, room_type_id: null, base_rate: 1, current_rate: 1 });
    }
    return {
      hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
      room_types: types,
      reservations,
      published_price: published,
      manual_price: [{ id: "m1", hotel_id: "h1", stay_date: "2026-10-31", room_type_id: "rt3", price: 99, set_at: "2026-09-01T00:00:00Z", cleared_at: null }],
    };
  }

  it("builds every cell from every row, the same cells an uncapped read gives", async () => {
    const seed = bigMonth();
    expect(seed.reservations.length).toBeGreaterThan(2000);
    const uncapped = await getCalendar(2026, 10, calendarDb(seed).client);
    clearCalendarHistoryCache();
    const capped = await getCalendar(2026, 10, calendarDb(seed, { maxRows: 1000 }).client);
    expect(capped.days).toEqual(uncapped.days);
    // The last day of the month, well past the first 1,000 rows, is booked.
    expect(capped.days["31"].booked).toBeGreaterThan(0);
    expect(capped.days["31"].room_types.find((r) => r.id === "rt3")!.manual_price).toMatchObject({ price: 99 });
    expect(capped.days["31"].room_types.find((r) => r.id === "rt2")!.current_price).toBe(181);
  });
});

describe("getCalendar (Supabase) revenue series", () => {
  afterEach(() => {
    clearCalendarHistoryCache();
    vi.restoreAllMocks();
  });

  it("reads the same series through calendar_daily_revenue_v3 as through the v2 and v1 fallbacks, past 1,000 dates", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const reservations: FakeRow[] = [];
    for (let d = 0; d < 1500; d++) {
      const stay = new Date(Date.UTC(2023, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
      for (let k = 0; k < 1 + (d % 3); k++) {
        // One rate per booking, on a type that counts: all three read the same revenue.
        const rate = k === 1 ? null : 90 + (d % 50) + 0.33;
        reservations.push({ id: `r${d}-${k}`, hotel_id: "h1", stay_date: stay, room_type_id: "rt1", base_rate: rate, current_rate: rate });
      }
    }
    const seed = {
      hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
      room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
      reservations,
    };
    const missing = (fn: string) => new FakeRpcError({ code: "PGRST202", message: `Could not find the function public.${fn}` });
    const v3 = fakeSupabase(seed, { maxRows: 1000 });
    const viaV3 = await getCalendar(2026, 1, v3.client);
    clearCalendarHistoryCache();
    const v2 = fakeSupabase(seed, {
      maxRows: 1000,
      rpc: (fn, args, tables) =>
        fn === "calendar_daily_revenue_v3" ? missing(fn) : fn === "calendar_daily_revenue_v2" ? calendarDailyRevenueV2(tables.reservations, args as Record<string, unknown>) : undefined,
    });
    const viaV2 = await getCalendar(2026, 1, v2.client);
    clearCalendarHistoryCache();
    const v1 = fakeSupabase(seed, {
      maxRows: 1000,
      rpc: (fn, args, tables) =>
        fn === "calendar_daily_revenue_v3" || fn === "calendar_daily_revenue_v2"
          ? missing(fn)
          : fn === "calendar_daily_revenue"
            ? calendarDailyRevenue(tables.reservations, args as Record<string, unknown>)
            : undefined,
    });
    const viaV1 = await getCalendar(2026, 1, v1.client);
    expect(viaV3).toEqual(viaV2);
    expect(viaV3).toEqual(viaV1);
    expect(viaV3.range.min).toBe("2023-01");
    expect(v3.calls.filter((c) => c.table === "rpc:calendar_daily_revenue_v3").length).toBe(2);
    expect(v3.calls.some((c) => c.table === "rpc:calendar_daily_revenue_v2")).toBe(false);
    expect(v2.calls.filter((c) => c.table === "rpc:calendar_daily_revenue_v2").length).toBe(2);
    // The missing v3 is said once, with the file to run.
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("calendar_daily_revenue_v3")).length).toBe(1);
  });
});

describe("getCalendar (Supabase) manual prices", () => {
  afterEach(() => {
    clearCalendarHistoryCache();
    vi.restoreAllMocks();
  });

  const seed = (manual: FakeRow[]) => ({
    hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
    room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
    manual_price: manual,
  });

  /** A client that fails a manual_price read ordered by a column the table doesn't have, as PostgREST does. */
  function strictDb(rows: Record<string, FakeRow[]>, fault?: (c: FakeCall) => FakeError | null) {
    let orderedById = false;
    const db = calendarDb(rows, {
      fault: (c) =>
        c.table === "manual_price" && orderedById ? { code: "42703", message: "column manual_price.id does not exist" } : (fault?.(c) ?? null),
    });
    type Builder = { order: (col: string, o?: unknown) => Builder };
    const from = (db.client as unknown as { from: (t: string) => Builder }).from;
    (db.client as unknown as { from: unknown }).from = (table: string) => {
      const b = from(table);
      if (table !== "manual_price") return b;
      const order = b.order;
      b.order = (col: string, o?: unknown) => {
        if (col === "id") orderedById = true;
        return order(col, o);
      };
      return b;
    };
    return db;
  }

  it("shows a typed price and a price changed in the PMS, and says which", async () => {
    const { client } = strictDb(
      seed([
        { hotel_id: "h1", stay_date: "2026-10-10", room_type_id: "rt1", price: 150, set_at: "2026-09-01T00:00:00Z", cleared_at: null, source: "maya", pms_type: null },
        { hotel_id: "h1", stay_date: "2026-10-11", room_type_id: "rt1", price: 0, set_at: "2026-09-02T00:00:00Z", cleared_at: null, source: "pms", pms_type: "cloudbeds" },
        { hotel_id: "h1", stay_date: "2026-10-12", room_type_id: "rt1", price: 180, set_at: "2026-09-02T00:00:00Z", cleared_at: "2026-09-03T00:00:00Z", source: "pms", pms_type: "cloudbeds" },
      ]),
    );
    const cal = await getCalendar(2026, 10, client);
    const cell = (day: string) => cal.days[day].room_types[0].manual_price;
    expect(cell("10")).toEqual({ price: 150, set_at: "2026-09-01T00:00:00Z", source: "maya", pms_type: null });
    expect(cell("11")).toEqual({ price: 0, set_at: "2026-09-02T00:00:00Z", source: "pms", pms_type: "cloudbeds" });
    expect(cell("12")).toBeNull();
  });

  it("still shows manual prices on a database without the source columns", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = strictDb(
      seed([{ hotel_id: "h1", stay_date: "2026-10-10", room_type_id: "rt1", price: 150, set_at: "2026-09-01T00:00:00Z", cleared_at: null }]),
      (c) => (c.table === "manual_price" && c.columns.includes("source") ? missingColumn("manual_price", "source") : null),
    );
    const cal = await getCalendar(2026, 10, client);
    expect(cal.days["10"].room_types[0].manual_price).toEqual({ price: 150, set_at: "2026-09-01T00:00:00Z", source: "maya", pms_type: null });
  });
});
