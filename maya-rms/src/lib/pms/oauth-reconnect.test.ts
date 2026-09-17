/**
 * The reconnect prompt's button starts MAYA's own OAuth flow for the property
 * (/api/pms/cloudbeds/connect?hotelId=...), so the callback's hotel branch is
 * the other door a returning Marketplace owner comes back through. It has to
 * agree with the Marketplace reconnect: an unpaid property comes back parked,
 * one whose never-paid data was removed gets a fresh full import, and the
 * login has to reach the Cloudbeds property the hotel is bound to, whose ID is
 * stored with the credential again (the sweep deleted the old one).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  stripe: true,
  db: null as unknown as ReturnType<typeof import("../engine/fake-supabase.test").fakeSupabase>,
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  properties: [{ propertyId: "320691", name: "Sea View Inn" }] as { propertyId: string; name: string | null }[],
  listFails: false,
  claimsReadFails: false,
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => null }));
vi.mock("@/lib/pms/cloudbeds-webhooks", () => ({ ensureAppStateWebhook: async () => ({ ok: true }) }));
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsListPropertiesOrThrow: async () => {
    if (state.listFails) throw new Error("Cloudbeds 503");
    return state.properties;
  },
}));
vi.mock("@/lib/onboarding/connect", () => ({ handleOnboardingConnect: async () => new Response() }));
vi.mock("@/lib/pms/oauth-state", () => ({
  signOnboardingState: () => "s",
  signState: () => "s",
  verifyState: () => ({ ok: true, intent: "hotel", hotelId: "hotel-1", pmsType: "cloudbeds" }),
}));

const { handleOAuthCallback } = await import("./oauth-flow");

type Cookies = Parameters<typeof handleOAuthCallback>[0];

function property(opts: { claimed: boolean; purged: boolean; isActive?: boolean; subscription?: string }) {
  state.db = fakeSupabase({
    hotels: [
      {
        id: "hotel-1",
        name: "Sea View Inn",
        external_enterprise_id: "cloudbeds:320691",
        created_at: "2026-09-01T00:00:00.000Z",
        is_active: opts.isActive ?? false,
        setup_pending_at: opts.isActive ? null : "2026-09-01T00:00:00.000Z",
        setup_deferred_at: null,
        data_purged_at: opts.purged ? "2027-03-01T00:00:00.000Z" : null,
      },
    ],
    pms_marketplace_claims: opts.claimed
      ? [{ token: "tok", hotel_id: "hotel-1", pms_type: "cloudbeds", claimed_by: "user-1", claimed_at: "2026-09-01T00:00:00.000Z" }]
      : [],
    hotel_memberships: [{ hotel_id: "hotel-1", user_id: "user-1", status: "active" }],
    hotel_subscriptions: opts.subscription ? [{ hotel_id: "hotel-1", status: opts.subscription }] : [],
    pms_connections: [],
    import_jobs: [],
    onboarding_states: [],
  }, {
    fault: (c) =>
      state.claimsReadFails && c.table === "pms_marketplace_claims" ? { message: "connection reset", code: "08006" } : null,
    rpc: (fn, args) => {
      state.rpcs.push({ fn, args: args as Record<string, unknown> });
      return null;
    },
  });
  return state.db;
}

async function callback() {
  return handleOAuthCallback({} as Cookies, "cloudbeds", new URLSearchParams({ code: "abc", state: "signed" }));
}

const storedSecret = () => state.rpcs.find((r) => r.fn === "pms_secret_set")?.args.p_secret as
  | Record<string, unknown>
  | undefined;

beforeEach(() => {
  state.stripe = true;
  state.rpcs = [];
  state.properties = [{ propertyId: "320691", name: "Sea View Inn" }];
  state.listFails = false;
  state.claimsReadFails = false;
  process.env.CLOUDBEDS_CLIENT_ID = "id";
  process.env.CLOUDBEDS_CLIENT_SECRET = "secret";
  process.env.MAYA_INVITE_REDIRECT_BASE = "https://app.example";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("access_token")) {
        return new Response(
          JSON.stringify({ access_token: "cbat", refresh_token: "cbrt", expires_in: 3600, token_type: "Bearer" }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }),
  );
});

describe("the reconnect prompt's OAuth callback", () => {
  it("brings an unpaid purged property back parked, with a fresh full import queued", async () => {
    const db = property({ claimed: true, purged: true });
    const res = await callback();
    expect(res.status).toBe(302);
    expect(db.tables.pms_connections[0]).toMatchObject({ hotel_id: "hotel-1", status: "pending" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status: "queued", phase: "discover", requested_by: "user-1" });
  });

  it("connects a paid purged property and imports it again", async () => {
    const db = property({ claimed: true, purged: true, isActive: true, subscription: "active" });
    await callback();
    expect(db.tables.pms_connections[0].status).toBe("connected");
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.onboarding_states[0]).toMatchObject({ import_job_id: db.tables.import_jobs[0].id });
  });

  it("keeps an unpaid Marketplace property parked even when nothing was purged", async () => {
    const db = property({ claimed: true, purged: false });
    await callback();
    expect(db.tables.pms_connections[0].status).toBe("pending");
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("connects any other hotel as it always has, with no import", async () => {
    const db = property({ claimed: false, purged: false, isActive: true });
    await callback();
    expect(db.tables.pms_connections[0].status).toBe("connected");
    expect(db.tables.import_jobs).toEqual([]);
    expect(storedSecret()).not.toHaveProperty("propertyId");
  });

  it("stores the bound property ID, so a single-property login syncs the right property", async () => {
    property({ claimed: true, purged: true });
    await callback();
    expect(storedSecret()).toMatchObject({ accessToken: "cbat", propertyId: "320691" });
  });

  it("takes a group login, stores this property's ID, and imports it", async () => {
    state.properties = [
      { propertyId: "320690", name: "Sea View Annex" },
      { propertyId: "320691", name: "Sea View Inn" },
    ];
    const db = property({ claimed: true, purged: true });
    const res = await callback();
    expect(res.status).toBe(302);
    expect(storedSecret()).toMatchObject({ propertyId: "320691" });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.pms_connections[0]).toMatchObject({ status: "pending" });
  });

  it("says Cloudbeds didn't answer, not \"different property\", when the property list call fails", async () => {
    state.listFails = true;
    const db = property({ claimed: true, purged: true });
    const res = await callback();
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Cloudbeds didn't answer");
    expect(text).not.toContain("different property");
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("stores nothing when the claim can't be read, rather than treating the property as unbound", async () => {
    state.claimsReadFails = true;
    const db = property({ claimed: true, purged: true });
    const res = await callback();
    expect(res.status).toBe(400);
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections).toEqual([]);
    expect(db.tables.import_jobs).toEqual([]);
  });

  it("refuses a login for a different property: no credential, no connection, no import", async () => {
    state.properties = [{ propertyId: "999999", name: "Somewhere Else" }];
    const db = property({ claimed: true, purged: true, isActive: true, subscription: "active" });
    const res = await callback();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This login is for a different property.");
    expect(storedSecret()).toBeUndefined();
    expect(db.tables.pms_connections).toEqual([]);
    expect(db.tables.import_jobs).toEqual([]);
  });
});
