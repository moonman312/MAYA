/**
 * GET /api/property/mode: the strip's answer for each person and each kind of
 * property. Go live goes by the person's own membership only: a General
 * Manager or Hotel Admin, never a platform admin looking in (God Mode or not)
 * or MAYA's developer and sales logins, never on Mews, never once live.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";

type Row = Record<string, unknown>;
const HOTEL = "hotel-1";
const state = vi.hoisted(() => ({ client: null as unknown, userId: "u-gm" as string | null }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => false, createAdminClient: () => null }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => HOTEL }));

const { GET } = await import("./route");

const MEMBERS: Row[] = [
  { hotel_id: HOTEL, user_id: "u-gm", role: "general_manager", status: "active" },
  { hotel_id: HOTEL, user_id: "u-admin", role: "hotel_admin", status: "active" },
  { hotel_id: HOTEL, user_id: "u-rm", role: "revenue_manager", status: "active" },
  { hotel_id: HOTEL, user_id: "u-viewer", role: "viewer", status: "active" },
  { hotel_id: HOTEL, user_id: "u-gone", role: "general_manager", status: "revoked" },
];

async function ask(userId: string | null, seed: Record<string, Row[]> = {}) {
  state.userId = userId;
  const f = fakeSupabase({
    hotel_memberships: MEMBERS,
    hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }],
    pms_connections: [{ hotel_id: HOTEL, pms_type: "cloudbeds", status: "connected" }],
    ...seed,
  });
  state.client = Object.assign(f.client, {
    auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }) },
  });
  const res = await GET();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/property/mode", () => {
  it("offers Go live to a General Manager or Hotel Admin of a simulating Cloudbeds property", async () => {
    for (const user of ["u-gm", "u-admin"]) {
      const { status, body } = await ask(user);
      expect(status).toBe(200);
      expect(body).toMatchObject({ hotelId: HOTEL, mode: "simulation", pmsType: "cloudbeds", sendsPrices: true, connected: true, canGoLive: true });
    }
  });

  it("offers it to nobody else: below General Manager, a revoked membership, or MAYA staff with none", async () => {
    // u-staff: a platform admin's support view, or a developer or sales login. No membership of their own.
    for (const user of ["u-rm", "u-viewer", "u-gone", "u-staff"]) {
      const { body } = await ask(user);
      expect(body).toMatchObject({ mode: "simulation", canGoLive: false });
    }
  });

  it("offers it on Think, not on Mews, and not once live", async () => {
    expect((await ask("u-gm", { pms_connections: [{ hotel_id: HOTEL, pms_type: "think", status: "connected" }] })).body.canGoLive).toBe(true);
    expect((await ask("u-gm", { pms_connections: [{ hotel_id: HOTEL, pms_type: "mews", status: "connected" }] })).body).toMatchObject({
      sendsPrices: false,
      canGoLive: false,
    });
    expect((await ask("u-gm", { hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }] })).body).toMatchObject({ mode: "live", canGoLive: false });
  });

  it("names the window the confirm promises", async () => {
    expect((await ask("u-gm")).body.windowDays).toEqual(expect.any(Number));
  });

  it("names the property it answered for, so the confirm and the go-live call are about that one", async () => {
    const { body } = await ask("u-gm", { hotels: [{ id: HOTEL, name: "Juniper Lodge" }] });
    expect(body).toMatchObject({ hotelId: HOTEL, propertyName: "Juniper Lodge" });
    expect((await ask("u-gm")).body.propertyName).toBeNull();
  });

  it("answers no one signed out", async () => {
    expect((await ask(null)).status).toBe(401);
  });
});
