/**
 * Rank gate for hotel-scoped routes: hasHotelRank / requireSupabaseHotelRank.
 *
 * The PMS sync routes moved their pipeline onto the service-role client
 * (Vault RPCs are service-role-only), which makes this app-layer check the
 * only authorization left — so the boundary itself gets pinned here:
 * revenue_manager and up pass, staff/viewer do not, a membership-less
 * platform admin passes only in God Mode (the god_mode_active RPC, decided
 * by the database), the user id comes from the verified user and never the
 * cookie, and every failure mode denies.
 */
import { describe, expect, it, vi } from "vitest";

type Membership = { hotel_id: string; user_id: string; status: string; role: string };

function fakeClient(opts: {
  userId?: string | null;
  /** What the cookie claims, when a test wants it to differ from the verified user. */
  cookieUserId?: string | null;
  memberships?: Membership[];
  membershipError?: string;
  platformAdmin?: boolean;
  godMode?: boolean;
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

  const cookieUser = opts.cookieUserId === undefined ? opts.userId : opts.cookieUserId;
  const client = {
    auth: {
      getUser: async () => ({ data: { user: opts.userId ? { id: opts.userId } : null } }),
      getSession: async () => ({
        data: { session: cookieUser ? { user: { id: cookieUser } } : null },
      }),
    },
    from: () => membershipQuery(),
    rpc: async (fn: string) => ({
      data:
        fn === "is_platform_admin"
          ? Boolean(opts.platformAdmin)
          : fn === "god_mode_active"
            ? Boolean(opts.platformAdmin && opts.godMode)
            : null,
      error: null,
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

const state = vi.hoisted(() => ({ client: null as unknown, hotelId: "hotel-1" as string | null }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => state.hotelId }));

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

  it("lets a membership-less platform admin through only in God Mode", async () => {
    const off = fakeClient({ userId: "user-1", memberships: [], platformAdmin: true, godMode: false });
    expect(await hasHotelRank(off, HOTEL, "revenue_manager")).toBe(false);
    const on = fakeClient({ userId: "user-1", memberships: [], platformAdmin: true, godMode: true });
    expect(await hasHotelRank(on, HOTEL, "revenue_manager")).toBe(true);
    expect(await hasHotelRank(on, HOTEL, "hotel_admin")).toBe(true);
  });

  it("takes the person from the verified user, never from the cookie", async () => {
    // The cookie names a General Manager; the auth service says this is a Viewer.
    const client = fakeClient({
      userId: "user-1",
      cookieUserId: "user-2",
      memberships: [member("viewer"), member("general_manager", { user_id: "user-2" })],
    });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(false);
  });

  it("denies when there is no membership and no platform role", async () => {
    const client = fakeClient({ userId: "user-1", memberships: [] });
    expect(await hasHotelRank(client, HOTEL, "revenue_manager")).toBe(false);
  });

  it("denies without a signed-in user, whatever the cookie says", async () => {
    const client = fakeClient({ userId: null, cookieUserId: "user-1", memberships: [member("hotel_admin")] });
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
  it("returns the hotel context, with the verified user, for a revenue_manager", async () => {
    state.client = fakeClient({ userId: "user-1", memberships: [member("revenue_manager")] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await requireSupabaseHotelRank({} as any, "revenue_manager");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.hotelId).toBe(HOTEL);
      expect(ctx.userId).toBe("user-1");
    }
  });

  it("responds 403 for staff, naming the role it takes", async () => {
    state.client = fakeClient({ userId: "user-1", memberships: [member("staff")] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await requireSupabaseHotelRank({} as any, "revenue_manager");
    expect(ctx.ok).toBe(false);
    if (!ctx.ok) {
      expect(ctx.response.status).toBe(403);
      expect(await ctx.response.json()).toEqual({ error: "This needs Revenue Manager access or higher on this property." });
    }
  });

  it("tells a platform admin outside God Mode how to turn it on", async () => {
    state.client = fakeClient({ userId: "user-1", memberships: [], platformAdmin: true, godMode: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await requireSupabaseHotelRank({} as any, "revenue_manager");
    expect(ctx.ok).toBe(false);
    if (!ctx.ok) {
      expect(ctx.response.status).toBe(403);
      expect(await ctx.response.json()).toEqual({
        error: "God Mode is off. Turn it on from the Command Center to change this property.",
      });
    }
  });

  it("lets a platform admin in God Mode through", async () => {
    state.client = fakeClient({ userId: "user-1", memberships: [], platformAdmin: true, godMode: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await requireSupabaseHotelRank({} as any, "general_manager");
    expect(ctx.ok).toBe(true);
  });

  it("still responds 401 when signed out", async () => {
    state.client = fakeClient({ userId: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await requireSupabaseHotelRank({} as any, "revenue_manager");
    expect(ctx.ok).toBe(false);
    if (!ctx.ok) expect(ctx.response.status).toBe(401);
  });

  it("tells someone with no property they don't have access, in plain words", async () => {
    state.client = fakeClient({ userId: "user-1", memberships: [] });
    state.hotelId = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = await requireSupabaseHotelRank({} as any, "revenue_manager");
      expect(ctx.ok).toBe(false);
      if (!ctx.ok) {
        expect(ctx.response.status).toBe(400);
        expect(await ctx.response.json()).toEqual({ error: "You don't have access to this property." });
      }
    } finally {
      state.hotelId = HOTEL;
    }
  });
});
