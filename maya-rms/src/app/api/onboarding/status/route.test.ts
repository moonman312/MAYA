/**
 * The status the Rules tab's "Get suggestions from my data" reads. It says
 * whether the hotel's property system has a history import at all, so the
 * button can stay off where a read would have nothing to read (Mews today).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connections: [] as Array<{ pms_type: string; status: string }>,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => false,
  createAdminClient: () => {
    throw new Error("no service role in this test");
  },
}));
vi.mock("@/lib/pms/pricing-window", () => ({ pricingHorizonDays: () => 396 }));
vi.mock("@/lib/pms/pricing-horizon", () => ({ hotelPricingHorizon: async () => 396 }));
vi.mock("@/lib/pms/purged", () => ({ marketplaceReconnectNeeded: async () => null }));
vi.mock("@/lib/require-supabase-hotel", () => ({ hasHotelRank: async () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (name: string) => {
      const rows = name === "pms_connections" ? state.connections : [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api: any = {
        select: () => api,
        eq: () => api,
        not: () => api,
        order: () => api,
        limit: () => api,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => void) => Promise.resolve({ data: rows, count: 0, error: null }).then(resolve),
      };
      return api;
    },
  }),
}));

const { GET } = await import("./route");

beforeEach(() => {
  state.connections = [];
});

describe("GET /api/onboarding/status", () => {
  it("says a Mews property has no history import, with the system's name", async () => {
    state.connections = [{ pms_type: "mews", status: "connected" }];
    const body = await (await GET()).json();
    expect(body).toMatchObject({ pmsType: "mews", pmsName: "Mews", historyImport: false });
  });

  it.each([
    ["cloudbeds", "Cloudbeds"],
    ["think", "Think Reservations"],
  ])("says a %s property has one", async (pmsType, pmsName) => {
    state.connections = [{ pms_type: pmsType, status: "connected" }];
    const body = await (await GET()).json();
    expect(body).toMatchObject({ pmsType, pmsName, historyImport: true });
  });

  it("says nothing either way with no connection", async () => {
    const body = await (await GET()).json();
    expect(body).toMatchObject({ pmsType: null, pmsName: null, historyImport: null });
  });
});
