/**
 * Manual Cloudbeds sync trigger: revenue_manager and up, staff/viewer never.
 * Mirrors the Mews sync route test; see that file for why the pipeline must
 * receive the service-role client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

function fakeUserClient(opts: { userId?: string | null; role?: string | null; platformAdmin?: boolean }) {
  const api = {
    select: () => api,
    eq: () => api,
    then(resolve: (v: { data: unknown; error: null }) => void) {
      const rows = opts.role ? [{ role: opts.role }] : [];
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  const client = {
    auth: {
      getUser: async () => ({ data: { user: opts.userId ? { id: opts.userId } : null } }),
      getSession: async () => ({
        data: { session: opts.userId ? { user: { id: opts.userId } } : null },
      }),
    },
    from: () => api,
    rpc: async () => ({ data: Boolean(opts.platformAdmin), error: null }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

const state = vi.hoisted(() => ({
  userClient: null as unknown,
  adminClient: { marker: "service-role" } as unknown,
}));
const runCloudbedsSyncForHotel = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.userClient }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => state.adminClient,
  isAdminConfigured: () => true,
}));
vi.mock("@/lib/cloudbeds/sync-hotel", () => ({ runCloudbedsSyncForHotel }));

const { POST } = await import("./route");

function post(body?: unknown) {
  return POST(
    new Request("http://localhost/api/pms/cloudbeds/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const SYNC_OK = {
  ok: true,
  creds: { accessToken: "t", tokenType: "Bearer", baseUrl: "https://api", propertyId: "p1" },
  fetchWindow: { checkInFrom: "2026-07-01", checkInTo: "2027-08-01" },
  apiPages: 1,
  roomTypesUpserted: 0,
  reservationRowsUpserted: 0,
  ingest: {},
};

beforeEach(() => {
  runCloudbedsSyncForHotel.mockReset();
  runCloudbedsSyncForHotel.mockResolvedValue(SYNC_OK);
});

describe("POST /api/pms/cloudbeds/sync rank gate", () => {
  it.each(["viewer", "staff"])("%s gets 403 and no sync runs", async (role) => {
    state.userClient = fakeUserClient({ userId: "user-1", role });
    const res = await post();
    expect(res.status).toBe(403);
    expect(runCloudbedsSyncForHotel).not.toHaveBeenCalled();
  });

  it.each(["revenue_manager", "general_manager", "hotel_admin"])(
    "%s triggers the sync",
    async (role) => {
      state.userClient = fakeUserClient({ userId: "user-1", role });
      const res = await post({ daysBack: 5 });
      expect(res.status).toBe(200);
      expect(runCloudbedsSyncForHotel).toHaveBeenCalledTimes(1);
    },
  );

  it("runs the pipeline on the service-role client, not the session client", async () => {
    state.userClient = fakeUserClient({ userId: "user-1", role: "revenue_manager" });
    await post();
    expect(runCloudbedsSyncForHotel.mock.calls[0][0]).toBe(state.adminClient);
    expect(runCloudbedsSyncForHotel.mock.calls[0][1]).toBe("hotel-1");
  });

  it("does not leak resolved credentials in the response", async () => {
    state.userClient = fakeUserClient({ userId: "user-1", role: "revenue_manager" });
    const res = await post();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("accessToken");
  });
});
