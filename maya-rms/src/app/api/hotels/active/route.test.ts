/**
 * POST /api/hotels/active: a member may make any of their own properties the
 * active one; a platform admin may also open any active property to view it;
 * nobody else gets a property they do not belong to, whatever id they send.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-1" as string | null,
  hotels: [] as { id: string; name: string }[],
  supportView: null as { id: string; name: string; supportView: true } | null,
  supportAsked: [] as string[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }) },
  }),
}));
vi.mock("@/lib/hotel-context", () => ({
  MAYA_ACTIVE_HOTEL_COOKIE: "maya_active_hotel",
  activeHotelCookieOptions: () => ({ path: "/" }),
  listAccessibleHotels: async () => state.hotels,
  supportViewHotel: async (_client: unknown, hotelId: string) => {
    state.supportAsked.push(hotelId);
    return state.supportView && state.supportView.id === hotelId ? state.supportView : null;
  },
}));

const { POST } = await import("./route");

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/hotels/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.userId = "user-1";
  state.hotels = [{ id: "h1", name: "Alpha Lodge" }];
  state.supportView = null;
  state.supportAsked = [];
});

describe("POST /api/hotels/active", () => {
  it("sets the cookie for one of the caller's own properties without asking about support", async () => {
    const res = await post({ hotelId: "h1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, activeHotelId: "h1" });
    expect(res.headers.get("set-cookie")).toContain("maya_active_hotel=h1");
    expect(state.supportAsked).toEqual([]);
  });

  it("lets a platform admin open any active property to view it", async () => {
    state.supportView = { id: "h9", name: "Harbour Inn", supportView: true };
    const res = await post({ hotelId: "h9" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("maya_active_hotel=h9");
    expect(state.supportAsked).toEqual(["h9"]);
  });

  it("refuses a property the caller does not belong to and may not view", async () => {
    const res = await post({ hotelId: "h9" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Hotel not accessible." });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still wants a signed-in caller and a hotel id", async () => {
    expect((await post({})).status).toBe(400);
    state.userId = null;
    expect((await post({ hotelId: "h1" })).status).toBe(401);
  });
});
