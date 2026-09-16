/**
 * Pins what /api/events will and will not write into the product log: only
 * named events, only typed properties, the session's own user, and a property
 * the caller actually belongs to. And that analytics never becomes an error a
 * page has to handle once the caller is known.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";
const MINE = "22222222-2222-4222-8222-222222222222";
const NOT_MINE = "33333333-3333-4333-8333-333333333333";
const COOKIE_HOTEL = "44444444-4444-4444-8444-444444444444";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  rpcs: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as { message: string } | null,
  throttled: false,
  memberships: [] as { hotel_id: string; user_id: string; status: string }[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => COOKIE_HOTEL }));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: async () =>
    state.throttled ? new Response(JSON.stringify({ error: "slow down" }), { status: 429 }) : null,
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcs.push({ name, args });
      return { data: state.rpcError ? null : 1, error: state.rpcError };
    },
    from: () => {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return q;
        },
        maybeSingle: async () => ({
          data:
            state.memberships.find((m) =>
              Object.entries(filters).every(([k, v]) => (m as Record<string, unknown>)[k] === v),
            ) ?? null,
          error: null,
        }),
      };
      return q;
    },
  }),
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/events", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  state.user = { id: USER };
  state.rpcs = [];
  state.rpcError = null;
  state.throttled = false;
  state.memberships = [{ hotel_id: MINE, user_id: USER, status: "active" }];
});

describe("POST /api/events", () => {
  it("records a named event against the session's user and the property it names", async () => {
    const res = await post({
      event: "billing.checkout_started",
      properties: { interval: "year", rooms: 24, has_code: true, marketplace: true },
      hotelId: MINE,
    });
    expect(res.status).toBe(204);
    expect(state.rpcs).toEqual([
      {
        name: "product_event_emit",
        args: {
          p_event: "billing.checkout_started",
          p_hotel_id: MINE,
          p_user_id: USER,
          p_properties: { interval: "year", rooms: 24, has_code: true, marketplace: true },
          p_source: "app",
        },
      },
    ]);
  });

  it("refuses an event that is not on the list, and writes nothing", async () => {
    const res = await post({ event: "guest.email_captured", properties: { email: "a@b.c" } });
    expect(res.status).toBe(400);
    expect(state.rpcs).toEqual([]);
  });

  it("keeps only typed properties, so nothing typed by a person gets through", async () => {
    await post({
      event: "billing.checkout_started",
      properties: {
        interval: "fortnight",
        rooms: "24; drop table",
        has_code: "yes",
        email: "owner@example.com",
        note: "call me",
        marketplace: false,
      },
    });
    expect(state.rpcs[0].args.p_properties).toEqual({ marketplace: false });
  });

  it("drops counts that are not counts", async () => {
    await post({ event: "billing.subscribe_viewed", properties: { trial_days: -3, group_total: 2.5, group_position: 1 } });
    expect(state.rpcs[0].args.p_properties).toEqual({ group_position: 1 });
  });

  it("only accepts a tab the dashboard has", async () => {
    await post({ event: "dashboard.tab_opened", properties: { tab: "changelog" } });
    await post({ event: "dashboard.tab_opened", properties: { tab: "<script>" } });
    expect(state.rpcs.map((r) => r.args.p_properties)).toEqual([{ tab: "changelog" }, {}]);
  });

  it("never attributes an event to a property the caller is not a member of", async () => {
    await post({ event: "billing.subscribe_viewed", hotelId: NOT_MINE });
    expect(state.rpcs[0].args.p_hotel_id).toBeNull();
  });

  it("falls back to the active property when none is named", async () => {
    await post({ event: "explain.opened" });
    expect(state.rpcs[0].args.p_hotel_id).toBe(COOKIE_HOTEL);
  });

  it("ignores a user id in the body", async () => {
    await post({ event: "explain.opened", userId: "55555555-5555-4555-8555-555555555555" });
    expect(state.rpcs[0].args.p_user_id).toBe(USER);
  });

  it("wants a session", async () => {
    state.user = null;
    const res = await post({ event: "explain.opened" });
    expect(res.status).toBe(401);
    expect(state.rpcs).toEqual([]);
  });

  it("is rate limited per user", async () => {
    state.throttled = true;
    const res = await post({ event: "explain.opened" });
    expect(res.status).toBe(429);
    expect(state.rpcs).toEqual([]);
  });

  it("answers 204 even when the log could not be written", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.rpcError = { message: "function product_event_emit does not exist" };
    const res = await post({ event: "simulator.used" });
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
