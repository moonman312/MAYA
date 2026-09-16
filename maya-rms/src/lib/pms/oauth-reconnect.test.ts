/**
 * The reconnect prompt's button starts MAYA's own OAuth flow for the property
 * (/api/pms/cloudbeds/connect?hotelId=...), so the callback's hotel branch is
 * the other door a returning Marketplace owner comes back through. It has to
 * agree with the Marketplace reconnect: an unpaid property comes back parked,
 * and one whose never-paid data was removed gets a fresh full import.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  stripe: true,
  db: null as unknown as ReturnType<typeof import("../engine/fake-supabase.test").fakeSupabase>,
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => null }));
vi.mock("@/lib/pms/cloudbeds-webhooks", () => ({ ensureAppStateWebhook: async () => ({ ok: true }) }));
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
        is_active: opts.isActive ?? false,
        setup_pending_at: opts.isActive ? null : "2026-09-01T00:00:00.000Z",
        setup_deferred_at: null,
        data_purged_at: opts.purged ? "2027-03-01T00:00:00.000Z" : null,
      },
    ],
    pms_marketplace_claims: opts.claimed
      ? [{ token: "tok", hotel_id: "hotel-1", pms_type: "cloudbeds", claimed_by: "user-1", claimed_at: "2026-09-01T00:00:00.000Z" }]
      : [],
    hotel_subscriptions: opts.subscription ? [{ hotel_id: "hotel-1", status: opts.subscription }] : [],
    pms_connections: [],
    import_jobs: [],
    onboarding_states: [],
  });
  return state.db;
}

async function callback() {
  return handleOAuthCallback({} as Cookies, "cloudbeds", new URLSearchParams({ code: "abc", state: "signed" }));
}

beforeEach(() => {
  state.stripe = true;
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
  });
});
