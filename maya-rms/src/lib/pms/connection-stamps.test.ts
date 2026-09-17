/**
 * The two stamps the scheduled push reads from outside: a new grant ends a
 * hold whose fix was a new grant, and going live forces a base rate read
 * before the first push. Neither may fail the act it follows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { markConnectionReauthorized, requestBaseRateRefresh } from "./connection-stamps";
import { type FakeFault, fakeSupabase, missingColumn } from "../engine/fake-supabase.test";

vi.mock("server-only", () => ({}));
const { setHotelSimulationMode } = await import("../admin/hotels");

afterEach(() => vi.restoreAllMocks());

function db(fault?: FakeFault) {
  return fakeSupabase(
    {
      pms_connections: [
        { id: "c1", hotel_id: "h1", pms_type: "cloudbeds", base_rates_refreshed_at: "2026-09-17T10:00:00Z", reauthorized_at: null },
        { id: "c2", hotel_id: "h2", pms_type: "cloudbeds", base_rates_refreshed_at: "2026-09-17T10:00:00Z", reauthorized_at: null },
      ],
      hotel_settings: [{ hotel_id: "h1", simulation_mode: true }],
    },
    { fault, rpc: () => null },
  );
}

describe("connection stamps", () => {
  it("stamps only this hotel's connection as re-authorized", async () => {
    const d = db();
    await markConnectionReauthorized(d.client, "h1", "cloudbeds", "2026-09-17T12:00:00Z");
    expect(d.tables.pms_connections.map((c) => c.reauthorized_at)).toEqual(["2026-09-17T12:00:00Z", null]);
  });

  it("clears the refresh stamp so the next tick reads the PMS, whatever the hourly throttle says", async () => {
    const d = db();
    await requestBaseRateRefresh(d.client, "h1");
    expect(d.tables.pms_connections.map((c) => c.base_rates_refreshed_at)).toEqual([null, "2026-09-17T10:00:00Z"]);
  });

  it("logs rather than throws on a database without the columns", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = db((c) => (c.table === "pms_connections" ? missingColumn("pms_connections", "reauthorized_at") : null));
    await expect(markConnectionReauthorized(d.client, "h1", "cloudbeds")).resolves.toBeUndefined();
    await expect(requestBaseRateRefresh(d.client, "h1")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it("clears the stamp when an admin switches a hotel live, and not when it goes back to simulation", async () => {
    const d = db();
    await setHotelSimulationMode(d.client, "h1", true);
    expect(d.tables.pms_connections[0].base_rates_refreshed_at).toBe("2026-09-17T10:00:00Z");
    await setHotelSimulationMode(d.client, "h1", false);
    expect(d.tables.hotel_settings[0].simulation_mode).toBe(false);
    expect(d.tables.pms_connections[0].base_rates_refreshed_at).toBeNull();
  });
});
