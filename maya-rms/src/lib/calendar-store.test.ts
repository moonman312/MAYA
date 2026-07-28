import { describe, expect, it } from "vitest";
import { getCalendar } from "./calendar-store";

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
