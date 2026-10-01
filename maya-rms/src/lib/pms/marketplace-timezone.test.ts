/**
 * The time zone and currency a property new to MAYA is saved with at
 * "Connect App". Cloudbeds lists each property's time zone on getHotels, the
 * call that finds the properties in the first place; getHotelDetails has
 * none. So a details read that fails, or comes back without one, still saves
 * the property's own time zone, and UTC only when Cloudbeds gave none at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../engine/fake-supabase.test";

type Listed = { propertyId: string; name: string | null; timezone?: string | null; currency?: string | null };

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("../engine/fake-supabase.test").fakeSupabase>,
  properties: [] as Listed[],
  details: null as null | { timezone: string | null; currency: string | null } | "fails",
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => true }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/pms/cloudbeds-webhooks", () => ({ ensureAppStateWebhook: async () => ({ ok: true }) }));
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsListProperties: async () => state.properties,
  cloudbedsDiscoverPropertyId: async () => state.properties[0]?.propertyId ?? null,
  cloudbedsGetHotelDetails: async (creds: { propertyId: string }) => {
    if (state.details === "fails") throw new Error("Cloudbeds getHotelDetails failed (503): upstream");
    return {
      externalPropertyId: creds.propertyId,
      name: state.properties.find((p) => p.propertyId === creds.propertyId)?.name ?? null,
      timezone: state.details?.timezone ?? null,
      currency: state.details?.currency ?? null,
    };
  },
}));

import { handleMarketplaceConnect } from "./marketplace-connect";

const TOKENS = {
  accessToken: "cbat_new",
  refreshToken: "cbrt_new",
  tokenType: "Bearer",
  scope: null,
  expiresAt: "2026-10-02T00:00:00.000Z",
};

beforeEach(() => {
  state.db = fakeSupabase({}, { rpc: () => null });
  state.properties = [{ propertyId: "880021", name: "Juniper Lodge", timezone: "America/Chicago", currency: "USD" }];
  state.details = { timezone: null, currency: "USD" };
});

const saved = () => state.db.tables.hotels.map((h) => [h.name, h.timezone, h.currency]);

describe("a new property's time zone at Connect App", () => {
  it("is the one getHotels listed it with when the details read has none", async () => {
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(saved()).toEqual([["Juniper Lodge", "America/Chicago", "USD"]]);
  });

  it("is the details read's own when it has one", async () => {
    state.details = { timezone: "America/Denver", currency: "USD" };
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(saved()).toEqual([["Juniper Lodge", "America/Denver", "USD"]]);
  });

  it("survives a failed details read with the listed time zone and currency", async () => {
    state.details = "fails";
    state.properties = [{ propertyId: "880021", name: "Juniper Lodge", timezone: "Europe/London", currency: "GBP" }];
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(saved()).toEqual([["Juniper Lodge", "Europe/London", "GBP"]]);
  });

  it("is UTC, and the currency US dollars, only when Cloudbeds gave neither anywhere", async () => {
    state.details = { timezone: null, currency: null };
    state.properties = [{ propertyId: "880021", name: "Juniper Lodge" }];
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(saved()).toEqual([["Juniper Lodge", "UTC", "USD"]]);
  });

  it("is each property's own in a group", async () => {
    state.properties = [
      { propertyId: "880021", name: "Juniper Lodge", timezone: "America/Chicago", currency: "USD" },
      { propertyId: "880022", name: "Harbour Inn", timezone: "America/Halifax", currency: "CAD" },
    ];
    state.details = { timezone: null, currency: null };
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(saved().sort()).toEqual([
      ["Harbour Inn", "America/Halifax", "CAD"],
      ["Juniper Lodge", "America/Chicago", "USD"],
    ]);
  });
});
