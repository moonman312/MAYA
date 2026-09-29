/**
 * The God Mode route: GET answers { admin: false } fast for everyone who is
 * not a platform admin (no auth round-trip, at most one RPC), and the full
 * state with the property in view for one; POST and DELETE hand the
 * database's own refusals back in plain words and never decide anything
 * themselves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type RpcAnswer = { data?: unknown; error?: { code?: string; message?: string } | null };

const state = vi.hoisted(() => ({
  session: true,
  userId: "admin-1" as string | null,
  rpc: {} as Record<string, RpcAnswer>,
  calls: [] as string[],
  hotelId: "h9" as string | null,
  hotels: [{ id: "h9", name: "Harbour Inn" }],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => state.hotelId }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: state.session ? { user: { id: state.userId } } : null } }),
      getUser: async () => {
        state.calls.push("getUser");
        return { data: { user: state.userId ? { id: state.userId } : null } };
      },
    },
    rpc: async (fn: string) => {
      state.calls.push(`rpc:${fn}`);
      const answer = state.rpc[fn] ?? { data: null, error: null };
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const api = {
        select: () => api,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return api;
        },
        maybeSingle: async () => ({
          data: table === "hotels" ? (state.hotels.find((h) => h.id === filters.id) ?? null) : null,
          error: null,
        }),
      };
      return api;
    },
  }),
}));

const { GET, POST, DELETE } = await import("./route");

const status = (over: Record<string, unknown>) => ({
  data: { admin: true, aal: "aal2", active: true, session_id: "s-1", started_at: "2026-09-29T10:00:00Z", expires_at: "2026-09-29T10:30:00Z", ...over },
});

beforeEach(() => {
  state.session = true;
  state.userId = "admin-1";
  state.rpc = {};
  state.calls = [];
  state.hotelId = "h9";
});

describe("GET /api/admin/god-mode", () => {
  it("answers { admin: false } for a signed-out visitor without touching the database", async () => {
    state.session = false;
    const res = await GET();
    expect(await res.json()).toEqual({ admin: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toEqual([]);
  });

  it("answers { admin: false } for a customer after one RPC and no auth round-trip", async () => {
    state.rpc.god_mode_status = { data: { admin: false, aal: "aal1", active: false } };
    const res = await GET();
    expect(await res.json()).toEqual({ admin: false });
    expect(state.calls).toEqual(["rpc:god_mode_status"]);
  });

  it("answers the window and the property in view for an admin in God Mode", async () => {
    state.rpc.god_mode_status = status({});
    const res = await GET();
    expect(await res.json()).toEqual({
      admin: true,
      aal: "aal2",
      active: true,
      sessionId: "s-1",
      startedAt: "2026-09-29T10:00:00Z",
      expiresAt: "2026-09-29T10:30:00Z",
      hotel: { id: "h9", name: "Harbour Inn" },
    });
  });

  it("answers off for an admin with no window, and reads as off when the database has no God Mode yet", async () => {
    state.rpc.god_mode_status = status({ active: false, session_id: null, started_at: null, expires_at: null });
    expect(await (await GET()).json()).toMatchObject({ admin: true, active: false, sessionId: null, hotel: null });
    state.rpc.god_mode_status = { error: { code: "PGRST202", message: "Could not find the function" } };
    expect(await (await GET()).json()).toEqual({ admin: false });
  });
});

describe("POST /api/admin/god-mode", () => {
  it("opens a window through the database and answers when it ends", async () => {
    state.rpc.god_mode_start = { data: { id: "s-2", user_id: "admin-1", started_at: "2026-09-29T11:00:00Z", expires_at: "2026-09-29T11:30:00Z" } };
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, active: true, sessionId: "s-2", startedAt: "2026-09-29T11:00:00Z", expiresAt: "2026-09-29T11:30:00Z" });
    expect(state.calls).toEqual(["getUser", "rpc:god_mode_start"]);
  });

  it("hands back the database's plain refusal: no code yet, or not staff", async () => {
    state.rpc.god_mode_start = { error: { code: "42501", message: "Enter the code from your authenticator app first." } };
    let res = await POST();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Enter the code from your authenticator app first." });

    state.rpc.god_mode_start = { error: { code: "42501", message: "Only MAYA staff can turn on God Mode." } };
    res = await POST();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only MAYA staff can turn on God Mode." });
  });

  it("says so when the database has no God Mode yet, and keeps other failures generic", async () => {
    state.rpc.god_mode_start = { error: { code: "PGRST202", message: "Could not find the function public.god_mode_start" } };
    let res = await POST();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "God Mode isn't set up on this database yet." });

    state.rpc.god_mode_start = { error: { code: "XX000", message: "internal detail" } };
    res = await POST();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not turn on God Mode. Try again in a moment." });
  });

  it("wants a signed-in caller", async () => {
    state.userId = null;
    expect((await POST()).status).toBe(401);
    expect(state.calls).toEqual(["getUser"]);
  });
});

describe("DELETE /api/admin/god-mode", () => {
  it("closes the window through the database", async () => {
    state.rpc.god_mode_end = { data: null };
    const res = await DELETE();
    expect(await res.json()).toEqual({ ok: true, active: false });
    expect(state.calls).toEqual(["getUser", "rpc:god_mode_end"]);
  });

  it("hands back a refusal and wants a signed-in caller", async () => {
    state.rpc.god_mode_end = { error: { code: "42501", message: "Only MAYA staff can turn off God Mode." } };
    const res = await DELETE();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only MAYA staff can turn off God Mode." });
    state.userId = null;
    expect((await DELETE()).status).toBe(401);
  });
});
