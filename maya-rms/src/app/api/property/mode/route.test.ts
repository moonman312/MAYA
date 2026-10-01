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
const state = vi.hoisted(() => ({ client: null as unknown, userId: "u-gm" as string | null, admin: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => state.admin != null, createAdminClient: () => state.admin }));
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

  it("says whether sending to that system is on, from what its sync last reported (audit A25)", async () => {
    const think = { pms_connections: [{ hotel_id: HOTEL, pms_type: "think", status: "connected" }] };
    // Nothing reported: ThinkReservations' switch starts off, Cloudbeds' falls back to the switch production sends with.
    expect((await ask("u-gm", think)).body).toMatchObject({ sendsPrices: true, sendingOn: false, canGoLive: true });
    expect((await ask("u-gm")).body).toMatchObject({ sendingOn: true });

    const report = (fn: string, detail: Row, created_at: string) => ({ event_type: "alert.channel", entity_id: fn, detail, created_at });
    state.admin = fakeSupabase({
      platform_audit_events: [
        report("think-scheduled-sync", { state: "ready", sending: true, sending_setting: "MAYA_PUSH_RATES_THINK" }, "2026-10-01T10:00:00Z"),
        // A test alert's report, newer, says nothing about sending.
        report("think-scheduled-sync", { state: "ready" }, "2026-10-01T11:00:00Z"),
        report("cloudbeds-scheduled-sync", { state: "ready", sending: false, sending_setting: "MAYA_PUSH_RATES_CLOUDBEDS" }, "2026-10-01T10:00:00Z"),
      ],
    }).client;
    try {
      expect((await ask("u-gm", think)).body).toMatchObject({ sendingOn: true });
      expect((await ask("u-gm")).body).toMatchObject({ sendingOn: false, canGoLive: true });
    } finally {
      state.admin = null;
    }
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
