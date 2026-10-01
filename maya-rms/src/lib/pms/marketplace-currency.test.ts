/**
 * "Connect App" in the Cloudbeds Marketplace for a property in a currency
 * MAYA doesn't price in yet (Jake, 2026-09-30, audits A20 and A58). Only
 * dollar, euro and pound style currencies connect for now. Anything else is
 * stopped before a hotel row, a credential, a webhook or a claim ticket
 * exists for it, and the refusal is counted. A property already in MAYA is
 * never checked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("../engine/fake-supabase.test").fakeSupabase>,
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  properties: [] as { propertyId: string; name: string | null }[],
  currencies: {} as Record<string, string | null>,
  webhooks: [] as string[],
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => true }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/pms/cloudbeds-webhooks", () => ({
  ensureAppStateWebhook: async (_creds: unknown, hotelId: string) => {
    state.webhooks.push(hotelId);
    return { ok: true };
  },
}));
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsListProperties: async () => state.properties,
  cloudbedsDiscoverPropertyId: async () => state.properties[0]?.propertyId ?? null,
  cloudbedsGetHotelDetails: async (creds: { propertyId: string }) => ({
    externalPropertyId: creds.propertyId,
    name: state.properties.find((p) => p.propertyId === creds.propertyId)?.name ?? null,
    timezone: "Asia/Seoul",
    currency: state.currencies[creds.propertyId] ?? null,
  }),
}));

import { handleMarketplaceConnect } from "./marketplace-connect";

const TOKENS = {
  accessToken: "cbat_new",
  refreshToken: "cbrt_new",
  tokenType: "Bearer",
  scope: null,
  expiresAt: "2026-10-02T00:00:00.000Z",
};

function world(seed: Record<string, FakeRow[]> = {}) {
  state.db = fakeSupabase(seed, {
    rpc: (fn, args) => {
      state.rpcs.push({ fn, args: args as Record<string, unknown> });
      return null;
    },
  });
  return state.db;
}
const refusals = () => state.rpcs.filter((r) => r.fn === "product_event_emit" && r.args.p_event === "pms.currency_refused");

beforeEach(() => {
  state.rpcs = [];
  state.webhooks = [];
  state.properties = [{ propertyId: "880011", name: "Juniper Lodge" }];
  state.currencies = { "880011": "KRW" };
});

describe("a property new to MAYA in a currency it doesn't price in yet", () => {
  it("is refused with a plain sentence, and nothing about it is stored", async () => {
    const db = world();
    const outcome = await handleMarketplaceConnect("cloudbeds", TOKENS);

    expect(outcome).toEqual({
      kind: "refused",
      message: "Your property's system uses KRW. MAYA doesn't price in KRW yet, so nothing was set up or imported. Email us and we'll tell you when it does.",
    });
    expect(db.tables.hotels ?? []).toEqual([]);
    expect(db.tables.pms_connections ?? []).toEqual([]);
    expect(db.tables.pms_marketplace_claims ?? []).toEqual([]);
    expect(state.rpcs.some((r) => r.fn === "pms_secret_set")).toBe(false);
    expect(state.webhooks).toEqual([]);
    expect(refusals().map((r) => r.args)).toEqual([
      expect.objectContaining({
        p_hotel_id: null,
        p_properties: { currency: "KRW", via: "marketplace_flow_a" },
        p_pms_type: "cloudbeds",
        p_pms_property_id: "880011",
        p_property_name: "Juniper Lodge",
      }),
    ]);
  });

  it("parks the rest of a group and says how many were left out", async () => {
    state.properties = [
      { propertyId: "880011", name: "Juniper Lodge" },
      { propertyId: "880012", name: "Harbour Inn" },
      { propertyId: "880013", name: "Juniper Annex" },
    ];
    state.currencies = { "880011": "KRW", "880012": "USD", "880013": "JPY" };
    const db = world();
    const outcome = await handleMarketplaceConnect("cloudbeds", TOKENS);

    expect(outcome).toMatchObject({ kind: "claim", propertyName: "Harbour Inn", groupProperties: 3, parked: 1, currencySkipped: 2 });
    expect((db.tables.hotels ?? []).map((h) => [h.name, h.currency])).toEqual([["Harbour Inn", "USD"]]);
    expect(refusals().map((r) => (r.args.p_properties as Record<string, unknown>).currency)).toEqual(["KRW", "JPY"]);
  });

  it.each(["USD", "CAD", "AUD", "NZD", "EUR", "GBP", "CHF", null])("parks a property in %s as before", async (currency) => {
    state.currencies = { "880011": currency };
    const db = world();
    const outcome = await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(outcome).toMatchObject({ kind: "claim", propertyName: "Juniper Lodge" });
    expect(outcome).not.toHaveProperty("currencySkipped");
    // No currency at all is stored as US dollars, as it always was.
    expect(db.tables.hotels[0]).toMatchObject({ currency: currency ?? "USD", is_active: false });
    expect(refusals()).toEqual([]);
  });
});

describe("a property already in MAYA", () => {
  it("reconnects whatever its currency: existing hotels are never checked", async () => {
    const db = world({
      hotels: [{ id: "hotel-1", name: "Juniper Lodge", external_enterprise_id: "cloudbeds:880011", is_active: true, currency: "KRW" }],
      hotel_memberships: [{ hotel_id: "hotel-1", user_id: "user-1", status: "active" }],
      pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", status: "disconnected" }],
      hotel_subscriptions: [{ hotel_id: "hotel-1", status: "active" }],
    });
    const outcome = await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(outcome).toMatchObject({ kind: "reconnected", hotelId: "hotel-1" });
    expect(db.tables.pms_connections[0].status).toBe("connected");
    expect(refusals()).toEqual([]);
  });
});
