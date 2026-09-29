/**
 * Hotel scope resolution: listAccessibleHotels / resolveAccessibleHotelId.
 *
 * The part worth pinning is the MAYA_DEFAULT_HOTEL_ID fallback: it exists for
 * membership-less dev setups, and in production it must stay dead — a
 * signed-in user with no memberships gets null, not the env hotel. Beside it,
 * the support view: a platform admin may open any active property to look at
 * it, and nobody else may, whatever the cookie claims.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type MembershipRow = {
  hotel_id: string;
  hotels: { id: string; name: string };
};

type HotelRow = { id: string; name: string; is_active: boolean };

function fakeClient(opts: {
  userId?: string | null;
  rows?: MembershipRow[];
  queryError?: string;
  /** The platform role, as the database answers is_platform_admin. */
  platformAdmin?: boolean;
  /** What the hotels table holds, for the support view lookup. */
  hotels?: HotelRow[];
}) {
  const membershipQuery = {
    select: () => membershipQuery,
    eq: () => membershipQuery,
    then(
      resolve: (v: { data: MembershipRow[] | null; error: { message: string } | null }) => void,
    ) {
      if (opts.queryError) {
        return Promise.resolve({ data: null, error: { message: opts.queryError } }).then(resolve);
      }
      return Promise.resolve({ data: opts.rows ?? [], error: null }).then(resolve);
    },
  };

  function hotelsQuery() {
    const filters: Record<string, unknown> = {};
    const api = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters[col] = val;
        return api;
      },
      maybeSingle: async () => {
        const hit = (opts.hotels ?? []).find((h) => h.id === filters.id && h.is_active === filters.is_active);
        return { data: hit ? { id: hit.id, name: hit.name } : null, error: null };
      },
    };
    return api;
  }

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: opts.userId ? { user: { id: opts.userId } } : null },
      }),
    },
    from: (table: string) => (table === "hotels" ? hotelsQuery() : membershipQuery),
    rpc: async (fn: string) => ({ data: fn === "is_platform_admin" ? Boolean(opts.platformAdmin) : null, error: null }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any;
}

const state = vi.hoisted(() => ({ cookie: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "maya_active_hotel" && state.cookie ? { value: state.cookie } : undefined,
  }),
}));

const { listAccessibleHotels, resolveAccessibleHotelId, supportViewHotel } = await import("./hotel-context");

function row(id: string, name: string): MembershipRow {
  return { hotel_id: id, hotels: { id, name } };
}

afterEach(() => {
  state.cookie = null;
  vi.unstubAllEnvs();
});

describe("listAccessibleHotels", () => {
  it("returns memberships sorted by name, deduped", async () => {
    const client = fakeClient({
      userId: "user-1",
      rows: [row("h2", "Zeta Inn"), row("h1", "Alpha Lodge"), row("h2", "Zeta Inn")],
    });
    expect(await listAccessibleHotels(client)).toEqual([
      { id: "h1", name: "Alpha Lodge" },
      { id: "h2", name: "Zeta Inn" },
    ]);
  });

  it("returns [] without a session", async () => {
    const client = fakeClient({ userId: null, rows: [row("h1", "Alpha Lodge")] });
    expect(await listAccessibleHotels(client)).toEqual([]);
  });

  it("returns [] when the query errors", async () => {
    const client = fakeClient({ userId: "user-1", queryError: "boom" });
    expect(await listAccessibleHotels(client)).toEqual([]);
  });

  it("adds the active property a platform admin opened to view, marked as a support view", async () => {
    state.cookie = "h9";
    const client = fakeClient({
      userId: "admin-1",
      rows: [],
      platformAdmin: true,
      hotels: [{ id: "h9", name: "Harbour Inn", is_active: true }],
    });
    expect(await listAccessibleHotels(client)).toEqual([{ id: "h9", name: "Harbour Inn", supportView: true }]);
  });

  it("keeps an admin's own memberships as memberships, with the viewed property beside them", async () => {
    state.cookie = "h9";
    const client = fakeClient({
      userId: "admin-1",
      rows: [row("h1", "Alpha Lodge")],
      platformAdmin: true,
      hotels: [{ id: "h9", name: "Harbour Inn", is_active: true }],
    });
    expect(await listAccessibleHotels(client)).toEqual([
      { id: "h1", name: "Alpha Lodge" },
      { id: "h9", name: "Harbour Inn", supportView: true },
    ]);
  });

  it("never adds a property for someone without the platform role, whatever the cookie says", async () => {
    state.cookie = "h9";
    const client = fakeClient({
      userId: "user-1",
      rows: [row("h1", "Alpha Lodge")],
      platformAdmin: false,
      hotels: [{ id: "h9", name: "Harbour Inn", is_active: true }],
    });
    expect(await listAccessibleHotels(client)).toEqual([{ id: "h1", name: "Alpha Lodge" }]);
  });

  it("never adds a property that is not active, even for an admin", async () => {
    state.cookie = "h9";
    const client = fakeClient({
      userId: "admin-1",
      rows: [],
      platformAdmin: true,
      hotels: [{ id: "h9", name: "Closed Inn", is_active: false }],
    });
    expect(await listAccessibleHotels(client)).toEqual([]);
  });
});

