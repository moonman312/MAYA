/**
 * Marking a property as test data changes the hotel's row, so it needs God
 * Mode: refused without a window and nothing written; with one, the flag
 * lands and a support_changes row says so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({ godMode: true, db: null as unknown }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/require-platform-admin", () => ({
  requirePlatformAdmin: async () => ({
    ok: true,
    user: { id: "admin-7" },
    ssr: { tag: "ssr" },
    admin: (state.db as ReturnType<typeof fakeSupabase>).client,
  }),
}));
vi.mock("@/lib/admin/god-mode", async () => {
  const real = await vi.importActual<typeof import("@/lib/admin/god-mode")>("@/lib/admin/god-mode");
  return {
    ...real,
    requireGodMode: async () =>
      state.godMode
        ? { ok: true, session: { id: "gm-1", startedAt: null, expiresAt: null } }
        : { ok: false, response: NextResponse.json({ error: real.GOD_MODE_OFF }, { status: 403 }) },
  };
});

const { PATCH } = await import("./route");

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/admin/hotels/hotel-1/test-flag", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ hotelId: "hotel-1" }) },
  );
}

beforeEach(() => {
  state.godMode = true;
  state.db = fakeSupabase({
    hotels: [{ id: "hotel-1", is_test: false }],
    hotel_metrics_daily: [{ hotel_id: "hotel-1", is_test: false }],
  });
});

describe("PATCH /api/admin/hotels/[hotelId]/test-flag", () => {
  it("flags the property in God Mode and records the change as support's", async () => {
    const res = await patch({ isTest: true });
    expect(res.status).toBe(200);
    const d = state.db as ReturnType<typeof fakeSupabase>;
    expect(d.tables.hotels[0].is_test).toBe(true);
    expect(d.tables.hotel_metrics_daily[0].is_test).toBe(true);
    expect(d.tables.support_changes).toEqual([
      expect.objectContaining({
        session_id: "gm-1",
        user_id: "admin-7",
        hotel_id: "hotel-1",
        table_name: "hotels",
        row_id: "hotel-1",
        op: "update",
        summary: "Marked the property as a test property.",
      }),
    ]);
  });

  it("refuses outside God Mode and writes nothing", async () => {
    state.godMode = false;
    const res = await patch({ isTest: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "God Mode is off. Turn it on from the Command Center to change this property." });
    const d = state.db as ReturnType<typeof fakeSupabase>;
    expect(d.tables.hotels[0].is_test).toBe(false);
    expect(d.calls).toEqual([]);
  });
});
