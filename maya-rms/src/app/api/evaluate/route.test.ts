/**
 * The manual "price everything again" trigger. It asks the scheduled sync for
 * a new daily pass and nudges it; it never runs the engine itself. Two doors
 * stay: manage rights, and a per-hotel budget.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-1" as string | null,
  canManage: true,
  hotelId: "hotel-1" as string | null,
  limiter: { allowed: true, hits: 1, resets_at: "2026-07-31T01:00:00Z" },
  requestError: null as { code?: string; message: string } | null,
  rpcCalls: [] as { fn: string; args: unknown }[],
}));
const evaluateHotel = vi.hoisted(() => vi.fn());
const nudgeHotelSync = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: state.userId ? { id: state.userId } : null },
      }),
    },
    rpc: async (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      if (fn === "request_full_reprice") return { data: null, error: state.requestError };
      return { data: state.canManage, error: null };
    },
  }),
}));
vi.mock("@/lib/hotel-context", () => ({
  resolveAccessibleHotelId: async () => state.hotelId,
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({
    rpc: () => ({ maybeSingle: async () => ({ data: state.limiter, error: null }) }),
  }),
}));
vi.mock("@/lib/engine", () => ({ evaluateHotel }));
vi.mock("@/lib/pms/sync-nudge", () => ({ nudgeHotelSync }));

const { POST } = await import("./route");

beforeEach(() => {
  state.userId = "user-1";
  state.canManage = true;
  state.hotelId = "hotel-1";
  state.limiter = { allowed: true, hits: 1, resets_at: "2026-07-31T01:00:00Z" };
  state.requestError = null;
  state.rpcCalls = [];
  evaluateHotel.mockReset();
  nudgeHotelSync.mockReset();
  nudgeHotelSync.mockResolvedValue("nudged");
});

const requests = () => state.rpcCalls.filter((c) => c.fn === "request_full_reprice");

describe("POST /api/evaluate", () => {
  it("401 when signed out, and nothing asked for", async () => {
    state.userId = null;
    expect((await POST()).status).toBe(401);
    expect(requests()).toEqual([]);
    expect(nudgeHotelSync).not.toHaveBeenCalled();
  });

  it("400 in plain words for someone with no property, and nothing asked for", async () => {
    state.hotelId = null;
    const res = await POST();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "You don't have access to this property." });
    expect(requests()).toEqual([]);
  });

  it("403 without manage rights", async () => {
    state.canManage = false;
    expect((await POST()).status).toBe(403);
    expect(requests()).toEqual([]);
  });

  it("asks for a new daily pass and nudges the sync, never running the engine itself", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hotel_id: "hotel-1", requested: true, pushed: "nudged" });
    expect(requests()).toEqual([{ fn: "request_full_reprice", args: { p_hotel_id: "hotel-1" } }]);
    expect(nudgeHotelSync).toHaveBeenCalledWith(expect.anything(), "hotel-1");
    expect(evaluateHotel).not.toHaveBeenCalled();
  });

  it("before the cadence migration only nudges: every tick prices the whole window then", async () => {
    state.requestError = { code: "PGRST202", message: "Could not find the function public.request_full_reprice" };
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requested: false, pushed: "nudged" });
  });

  it("500 when the ask itself fails", async () => {
    state.requestError = { code: "42501", message: "Not authorized" };
    expect((await POST()).status).toBe(500);
    expect(nudgeHotelSync).not.toHaveBeenCalled();
  });

  it("429 once the hotel's budget is spent, with a Retry-After", async () => {
    state.limiter = { allowed: false, hits: 7, resets_at: "2026-07-31T01:00:00Z" };
    const res = await POST();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(requests()).toEqual([]);
  });
});
