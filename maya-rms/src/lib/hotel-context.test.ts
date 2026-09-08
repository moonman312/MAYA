/**
 * Hotel scope resolution: listAccessibleHotels / resolveAccessibleHotelId.
 *
 * The part worth pinning is the MAYA_DEFAULT_HOTEL_ID fallback: it exists for
 * membership-less dev setups, and in production it must stay dead — a
 * signed-in user with no memberships gets null, not the env hotel.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type MembershipRow = {
  hotel_id: string;
  hotels: { id: string; name: string };
};

function fakeClient(opts: {
  userId?: string | null;
  rows?: MembershipRow[];
  queryError?: string;
}) {
  const query = {
    select: () => query,
    eq: () => query,
    then(
      resolve: (v: { data: MembershipRow[] | null; error: { message: string } | null }) => void,
    ) {
      if (opts.queryError) {
        return Promise.resolve({ data: null, error: { message: opts.queryError } }).then(resolve);
      }
      return Promise.resolve({ data: opts.rows ?? [], error: null }).then(resolve);
    },
  };

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: opts.userId ? { user: { id: opts.userId } } : null },
      }),
    },
    from: () => query,
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

const { listAccessibleHotels, resolveAccessibleHotelId } = await import("./hotel-context");

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
