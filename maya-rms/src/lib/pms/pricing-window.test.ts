/**
 * One window for evaluation, the base rate calendar and the push: the hotel's
 * today through today + horizon - 1, 60 nights unless MAYA_EVAL_HORIZON_DAYS
 * says otherwise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lastNightOf,
  pricingHorizonDays,
  readHotelClock,
} from "../../../supabase/functions/_shared/pms/pricing-window";
import { evalIsoToHotelDateString } from "../../../supabase/functions/_shared/engine/timezone";
import { fakeSupabase } from "../engine/fake-supabase.test";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pricingHorizonDays", () => {
  it("is 60 by default, the window the support page promises", () => {
    vi.stubEnv("MAYA_EVAL_HORIZON_DAYS", "");
    expect(pricingHorizonDays()).toBe(60);
  });

  it("follows MAYA_EVAL_HORIZON_DAYS, whole nights, capped where the engine caps", () => {
    vi.stubEnv("MAYA_EVAL_HORIZON_DAYS", "45");
    expect(pricingHorizonDays()).toBe(45);
    expect(pricingHorizonDays("30.9")).toBe(30);
    expect(pricingHorizonDays("400")).toBe(365);
  });

  it("falls back to 60 on a value that is not a positive number", () => {
    for (const raw of ["0", "-5", "abc", undefined]) expect(pricingHorizonDays(raw)).toBe(60);
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
