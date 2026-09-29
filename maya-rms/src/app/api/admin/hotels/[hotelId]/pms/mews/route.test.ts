/**
 * The Command Center's Mews keys: setting or removing a property's system
 * connection needs God Mode, and each is recorded as support's change (that
 * keys were set or removed, never the keys).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { fakeSupabase } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({ godMode: true, db: null as unknown, saved: [] as unknown[], deleted: [] as unknown[] }));

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
vi.mock("@/lib/admin/pms", () => ({
  saveMewsCredentials: async (_admin: unknown, input: unknown, opts: unknown) => {
    state.saved.push({ input, opts });
  },
  deleteMewsCredentials: async (_admin: unknown, hotelId: string, opts: unknown) => {
    state.deleted.push({ hotelId, opts });
  },
}));

const { PUT, DELETE } = await import("./route");
const params = { params: Promise.resolve({ hotelId: "hotel-1" }) };

beforeEach(() => {
  state.godMode = true;
  state.db = fakeSupabase();
  state.saved = [];
  state.deleted = [];
});

describe("/api/admin/hotels/[hotelId]/pms/mews", () => {
  it("saves the keys in God Mode, passing the window along, and records it without the keys", async () => {
    const res = await PUT(
      new Request("http://localhost/x", {
        method: "PUT",
        body: JSON.stringify({ env: "demo", clientToken: "client-SECRET-1", accessToken: "access-SECRET-2" }),
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(state.saved).toEqual([
      {
        input: { hotelId: "hotel-1", env: "demo", clientToken: "client-SECRET-1", accessToken: "access-SECRET-2", enterpriseId: undefined },
        opts: { markConnected: true, godModeSessionId: "gm-1" },
      },
    ]);
    const d = state.db as ReturnType<typeof fakeSupabase>;
    expect(d.tables.support_changes).toHaveLength(1);
    const row = d.tables.support_changes[0];
    expect(row).toMatchObject({ session_id: "gm-1", user_id: "admin-7", hotel_id: "hotel-1", table_name: "pms_connections", op: "update", summary: "Set the Mews connection keys (demo)." });
    expect(JSON.stringify(row)).not.toContain("SECRET");
  });

  it("removes the keys in God Mode and records it", async () => {
    const res = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), params);
    expect(res.status).toBe(200);
    expect(state.deleted).toEqual([{ hotelId: "hotel-1", opts: { godModeSessionId: "gm-1" } }]);
    const d = state.db as ReturnType<typeof fakeSupabase>;
    expect(d.tables.support_changes[0]).toMatchObject({ table_name: "pms_connections", summary: "Removed the Mews connection keys and disconnected the property system." });
  });

  it("refuses both outside God Mode and touches nothing", async () => {
    state.godMode = false;
    const put = await PUT(
      new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ env: "demo", clientToken: "ct", accessToken: "at" }) }),
      params,
    );
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: "God Mode is off. Turn it on from the Command Center to change this property." });
    const del = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), params);
    expect(del.status).toBe(403);
    expect(state.saved).toEqual([]);
    expect(state.deleted).toEqual([]);
    expect((state.db as ReturnType<typeof fakeSupabase>).calls).toEqual([]);
  });
});
