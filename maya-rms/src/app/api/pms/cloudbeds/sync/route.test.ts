/**
 * Manual Cloudbeds sync trigger: revenue_manager and up, staff/viewer never.
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
    expect(runCloudbedsSyncForHotel).not.toHaveBeenCalled();
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
    expect(runCloudbedsSyncForHotel).toHaveBeenCalled();
  });
});