describe("supportViewHotel", () => {
  it("answers the property for an admin and nothing for anyone else", async () => {
    const hotels = [{ id: "h9", name: "Harbour Inn", is_active: true }];
    expect(await supportViewHotel(fakeClient({ userId: "admin-1", platformAdmin: true, hotels }), "h9")).toEqual({
      id: "h9",
      name: "Harbour Inn",
      supportView: true,
    });
    expect(await supportViewHotel(fakeClient({ userId: "user-1", platformAdmin: false, hotels }), "h9")).toBeNull();
    expect(await supportViewHotel(fakeClient({ userId: "admin-1", platformAdmin: true, hotels }), "h8")).toBeNull();
  });
});

describe("resolveAccessibleHotelId", () => {
  it("prefers the cookie when it matches a membership", async () => {
    state.cookie = "h2";
    const client = fakeClient({
      userId: "user-1",
      rows: [row("h1", "Alpha Lodge"), row("h2", "Zeta Inn")],
    });
    expect(await resolveAccessibleHotelId(client)).toBe("h2");
  });

  it("ignores a cookie pointing outside the membership set", async () => {
    state.cookie = "h9";
    const client = fakeClient({ userId: "user-1", rows: [row("h1", "Alpha Lodge")] });
    expect(await resolveAccessibleHotelId(client)).toBe("h1");
  });

  it("honours the cookie for a platform admin viewing a property they do not belong to", async () => {
    state.cookie = "h9";
    const client = fakeClient({
      userId: "admin-1",
      rows: [row("h1", "Alpha Lodge")],
      platformAdmin: true,
      hotels: [{ id: "h9", name: "Harbour Inn", is_active: true }],
    });
    expect(await resolveAccessibleHotelId(client)).toBe("h9");
  });

  it("uses the env fallback for a membership-less user outside production", async () => {
    vi.stubEnv("MAYA_DEFAULT_HOTEL_ID", "env-hotel");
    const client = fakeClient({ userId: "user-1", rows: [] });
    expect(await resolveAccessibleHotelId(client)).toBe("env-hotel");
  });

  it("never hands the env hotel to a membership-less user in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAYA_DEFAULT_HOTEL_ID", "env-hotel");
    const client = fakeClient({ userId: "user-1", rows: [] });
    expect(await resolveAccessibleHotelId(client)).toBeNull();
  });

  it("never hands the env hotel to a signed-out request in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAYA_DEFAULT_HOTEL_ID", "env-hotel");
    const client = fakeClient({ userId: null });
    expect(await resolveAccessibleHotelId(client)).toBeNull();
  });

  it("still resolves a real membership in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAYA_DEFAULT_HOTEL_ID", "env-hotel");
    const client = fakeClient({ userId: "user-1", rows: [row("h1", "Alpha Lodge")] });
    expect(await resolveAccessibleHotelId(client)).toBe("h1");
  });
});
