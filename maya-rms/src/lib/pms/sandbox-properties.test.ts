/**
 * Hotels on a vendor's sandbox are test properties (hotels.is_test), so they
 * stay out of business analytics and their product events follow. One list
 * of sandbox ids; every connect path, the claim and the Cloudbeds sync use it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSandboxProperty,
  markSandboxHotel,
  markSandboxHotelsByKey,
  SANDBOX_PMS_PROPERTIES,
} from "../../../supabase/functions/_shared/pms/sandbox-properties";
import { fakeSupabase } from "../engine/fake-supabase.test";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isSandboxProperty", () => {
  it("knows Cloudbeds' sandbox, by its id as a string or a number, and nothing else", () => {
    expect(SANDBOX_PMS_PROPERTIES.cloudbeds).toContain("320691");
    expect(isSandboxProperty("cloudbeds", "320691")).toBe(true);
    expect(isSandboxProperty("cloudbeds", 320691)).toBe(true);
    expect(isSandboxProperty("cloudbeds", " 320691 ")).toBe(true);
    expect(isSandboxProperty("cloudbeds", "3206910")).toBe(false);
    expect(isSandboxProperty("think", "320691")).toBe(false);
    expect(isSandboxProperty("cloudbeds", null)).toBe(false);
    expect(isSandboxProperty("cloudbeds", "")).toBe(false);
  });
});

describe("markSandboxHotel", () => {
  const world = () =>
    fakeSupabase({
      hotels: [
        { id: "sandbox", is_test: false },
        { id: "real", is_test: false },
      ],
    });

  it("flags a hotel on the sandbox, and writes nothing for any other property", async () => {
    const db = world();
    expect(await markSandboxHotel(db.client, "sandbox", "cloudbeds", "320691")).toBe(true);
    expect(await markSandboxHotel(db.client, "real", "cloudbeds", "555001")).toBe(false);
    expect(db.tables.hotels).toEqual([
      { id: "sandbox", is_test: true },
      { id: "real", is_test: false },
    ]);
    expect(db.calls.filter((c) => c.table === "hotels")).toHaveLength(1);
  });

  it("never throws: a failed write is logged and the next connect or sync tries again", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeSupabase({ hotels: [{ id: "sandbox", is_test: false }] }, { fault: () => ({ message: "timeout" }) });
    expect(await markSandboxHotel(db.client, "sandbox", "cloudbeds", "320691")).toBe(true);
    expect(String(log.mock.calls[0][0])).toContain('"fn":"markSandboxHotel"');
  });
});

describe("markSandboxHotelsByKey", () => {
  it("flags the claimed hotels whose Marketplace key names a sandbox", async () => {
    const db = fakeSupabase({
      hotels: [
        { id: "a", external_enterprise_id: "cloudbeds:320691", is_test: false },
        { id: "b", external_enterprise_id: "cloudbeds:555001", is_test: false },
        { id: "c", external_enterprise_id: null, is_test: false },
      ],
    });
    expect(await markSandboxHotelsByKey(db.client, ["a", "b", "c"])).toEqual(["a"]);
    expect(db.tables.hotels.map((h) => h.is_test)).toEqual([true, false, false]);
  });
});

describe("every way a hotel gets its property", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
  it("flags it: the Marketplace, signing up, reconnecting, the claim and the Cloudbeds sync", () => {
    expect(read("./marketplace-connect.ts")).toContain("isSandboxProperty(pmsType, property.propertyId) ? { is_test: true } : {}");
    expect(read("./marketplace-connect.ts")).toContain("await markSandboxHotel(admin, existing.id, pmsType, property.propertyId);");
    expect(read("../onboarding/connect.ts")).toContain("isSandboxProperty(pmsType, propertyId) ? { is_test: true } : {}");
    expect(read("./oauth-flow.ts")).toContain("await markSandboxHotel(admin, hotelId, pmsType, bound.propertyId);");
    expect(read("./marketplace-claim.ts")).toContain("await markSandboxHotelsByKey(admin, allHotelIds);");
    expect(read("../../../supabase/functions/_shared/cloudbeds/sync-hotel.ts")).toContain(
      'await markSandboxHotel(supabase, hotelId, "cloudbeds", propertyId);',
    );
  });
});
