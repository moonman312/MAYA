import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clearCalendarHistoryCache, countingCapacity, getCalendar, isCountingRoom } from "./calendar-store";
import { FakeRpcError, fakeSupabase, missingColumn, missingRelation, type FakeCall, type FakeError, type FakeRow } from "./engine/fake-supabase.test";
import { calendarDailyRevenue } from "./engine/scale-rpc-model.test";

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

describe("countingCapacity — the RevPAR / sellable occupancy denominator", () => {
  it("sums total_rooms over types that count as rooms", () => {
    expect(
      countingCapacity([
        { total_rooms: 40, counts_as_room: true },
        { total_rooms: 30, counts_as_room: true },
      ]),
    ).toBe(70);
  });

  it("leaves out a type flagged as not a room", () => {
    expect(
      countingCapacity([
        { total_rooms: 40, counts_as_room: true },
        { total_rooms: 2, counts_as_room: false }, // the pickleball court
      ]),
    ).toBe(40);
  });

  it("treats an unclassified type as a room — pre-migration rows still count", () => {
    expect(
      countingCapacity([
        { total_rooms: 40, counts_as_room: null },
        { total_rooms: 15 },
      ]),
    ).toBe(55);
    expect(isCountingRoom(undefined)).toBe(true);
    expect(isCountingRoom({ counts_as_room: false })).toBe(false);
  });

  it("is zero for an empty list, so RevPAR falls back to its no-rooms branch", () => {
    expect(countingCapacity([])).toBe(0);
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

  it("reads the same series through calendar_daily_revenue_v2 as through the v1 fallback, past 1,000 dates", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reservations: FakeRow[] = [];
    for (let d = 0; d < 1500; d++) {
      const stay = new Date(Date.UTC(2023, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
      for (let k = 0; k < 1 + (d % 3); k++) {
        reservations.push({ id: `r${d}-${k}`, hotel_id: "h1", stay_date: stay, room_type_id: "rt1", base_rate: 100, current_rate: k === 1 ? null : 90 + (d % 50) + 0.33 });
      }
    }
    const seed = {
      hotels: [{ id: "h1", timezone: "UTC", total_rooms_per_type: 100 }],
      room_types: [{ id: "rt1", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, counts_as_room: true }],
      reservations,
    };
    const v2 = fakeSupabase(seed, { maxRows: 1000 });
    const viaV2 = await getCalendar(2026, 1, v2.client);
    clearCalendarHistoryCache();
    const v1 = fakeSupabase(seed, {
      maxRows: 1000,
      rpc: (fn, args, tables) =>
        fn === "calendar_daily_revenue_v2"
          ? new FakeRpcError({ code: "PGRST202", message: "Could not find the function public.calendar_daily_revenue_v2" })
          : fn === "calendar_daily_revenue"
            ? calendarDailyRevenue(tables.reservations, args as Record<string, unknown>)
            : undefined,
    });
    const viaV1 = await getCalendar(2026, 1, v1.client);
    expect(viaV2).toEqual(viaV1);
    expect(viaV2.range.min).toBe("2023-01");
    expect(v2.calls.filter((c) => c.table === "rpc:calendar_daily_revenue_v2").length).toBe(2);
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
