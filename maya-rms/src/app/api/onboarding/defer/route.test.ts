/**
 * "Not now" for a parked Marketplace property. The route only ever touches the
 * two setup_deferred columns, and only on a hotel that is the caller's (at
 * General Manager or above), still parked, pointed at by a redeemed claim,
 * not paid for, and not the last place the owner has left to go. Everything
 * else is a door that stays shut, and every change leaves an audit line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const USER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const VIEWER = "88888888-8888-4888-8888-888888888888";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";
const FLOW_B = "44444444-4444-4444-8444-444444444444";
const PAID = "55555555-5555-4555-8555-555555555555";

const NOW = new Date("2026-09-16T09:00:00Z");

function fakeAdmin(seed: Record<string, Row[]>, opts: { noColumn?: boolean } = {}) {
  const tables = new Map(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const tableOf = (t: string) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };
  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    let single = false;
    const api = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      not(col: string) {
        filters.push((r) => r[col] != null);
        return api;
      },
      is(col: string) {
        filters.push((r) => r[col] == null);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      order: () => api,
      limit: () => api,
      update(next: Row) {
        patch = next;
        return api;
      },
      maybeSingle() {
        single = true;
        return run();
      },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        return run().then(resolve, reject);
      },
    };
    async function run() {
      const rows = tableOf(table).filter((r) => filters.every((f) => f(r)));
      if (patch) {
        if (opts.noColumn && table === "hotels" && "setup_deferred_at" in patch) {
          return {
            data: null,
            error: { code: "42703", message: "column hotels.setup_deferred_at does not exist" },
          };
        }
        for (const r of rows) Object.assign(r, patch);
      }
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }
    return api;
  }
  const client = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: null, error: null };
    },
  };
  return { client, tables, rpcs };
}

const state = vi.hoisted(() => ({
  userId: null as string | null,
  fake: null as unknown,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }) },
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => (state.fake as ReturnType<typeof fakeAdmin>).client,
}));

const { POST, DELETE } = await import("./route");

function seed(opts: { noColumn?: boolean } = {}) {
  const parked = (id: string) => ({
    id,
    is_active: false,
    setup_pending_at: "2026-09-10T14:08:00Z",
    setup_deferred_at: null,
    setup_deferred_by: null,
  });
  return fakeAdmin(
    {
      hotel_memberships: [
        { hotel_id: HOTEL, user_id: USER, role: "hotel_admin", status: "active" },
        { hotel_id: LIVE, user_id: USER, role: "hotel_admin", status: "active" },
        { hotel_id: FLOW_B, user_id: USER, role: "hotel_admin", status: "active" },
        { hotel_id: PAID, user_id: USER, role: "hotel_admin", status: "active" },
        // A lapsed membership is no membership.
        { hotel_id: HOTEL, user_id: STRANGER, role: "hotel_admin", status: "revoked" },
        // Invited, but below the rank a billing-queue decision needs.
        { hotel_id: HOTEL, user_id: VIEWER, role: "viewer", status: "active" },
      ],
      hotels: [
        parked(HOTEL),
        { ...parked(LIVE), is_active: true, setup_pending_at: null },
        parked(FLOW_B),
        parked(PAID),
      ],
      pms_marketplace_claims: [
        { hotel_id: HOTEL, claimed_by: USER, claimed_at: "2026-09-10T14:09:00Z" },
        { hotel_id: LIVE, claimed_by: USER, claimed_at: "2026-09-10T14:09:00Z" },
        { hotel_id: PAID, claimed_by: USER, claimed_at: "2026-09-10T14:09:00Z" },
      ],
      hotel_subscriptions: [{ hotel_id: PAID, status: "trialing" }],
    },
    opts,
  );
}

function request(method: string, body: unknown) {
  return new Request("http://localhost/api/onboarding/defer", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const post = (body: unknown) => POST(request("POST", body));
const del = (body: unknown) => DELETE(request("DELETE", body));

function fake() {
  return state.fake as ReturnType<typeof fakeAdmin>;
}
function hotel(id: string) {
  return fake().tables.get("hotels")!.find((h) => h.id === id)!;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  state.userId = USER;
  state.fake = seed();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/onboarding/defer", () => {
  it("stamps the flag on the caller's parked property and audits it", async () => {
    const res = await post({ hotelId: HOTEL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hotelId: HOTEL, deferred: true });
    expect(hotel(HOTEL)).toMatchObject({
      setup_deferred_at: NOW.toISOString(),
      setup_deferred_by: USER,
    });
    expect(fake().rpcs).toEqual([
      {
        name: "platform_log_event",
        args: expect.objectContaining({
          p_event_type: "pms.marketplace_deferred",
          p_entity_type: "hotel",
          p_hotel_id: HOTEL,
          p_detail: expect.objectContaining({ actor_user_id: USER }),
        }),
      },
    ]);
  });

  it("401 signed out, 400 for a malformed id — nothing touched", async () => {
    state.userId = null;
    expect((await post({ hotelId: HOTEL })).status).toBe(401);
    state.userId = USER;
    expect((await post({ hotelId: "nope" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(hotel(HOTEL).setup_deferred_at).toBeNull();
    expect(fake().rpcs).toEqual([]);
  });

  it("403 for a property the caller is not a member of", async () => {
    state.userId = STRANGER;
    const res = await post({ hotelId: HOTEL });
    expect(res.status).toBe(403);
    expect(hotel(HOTEL).setup_deferred_at).toBeNull();
  });

  it("403 below General Manager — the same bar as paying for it", async () => {
    state.userId = VIEWER;
    const res = await post({ hotelId: HOTEL });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/General Manager/);
    expect(hotel(HOTEL).setup_deferred_at).toBeNull();
  });

  it("409 for the last property left to set up when nothing is live — the stale-tab case", async () => {
    // Two tabs both showed "Not now" while two siblings were unpaid; the
    // first deferred one, the second is now asking to defer the last. With
    // no live property either, saying yes strands the owner on the plain
    // subscribe screen with the billing page (and its "Set up") unreachable.
    const t = fake().tables;
    t.set("hotel_memberships", t.get("hotel_memberships")!.filter((m) => m.hotel_id !== LIVE));
    const res = await post({ hotelId: HOTEL });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/only property left/);
    expect(hotel(HOTEL).setup_deferred_at).toBeNull();
    expect(fake().rpcs).toEqual([]);
  });

  it("allows the deferral while another unpaid sibling is still waiting, even with nothing live", async () => {
    const t = fake().tables;
    t.set("hotel_memberships", t.get("hotel_memberships")!.filter((m) => m.hotel_id !== LIVE));
    // PAID becomes an unpaid sibling once its subscription is gone.
    t.set("hotel_subscriptions", []);
    expect((await post({ hotelId: HOTEL })).status).toBe(200);
    expect(hotel(HOTEL).setup_deferred_at).toBe(NOW.toISOString());
  });

  it("409 once the property is live", async () => {
    const res = await post({ hotelId: LIVE });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already set up/);
  });

  it("409 for a parked row no Marketplace claim points at (Flow B's placeholder)", async () => {
    const res = await post({ hotelId: FLOW_B });
    expect(res.status).toBe(409);
    expect(hotel(FLOW_B).setup_deferred_at).toBeNull();
  });

  it("409 when a live subscription already sits on it", async () => {
    const res = await post({ hotelId: PAID });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already paid/);
  });

  it("404 for a hotel that is gone", async () => {
    fake().tables.set("hotels", []);
    expect((await post({ hotelId: HOTEL })).status).toBe(404);
  });

  it("503, not 500, when the column has not been migrated yet — and says so", async () => {
    state.fake = seed({ noColumn: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ hotelId: HOTEL });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("This needs a database update first.");
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("setup_deferred_v1");
    expect(fake().rpcs).toEqual([]);
    errorSpy.mockRestore();
  });
});

describe("DELETE /api/onboarding/defer", () => {
  it("clears both columns and audits the resume", async () => {
    Object.assign(hotel(HOTEL), { setup_deferred_at: "2026-09-12T00:00:00Z", setup_deferred_by: USER });
    const res = await del({ hotelId: HOTEL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hotelId: HOTEL, deferred: false });
    expect(hotel(HOTEL)).toMatchObject({ setup_deferred_at: null, setup_deferred_by: null });
    expect(fake().rpcs[0].args.p_event_type).toBe("pms.marketplace_resumed");
  });

  it("keeps the same doors as POST", async () => {
    state.userId = STRANGER;
    expect((await del({ hotelId: HOTEL })).status).toBe(403);
    state.userId = USER;
    expect((await del({ hotelId: LIVE })).status).toBe(409);
  });
});
