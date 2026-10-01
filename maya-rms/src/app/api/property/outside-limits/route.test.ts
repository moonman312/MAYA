/**
 * GET /api/property/outside-limits: the go-live confirm's count of nights
 * whose own rate sits outside a floor or ceiling (audit A21). For the active
 * property only, and never an error the confirm has to show.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { fakeSupabase } from "../../../../lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  fake: null as unknown,
  signedIn: true,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/require-supabase-hotel", () => ({
  requireSupabaseHotel: async () =>
    state.signedIn
      ? { ok: true, supabase: (state.fake as ReturnType<typeof fakeSupabase>).client, hotelId: "hotel-1", userId: "user-1" }
      : { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => (state.fake as ReturnType<typeof fakeSupabase>).client,
}));

const { GET } = await import("./route");

const get = (query = "") => GET(new Request(`http://localhost/api/property/outside-limits${query}`));
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

beforeEach(() => {
  state.signedIn = true;
  state.fake = fakeSupabase({
    hotels: [{ id: "hotel-1", timezone: "UTC" }],
    hotel_pricing_state: [{ hotel_id: "hotel-1", pass_horizon_days: 30 }],
    room_types: [{ id: "rt-king", hotel_id: "hotel-1", is_active: true, floor_price: 150, ceiling_price: 400 }],
    pms_connections: [],
    base_rate_calendar: [
      { hotel_id: "hotel-1", stay_date: today, room_type_id: "rt-king", price: 120, pms_removed_at: null },
    ],
    manual_price: [],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/property/outside-limits", () => {
  it("counts the active property's nights, for its own id or none given", async () => {
    expect(await (await get("?hotelId=hotel-1")).json()).toEqual({ nights: 1 });
    expect(await (await get()).json()).toEqual({ nights: 1 });
  });

  it("gives no number for another property than the active one", async () => {
    expect(await (await get("?hotelId=hotel-2")).json()).toEqual({ nights: null });
  });

  it("answers no number, never an error, when the count can't be read", async () => {
    state.fake = fakeSupabase({}, { fault: (call) => (call.table === "room_types" ? { message: "statement timeout" } : null) });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nights: null });
  });

  it("is refused for someone signed out", async () => {
    state.signedIn = false;
    expect((await get()).status).toBe(401);
  });
});
