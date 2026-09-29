/**
 * "Connect App" in the Cloudbeds Marketplace on a property someone connected
 * from inside MAYA. That hotel carries no Marketplace key on its row (its
 * Cloudbeds property ID is kept with its credential), so the Marketplace path
 * never found it and parked a second, separate property beside it.
 *
 * Now it is found by its property ID and reconnected the way its own
 * Reconnect button would, but only for someone that button is for: signed in
 * with General Manager access or higher on it. Anyone else gets a plain
 * sentence and nothing is added or changed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRpcError, fakeSupabase } from "../engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("../engine/fake-supabase.test").fakeSupabase>,
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  properties: [{ propertyId: "320691", name: "Sea View Inn" }] as { propertyId: string; name: string | null }[],
  userId: "user-gm" as string | null,
  role: "general_manager" as string | null,
  platformAdmin: false,
  secretReadFails: false,
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => true }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => {
    const rows = () => (state.userId && state.role ? [{ role: state.role }] : []);
    const chain = {
      select: () => chain,
      eq: () => chain,
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res),
    };
    return {
      auth: {
        getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
        getSession: async () => ({ data: { session: state.userId ? { user: { id: state.userId } } : null } }),
      },
      from: () => chain,
      rpc: async (fn: string) => ({ data: fn === "is_platform_admin" ? state.platformAdmin : false, error: null }),
    };
  },
}));
vi.mock("@/lib/pms/cloudbeds-webhooks", () => ({ ensureAppStateWebhook: async () => ({ ok: true }) }));
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsListProperties: async () => state.properties,
  cloudbedsListPropertiesOrThrow: async () => state.properties,
  cloudbedsDiscoverPropertyId: async () => state.properties[0]?.propertyId ?? null,
  cloudbedsGetHotelDetails: async () => ({
    externalPropertyId: state.properties[0]?.propertyId,
    name: state.properties[0]?.name ?? null,
    timezone: "Europe/Lisbon",
    currency: "EUR",
  }),
}));
vi.mock("@/lib/onboarding/connect", () => ({ handleOnboardingConnect: async () => new Response() }));
vi.mock("@/lib/pms/oauth-state", () => ({
  signOnboardingState: () => "s",
  signState: () => "s",
  verifyState: () => null,
}));

const { handleOAuthCallback } = await import("./oauth-flow");

type Cookies = Parameters<typeof handleOAuthCallback>[0];

/** The Sea View Inn as onboarding left it: paid, connected from inside MAYA, now disconnected. */
function connectedInsideMaya() {
  state.db = fakeSupabase(
    {
      hotels: [
        {
          id: "hotel-1",
          name: "Sea View Inn",
          external_enterprise_id: null,
          is_active: true,
          setup_pending_at: null,
          setup_deferred_at: null,
          data_purged_at: null,
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      hotel_memberships: [{ hotel_id: "hotel-1", user_id: "user-owner", role: "hotel_admin", status: "active" }],
      hotel_subscriptions: [{ hotel_id: "hotel-1", status: "active" }],
      pms_connections: [{ hotel_id: "hotel-1", pms_type: "cloudbeds", status: "disconnected" }],
      pms_marketplace_claims: [],
      import_jobs: [],
      onboarding_states: [],
    },
    {
      rpc: (fn, args) => {
        state.rpcs.push({ fn, args: args as Record<string, unknown> });
        if (fn === "pms_secret_get") {
          if (state.secretReadFails) return new FakeRpcError({ message: "vault unavailable" });
          const a = args as { p_hotel_id: string };
          return a.p_hotel_id === "hotel-1" ? { accessToken: "old", propertyId: "320691" } : null;
        }
        return null;
      },
    },
  );
  return state.db;
}

const connectApp = () => handleOAuthCallback({} as Cookies, "cloudbeds", new URLSearchParams({ code: "abc" }));
const secretWrites = () => state.rpcs.filter((r) => r.fn === "pms_secret_set");

beforeEach(() => {
  state.rpcs = [];
  state.properties = [{ propertyId: "320691", name: "Sea View Inn" }];
  state.userId = "user-gm";
  state.role = "general_manager";
  state.platformAdmin = false;
  state.secretReadFails = false;
  process.env.CLOUDBEDS_CLIENT_ID = "id";
  process.env.CLOUDBEDS_CLIENT_SECRET = "secret";
  process.env.MAYA_INVITE_REDIRECT_BASE = "https://app.example";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "cbat", refresh_token: "cbrt", expires_in: 3600, token_type: "Bearer" }), {
        status: 200,
      }),
    ),
  );
});

describe("Connect App on a property connected from inside MAYA", () => {
  it.each(["general_manager", "hotel_admin"])("reconnects it for a signed-in %s, and adds no second property", async (role) => {
    state.role = role;
    const db = connectedInsideMaya();
    const res = await connectApp();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.example/?tab=pms&dl=pms&note=reconnected");
    expect(res.headers.get("set-cookie")).toContain("maya_active_hotel=hotel-1");
    expect(db.tables.hotels).toHaveLength(1);
    expect(db.tables.pms_marketplace_claims).toEqual([]);
    expect(db.tables.pms_connections).toEqual([expect.objectContaining({ hotel_id: "hotel-1", status: "connected" })]);
    expect(secretWrites()).toHaveLength(1);
    expect(secretWrites()[0].args).toMatchObject({
      p_hotel_id: "hotel-1",
      p_secret: { accessToken: "cbat", propertyId: "320691" },
    });
  });

  it("reconnects it for a platform admin too", async () => {
    state.role = null;
    state.platformAdmin = true;
    const db = connectedInsideMaya();
    expect((await connectApp()).status).toBe(302);
    expect(db.tables.hotels).toHaveLength(1);
  });

  it.each([
    ["a Revenue Manager", "user-rm", "revenue_manager"],
    ["a Viewer", "user-v", "viewer"],
    ["someone with no role on it", "user-x", null],
    ["someone signed out", null, null],
  ])("tells %s plainly, and adds or changes nothing", async (_who, userId, role) => {
    state.userId = userId;
    state.role = role;
    const db = connectedInsideMaya();
    const res = await connectApp();

    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("This property is already in MAYA, so nothing new was added.");
    expect(text).toContain("Reconnecting it needs General Manager access or higher on it.");
    expect(text).not.toContain("—");
    expect(db.tables.hotels).toHaveLength(1);
    expect(db.tables.pms_marketplace_claims).toEqual([]);
    expect(db.tables.pms_connections).toEqual([expect.objectContaining({ status: "disconnected" })]);
    expect(secretWrites()).toEqual([]);
  });

  it("adds nothing when it cannot tell whether the property is already in MAYA", async () => {
    state.secretReadFails = true;
    const db = connectedInsideMaya();
    const res = await connectApp();
    expect(res.status).toBe(400);
    expect(db.tables.hotels).toHaveLength(1);
    expect(db.tables.pms_marketplace_claims).toEqual([]);
    expect(secretWrites()).toEqual([]);
  });

  it("still parks a property that is not in MAYA, for its owner to claim", async () => {
    state.properties = [{ propertyId: "555001", name: "Harbour Annex" }];
    const db = connectedInsideMaya();
    const res = await connectApp();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/app\.example\/login\?claim=/);
    expect(db.tables.hotels).toHaveLength(2);
    expect(db.tables.hotels[1]).toMatchObject({ external_enterprise_id: "cloudbeds:555001", is_active: false });
    expect(db.tables.pms_connections.find((c) => c.hotel_id === "hotel-1")?.status).toBe("disconnected");
  });
});
