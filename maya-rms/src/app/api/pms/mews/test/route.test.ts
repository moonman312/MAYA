/**
 * Mews connection test: same rank gate as the sync triggers (revenue_manager
 * and up), and credential resolution runs on the service-role client since
 * pms_secret_get is service-role-only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

function fakeUserClient(opts: { userId?: string | null; role?: string | null }) {
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
    rpc: async () => ({ data: false, error: null }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

const state = vi.hoisted(() => ({
  userClient: null as unknown,
  adminClient: { marker: "service-role" } as unknown,
}));
const resolveMewsCredentials = vi.hoisted(() => vi.fn());
const mewsConfigurationGet = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.userClient }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => state.adminClient,
  isAdminConfigured: () => true,
}));
vi.mock("@/lib/mews/resolve-credentials", () => ({
  resolveMewsCredentials,
  summarizeEnterprise: () => ({ name: "Test Hotel", id: "e1" }),
}));
vi.mock("@/lib/mews/client", () => ({ mewsConfigurationGet }));

const { POST } = await import("./route");

function post() {
  return POST(new Request("http://localhost/api/pms/mews/test", { method: "POST" }));
}

beforeEach(() => {
  resolveMewsCredentials.mockReset();
  resolveMewsCredentials.mockResolvedValue({
    creds: { clientToken: "c", accessToken: "a", baseUrl: "https://api.mews.com" },
    connectionId: null,
    source: "database",
  });
  mewsConfigurationGet.mockReset();
  mewsConfigurationGet.mockResolvedValue({ Enterprise: { Name: "Test Hotel", Id: "e1" } });
});

describe("POST /api/pms/mews/test rank gate", () => {
  it.each(["viewer", "staff"])("%s gets 403 before any credential resolution", async (role) => {
    state.userClient = fakeUserClient({ userId: "user-1", role });
    const res = await post();
    expect(res.status).toBe(403);
    expect(resolveMewsCredentials).not.toHaveBeenCalled();
    expect(mewsConfigurationGet).not.toHaveBeenCalled();
  });

  it("revenue_manager can run the test, on the service-role client", async () => {
    state.userClient = fakeUserClient({ userId: "user-1", role: "revenue_manager" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(resolveMewsCredentials.mock.calls[0][0]).toBe(state.adminClient);
  });
});
