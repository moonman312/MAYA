/**
 * The platform admin Live/Test switch. Its behaviour is unchanged; what it
 * adds is who flipped it, on the audit event the switch already writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({ isAdmin: true, db: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/require-platform-admin", () => ({
  requirePlatformAdmin: async () =>
    state.isAdmin
      ? { ok: true, user: { id: "admin-7" }, ssr: null, admin: (state.db as ReturnType<typeof fakeSupabase>).client }
      : { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) },
}));

const { PATCH } = await import("./route");

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/admin/hotels/hotel-1/simulation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ hotelId: "hotel-1" }) },
  );
}

function db() {
  return fakeSupabase(
    {
      hotel_settings: [{ hotel_id: "hotel-1", simulation_mode: true }],
      pms_connections: [{ id: "c1", hotel_id: "hotel-1", pms_type: "cloudbeds", base_rates_refreshed_at: "2026-09-17T10:00:00Z" }],
    },
    { rpc: () => null },
  );
}

beforeEach(() => {
  state.isAdmin = true;
  state.db = db();
});

describe("PATCH /api/admin/hotels/[hotelId]/simulation", () => {
  it("records which platform admin turned the hotel live, and back", async () => {
    const d = state.db as ReturnType<typeof db>;

    const live = await patch({ simulationMode: false });
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true, simulationMode: false });
    expect(d.tables.hotel_settings[0].simulation_mode).toBe(false);
    expect(d.tables.pms_connections[0].base_rates_refreshed_at).toBeNull();

    await patch({ simulationMode: true });

    const events = d.calls.filter((c) => c.table === "rpc:platform_log_event").map((c) => c.payload);
    expect(events).toEqual([
      {
        p_event_type: "hotel.simulation_mode_changed",
        p_entity_type: "hotel",
        p_entity_id: "hotel-1",
        p_hotel_id: "hotel-1",
        p_detail: { simulation_mode: false, actor_user_id: "admin-7" },
      },
      expect.objectContaining({ p_detail: { simulation_mode: true, actor_user_id: "admin-7" } }),
    ]);
  });

  it("still turns nobody but a platform admin away, and writes nothing", async () => {
    state.isAdmin = false;
    const res = await patch({ simulationMode: false });
    expect(res.status).toBe(403);
    const d = state.db as ReturnType<typeof db>;
    expect(d.tables.hotel_settings[0].simulation_mode).toBe(true);
    expect(d.calls).toEqual([]);
  });

  it("still wants a boolean", async () => {
    expect((await patch({ simulationMode: "live" })).status).toBe(400);
  });
});
