/**
 * One window for evaluation, the base rate calendar and the push: the hotel's
 * today through today + horizon - 1, 396 nights (tonight and the next 395)
 * unless MAYA_PRICING_HORIZON_DAYS says otherwise, and never past the
 * reservation reads.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SYNC_DAYS_FORWARD,
  MAX_PRICING_HORIZON_DAYS,
  lastNightOf,
  pricingHorizonDays,
  readHotelClock,
  syncDaysForward,
} from "../../../supabase/functions/_shared/pms/pricing-window";
import { evalIsoToHotelDateString } from "../../../supabase/functions/_shared/engine/timezone";
import { fakeSupabase } from "../engine/fake-supabase.test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("pricingHorizonDays", () => {
  it("is 396 by default: tonight and the next 395 nights", () => {
    vi.stubEnv("MAYA_PRICING_HORIZON_DAYS", "");
    vi.stubEnv("MAYA_SYNC_DAYS_FORWARD", "");
    expect(pricingHorizonDays()).toBe(396);
  });

  it("follows MAYA_PRICING_HORIZON_DAYS, whole nights, capped where the engine caps", () => {
    vi.stubEnv("MAYA_PRICING_HORIZON_DAYS", "45");
    expect(pricingHorizonDays()).toBe(45);
    expect(pricingHorizonDays("30.9")).toBe(30);
    expect(pricingHorizonDays("60")).toBe(60);
    expect(pricingHorizonDays("900", 900)).toBe(MAX_PRICING_HORIZON_DAYS);
    expect(MAX_PRICING_HORIZON_DAYS).toBe(400);
  });

  it("ignores the old MAYA_EVAL_HORIZON_DAYS, which production still has at 30", () => {
    vi.stubEnv("MAYA_PRICING_HORIZON_DAYS", "");
    vi.stubEnv("MAYA_EVAL_HORIZON_DAYS", "30");
    expect(pricingHorizonDays()).toBe(396);
  });

  it("falls back to 396 on a value that is not a positive number", () => {
    for (const raw of ["0", "-5", "abc", undefined]) expect(pricingHorizonDays(raw, 396)).toBe(396);
  });

  it("never reaches past the reservation reads, and says so once", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("MAYA_SYNC_DAYS_FORWARD", "200");
    expect(syncDaysForward()).toBe(200);
    expect(pricingHorizonDays("396")).toBe(200);
    expect(pricingHorizonDays("396")).toBe(200);
    expect(pricingHorizonDays("150")).toBe(150);
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(err.mock.calls[0][0]))).toMatchObject({ horizonDays: 396, syncDaysForward: 200 });
  });

  it("reads the reservations 396 days forward by default, as far as the window reaches", () => {
    vi.stubEnv("MAYA_SYNC_DAYS_FORWARD", "");
    expect(DEFAULT_SYNC_DAYS_FORWARD).toBe(396);
    expect(syncDaysForward()).toBe(396);
    expect(syncDaysForward("9999")).toBe(730);
  });
});

describe("lastNightOf", () => {
  it("counts today as the first night", () => {
    expect(lastNightOf("2026-10-01", 60)).toBe("2026-11-29");
    expect(lastNightOf("2026-10-01", 1)).toBe("2026-10-01");
    expect(lastNightOf("2026-12-15", 30)).toBe("2027-01-13");
  });
});

describe("readHotelClock", () => {
  it("gives the hotel's date, behind or ahead of UTC, the way the engine derives it", async () => {
    const at = "2026-10-02T05:00:00.000Z";
    const db = fakeSupabase({
      hotels: [
        { id: "la", timezone: "America/Los_Angeles" },
        { id: "tokyo", timezone: "Asia/Tokyo" },
      ],
    });
    expect(await readHotelClock(db.client, "la", at)).toEqual({ at, today: "2026-10-01", timeZone: "America/Los_Angeles" });
    expect((await readHotelClock(db.client, "tokyo", "2026-10-01T20:00:00.000Z")).today).toBe("2026-10-02");
    expect((await readHotelClock(db.client, "la", at)).today).toBe(evalIsoToHotelDateString(at, "America/Los_Angeles"));
  });

  it("reads a hotel with no timezone as UTC, as the engine does", async () => {
    const db = fakeSupabase({ hotels: [{ id: "h", timezone: null }] });
    expect((await readHotelClock(db.client, "h", "2026-10-02T05:00:00.000Z")).today).toBe("2026-10-02");
  });

  it("throws when the hotel can't be read, rather than quietly using the UTC date", async () => {
    const db = fakeSupabase({}, { fault: (c) => (c.table === "hotels" ? { message: "timeout" } : null) });
    await expect(readHotelClock(db.client, "h")).rejects.toThrow(/timezone/);
  });
});

describe("the dev loops that push to a real PMS", () => {
  // They run the tick's steps by hand. Evaluating 45 nights and pushing the
  // default 60 sent nights 46 to 60 at whatever an older run had left.
  it.each(["scripts/cloudbeds-live-loop.mts", "scripts/think-live-loop.mts"])("%s evaluates and pushes one window", (script) => {
    const source = readFileSync(resolve(__dirname, "../../..", script), "utf8");
    expect(source).toMatch(/evaluateHotel\(admin, HOTEL_ID, undefined, HORIZON_DAYS\)/);
    expect(source).toMatch(/pushRatesForHotel\(admin, HOTEL_ID, adapter, \{ pushHorizonDays: HORIZON_DAYS \}\)/);
    expect(source).toMatch(/const HORIZON_DAYS = pricingHorizonDays\(\);/);
  });
});
