/**
 * POST /api/room-types/limits: the review's one-click remove of a floor or a
 * ceiling (Jake, 2026-09-30, audit A21). It puts the limit back to no limit,
 * under the person's own session, and asks the sync to price again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTouchesColumn, fakeSupabase, missingColumn } from "../../../../lib/engine/fake-supabase.test";

const USER = "11111111-1111-4111-8111-111111111111";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const KING = "33333333-3333-4333-8333-333333333333";
const OTHER_HOTEL_ROOM = "44444444-4444-4444-8444-444444444444";

const state = vi.hoisted(() => ({
  userId: "11111111-1111-4111-8111-111111111111" as string | null,
  canManage: true,
  fake: null as unknown,
}));
const nudgeHotelSync = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => {
    const fake = state.fake as ReturnType<typeof fakeSupabase>;
    return {
      auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }) },
      rpc: async (name: string) => ({ data: name === "can_manage_hotel" ? state.canManage : null, error: null }),
      from: (t: string) => fake.client.from(t),
    };
  },
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => (state.fake as ReturnType<typeof fakeSupabase>).client,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/pms/sync-nudge", () => ({ nudgeHotelSync }));

const { POST } = await import("./route");

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/room-types/limits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
const king = () =>
  (state.fake as ReturnType<typeof fakeSupabase>).tables.room_types.find((r) => r.id === KING)!;

beforeEach(() => {
  state.userId = USER;
  state.canManage = true;
  state.fake = fakeSupabase({
    room_types: [
      { id: KING, hotel_id: HOTEL, name: "Harbour King", floor_price: 150, ceiling_price: 780, is_active: true },
      { id: OTHER_HOTEL_ROOM, hotel_id: "other", name: "Juniper Queen", floor_price: 90, ceiling_price: 300, is_active: true },
    ],
  });
  nudgeHotelSync.mockReset();
  nudgeHotelSync.mockResolvedValue("nudged");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/room-types/limits", () => {
  it("puts a floor back to no limit and leaves the ceiling as it was", async () => {
    const res = await post({ hotelId: HOTEL, roomTypeId: KING, limit: "floor" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, floor_price: 1, ceiling_price: 780 });
    expect(king()).toMatchObject({ floor_price: 1, ceiling_price: 780 });
    expect(nudgeHotelSync).toHaveBeenCalledWith(expect.anything(), HOTEL);
  });

  it("puts a ceiling back to no limit", async () => {
    const res = await post({ hotelId: HOTEL, roomTypeId: KING, limit: "ceiling" });
    expect(res.status).toBe(200);
    expect(king()).toMatchObject({ floor_price: 150, ceiling_price: 99999.99 });
  });

  it("stamps the remove, so an import never fills that limit again", async () => {
    await post({ hotelId: HOTEL, roomTypeId: KING, limit: "floor" });
    expect(king().floor_cleared_at).toEqual(expect.any(String));
    expect(king().ceiling_cleared_at).toBeUndefined();
    await post({ hotelId: HOTEL, roomTypeId: KING, limit: "ceiling" });
    expect(king().ceiling_cleared_at).toEqual(expect.any(String));
  });

  it("still removes the limit before the stamp's migration, saying so", async () => {
    const seed = (state.fake as ReturnType<typeof fakeSupabase>).tables;
    state.fake = fakeSupabase(
      { room_types: seed.room_types },
      { fault: (call) => (callTouchesColumn(call, "floor_cleared_at") ? { ...missingColumn("room_types", "floor_cleared_at"), code: "PGRST204" } : null) },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ hotelId: HOTEL, roomTypeId: KING, limit: "floor" });
    expect(res.status).toBe(200);
    expect(king()).toMatchObject({ floor_price: 1, ceiling_price: 780 });
    expect(king().floor_cleared_at).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("99_supabase_migration_room_type_limit_removals_v1.sql"));
    warn.mockRestore();
  });

  it("refuses anyone below a Revenue Manager, changing nothing", async () => {
    state.canManage = false;
    const res = await post({ hotelId: HOTEL, roomTypeId: KING, limit: "floor" });
    expect(res.status).toBe(403);
    expect(king()).toMatchObject({ floor_price: 150 });
  });

  it("refuses a signed-out caller, a bad body and a room type of another property", async () => {
    state.userId = null;
    expect((await post({ hotelId: HOTEL, roomTypeId: KING, limit: "floor" })).status).toBe(401);
    state.userId = USER;
    expect((await post({ hotelId: HOTEL, roomTypeId: KING, limit: "both" })).status).toBe(400);
    expect((await post({ hotelId: "nope", roomTypeId: KING, limit: "floor" })).status).toBe(400);
    const elsewhere = await post({ hotelId: HOTEL, roomTypeId: OTHER_HOTEL_ROOM, limit: "floor" });
    expect(elsewhere.status).toBe(400);
    expect((state.fake as ReturnType<typeof fakeSupabase>).tables.room_types[1]).toMatchObject({ floor_price: 90 });
  });
});
