/**
 * Rank gate for hotel-scoped routes: hasHotelRank / requireSupabaseHotelRank.
 *
 * The PMS sync routes moved their pipeline onto the service-role client
 * (Vault RPCs are service-role-only), which makes this app-layer check the
 * only authorization left — so the boundary itself gets pinned here:
 * revenue_manager and up pass, staff/viewer do not, membership-less platform
 * admins pass via the RPC fallback, and every failure mode denies.
 */
import { describe, expect, it, vi } from "vitest";

type Membership = { hotel_id: string; user_id: string; status: string; role: string };

function fakeClient(opts: {
  userId?: string | null;
  memberships?: Membership[];
  membershipError?: string;
  platformAdmin?: boolean;
}) {
  function membershipQuery() {
    const filters: Record<string, unknown> = {};
    const api = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters[col] = val;
        return api;
      },
      then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
        if (opts.membershipError) {
          return Promise.resolve({ data: null, error: { message: opts.membershipError } }).then(
            resolve,
          );
        }
        const rows = (opts.memberships ?? [])
          .filter(
            (r) =>
              r.hotel_id === filters.hotel_id &&
              r.user_id === filters.user_id &&
              r.status === filters.status,
          )
          .map((r) => ({ role: r.role }));
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
    from: () => membershipQuery(),
    rpc: async (fn: string) => ({
      data: fn === "is_platform_admin" ? Boolean(opts.platformAdmin) : null,
      error: null,
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));

const { hasHotelRank, requireSupabaseHotelRank } = await import("./require-supabase-hotel");

const HOTEL = "hotel-1";

function member(role: string, over: Partial<Membership> = {}): Membership {
  return { hotel_id: HOTEL, user_id: "user-1", status: "active", role, ...over };
}

describe("hasHotelRank at the revenue_manager floor", () => {
  it.each([
    ["viewer", false],
    ["staff", false],
    ["revenue_manager", true],
    ["general_manager", true],
    ["hotel_admin", true],
  ])("%s → %s", async (role, expected) => {
    const client = fakeClient({ userId: "user-1", memberships: [member(role)] });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(expected);
  });

  it("takes the highest of multiple memberships", async () => {
    const client = fakeClient({
      userId: "user-1",
      memberships: [member("staff"), member("revenue_manager")],
    });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(true);
  });

  it("ignores memberships at other hotels and inactive ones", async () => {
    const client = fakeClient({
      userId: "user-1",
      memberships: [
        member("hotel_admin", { hotel_id: "hotel-2" }),
        member("general_manager", { status: "pending" }),
        member("viewer"),
      ],
    });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(false);
  });

  it("lets a membership-less platform admin through", async () => {
    const client = fakeClient({ userId: "user-1", memberships: [], platformAdmin: true });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(true);
  });

  it("denies when there is no membership and no platform role", async () => {
    const client = fakeClient({ userId: "user-1", memberships: [] });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(false);
  });

  it("denies without a session", async () => {
    const client = fakeClient({ userId: null, memberships: [member("hotel_admin")] });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(false);
  });

  it("denies when the membership query errors", async () => {
    const client = fakeClient({ userId: "user-1", membershipError: "boom" });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(false);
  });

  it("denies an unknown role value", async () => {
    const client = fakeClient({ userId: "user-1", memberships: [member("manager")] });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(false);
  });
});

describe("requireSupabaseHotelRank", () => {
  it("returns the hotel context for a revenue_manager", async () => {
    state.client = fakeClient({ userId: "user-1", memberships: [member("revenue_manager")] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await requireSupabaseHotelRank({} as any, "revenue_manager");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) expect(ctx.hotelId).toBe(HOTEL);
  });

  it("responds 403 for staff", async () => {
    state.client = fakeClient({ userId: "user-1", memberships: [member("staff")] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await requireSupabaseHotelRank({} as any, "revenue_manager");
    expect(ctx.ok).toBe(false);
    if (!ctx.ok) expect(ctx.response.status).toBe(403);
  });

  it("still responds 401 when signed out", async () => {
    state.client = fakeClient({ userId: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await requireSupabaseHotelRank({} as any, "revenue_manager");
    expect(ctx.ok).toBe(false);
    if (!ctx.ok) expect(ctx.response.status).toBe(401);
  });
});
