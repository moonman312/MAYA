/**
 * Manual Think sync trigger: revenue_manager and up, staff/viewer never.
 * Mirrors the Mews sync route test; see that file for why the pipeline must
 * receive the service-role client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

function fakeUserClient(opts: {
  userId?: string | null;
  role?: string | null;
  platformAdmin?: boolean;
  /** Omitted means no subscription row at all, which is the entitled default. */
  subscriptionStatus?: string;
}) {
  function table(name: string) {
    const api = {
      select: () => api,
      eq: () => api,
      in: () => api,
      then(resolve: (v: { data: unknown; error: null }) => void) {
        const rows =
          name === "hotel_subscriptions"
            ? opts.subscriptionStatus
              ? [{ hotel_id: "hotel-1", status: opts.subscriptionStatus }]
              : []
            : opts.role
              ? [{ role: opts.role }]
              : [];
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return api;
  }
  const client = {
    auth: {
      getUser: async () => ({ data: { user: opts.userId ? { id: opts.userId } : null } }),
      getSession: async () => ({
        data: { session: opts.userId ? { user: { id: opts.userId } } : null },
      }),
    },
    from: (name: string) => table(name),
    rpc: async () => ({ data: Boolean(opts.platformAdmin), error: null }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

const state = vi.hoisted(() => {
  const adminRpc = vi.fn();
  return {
    userClient: null as unknown,
    adminRpc,
    adminClient: { marker: "service-role", rpc: adminRpc } as unknown,
  };
});
const runThinkSyncForHotel = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.userClient }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => state.adminClient,
  isAdminConfigured: () => true,
}));
vi.mock("@/lib/think/sync-hotel", () => ({ runThinkSyncForHotel }));

const { POST } = await import("./route");

function post(body?: unknown) {
  return POST(
    new Request("http://localhost/api/pms/think/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const SYNC_OK = {
  ok: true,
  windowFullyCovered: true,
  fetchWindow: { start: "2026-07-06", end: "2027-09-05" },
  apiPages: 1,
  roomTypesUpserted: 0,
  reservationRowsUpserted: 0,
  ingest: {},
};

beforeEach(() => {
  runThinkSyncForHotel.mockReset();
  runThinkSyncForHotel.mockResolvedValue(SYNC_OK);
  state.adminRpc.mockReset();
  state.adminRpc.mockImplementation(async (fn: string) =>
    fn === "claim_pms_sync_one" ? { data: "claimed", error: null } : { data: null, error: null },
  );
});

function rpcCalls(fn: string) {
  return state.adminRpc.mock.calls.filter((c) => c[0] === fn);
}

describe("POST /api/pms/think/sync rank gate", () => {
  it.each(["viewer", "staff"])("%s gets 403 and no sync runs", async (role) => {
    state.userClient = fakeUserClient({ userId: "user-1", role });
    const res = await post();
    expect(res.status).toBe(403);
    expect(runThinkSyncForHotel).not.toHaveBeenCalled();
  });

  it.each(["revenue_manager", "general_manager", "hotel_admin"])(
    "%s triggers the sync",
    async (role) => {
      state.userClient = fakeUserClient({ userId: "user-1", role });
      const res = await post({ daysBack: 5 });
      expect(res.status).toBe(200);
      expect(runThinkSyncForHotel).toHaveBeenCalledTimes(1);
    },
  );

  it("runs the pipeline on the service-role client, not the session client", async () => {
    state.userClient = fakeUserClient({ userId: "user-1", role: "revenue_manager" });
    await post();
    expect(runThinkSyncForHotel.mock.calls[0][0]).toBe(state.adminClient);
    expect(runThinkSyncForHotel.mock.calls[0][1]).toBe("hotel-1");
  });

  it("says whether the window was fully covered", async () => {
    // A budget-truncated run must not read as a complete one from the button.
    state.userClient = fakeUserClient({ userId: "user-1", role: "revenue_manager" });
    runThinkSyncForHotel.mockResolvedValue({ ...SYNC_OK, windowFullyCovered: false });
    const body = await (await post()).json();
    expect(body.windowFullyCovered).toBe(false);
  });

  it.each(["canceled", "unpaid"])("refuses to run for a %s subscription", async (status) => {
    // The cron already skips these hotels; without this the same property could
    // still pull its PMS and reprice on demand from the button.
    state.userClient = fakeUserClient({
      userId: "user-1",
      role: "hotel_admin",
      subscriptionStatus: status,
    });
    const res = await post();
    expect(res.status).toBe(402);
    expect(runThinkSyncForHotel).not.toHaveBeenCalled();
  });

  it.each(["trialing", "past_due"])("still runs for a %s subscription", async (status) => {
    // past_due is inside Stripe's retry window — cutting them off there is
    // exactly what isEntitledStatus refuses to do.
    state.userClient = fakeUserClient({
      userId: "user-1",
      role: "hotel_admin",
      subscriptionStatus: status,
    });
    expect((await post()).status).toBe(200);
    expect(runThinkSyncForHotel).toHaveBeenCalled();
  });
});

describe("POST /api/pms/think/sync in-flight guard", () => {
  beforeEach(() => {
    state.userClient = fakeUserClient({ userId: "user-1", role: "revenue_manager" });
  });

  it("409s a press while another sync holds the connection's lease", async () => {
    // The request counter bounds how often; the lease bounds how many at once.
    // Six concurrent presses each pacing in their own isolate is what blows the
    // property's PMS budget.
    state.adminRpc.mockImplementation(async (fn: string) =>
      fn === "claim_pms_sync_one" ? { data: "busy", error: null } : { data: null, error: null },
    );
    const res = await post();
    expect(res.status).toBe(409);
    expect(runThinkSyncForHotel).not.toHaveBeenCalled();
    expect(rpcCalls("release_pms_sync")).toHaveLength(0);
  });

  it("hands the lease back once the sync finishes", async () => {
    expect((await post()).status).toBe(200);
    const releases = rpcCalls("release_pms_sync");
    expect(releases).toHaveLength(1);
    expect(releases[0][1]).toMatchObject({ p_hotel_id: "hotel-1", p_pms_type: "think", p_ok: true });
  });

  it("releases as a failure when the sync fails, so retries back off", async () => {
    runThinkSyncForHotel.mockResolvedValue({ ok: false, error: "token revoked" });
    await post();
    expect(rpcCalls("release_pms_sync")[0][1]).toMatchObject({ p_ok: false });
  });

  it("releases even when the pipeline throws", async () => {
    runThinkSyncForHotel.mockRejectedValue(new Error("boom"));
    expect((await post()).status).toBe(502);
    expect(rpcCalls("release_pms_sync")[0][1]).toMatchObject({ p_ok: false });
  });

  it("runs unleased when there is no connection row to hold", async () => {
    state.adminRpc.mockImplementation(async (fn: string) =>
      fn === "claim_pms_sync_one" ? { data: "missing", error: null } : { data: null, error: null },
    );
    expect((await post()).status).toBe(200);
    expect(runThinkSyncForHotel).toHaveBeenCalledTimes(1);
    expect(rpcCalls("release_pms_sync")).toHaveLength(0);
  });
});
