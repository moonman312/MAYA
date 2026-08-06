/**
 * The manual evaluation trigger. The run behind it is minutes of sequential
 * database work over a 365-day horizon, so the route holds two doors: a
 * per-hotel budget, and one run at a time — a second ask while one is going
 * gets a 409 instead of a second engine.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-1" as string | null,
  canManage: true,
  hotelId: "hotel-1" as string | null,
  limiter: { allowed: true, hits: 1, resets_at: "2026-07-31T01:00:00Z" },
}));
const evaluateHotel = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: state.userId ? { id: state.userId } : null },
      }),
    },
    rpc: async () => ({ data: state.canManage, error: null }),
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

const { POST } = await import("./route");

const RESULT = { run_id: "run-1", hotel_id: "hotel-1", prices_published: 3 };

beforeEach(() => {
  state.userId = "user-1";
  state.canManage = true;
  state.hotelId = "hotel-1";
  state.limiter = { allowed: true, hits: 1, resets_at: "2026-07-31T01:00:00Z" };
  evaluateHotel.mockReset();
  evaluateHotel.mockResolvedValue(RESULT);
});

describe("POST /api/evaluate", () => {
  it("401 when signed out, and no engine run", async () => {
    state.userId = null;
    expect((await POST()).status).toBe(401);
    expect(evaluateHotel).not.toHaveBeenCalled();
  });

  it("403 without manage rights — RLS would silently eat every write", async () => {
    state.canManage = false;
    expect((await POST()).status).toBe(403);
    expect(evaluateHotel).not.toHaveBeenCalled();
  });

  it("runs the engine and returns its result", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(RESULT);
    expect(evaluateHotel).toHaveBeenCalledTimes(1);
  });

  it("429 once the hotel's budget is spent, with a Retry-After", async () => {
    state.limiter = { allowed: false, hits: 7, resets_at: "2026-07-31T01:00:00Z" };
    const res = await POST();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(evaluateHotel).not.toHaveBeenCalled();
  });

  it("409 while a run is already going, then admits the next one", async () => {
    let finish!: (v: unknown) => void;
    evaluateHotel.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );

    const first = POST();
    await vi.waitFor(() => expect(evaluateHotel).toHaveBeenCalledTimes(1));

    const second = await POST();
    expect(second.status).toBe(409);
    expect(evaluateHotel).toHaveBeenCalledTimes(1);

    finish(RESULT);
    expect((await first).status).toBe(200);

    // The guard releases with the run — the next ask goes through.
    expect((await POST()).status).toBe(200);
  });

  it("releases the guard when the run throws", async () => {
    evaluateHotel.mockRejectedValueOnce(new Error("boom"));
    expect((await POST()).status).toBe(500);
    expect((await POST()).status).toBe(200);
  });
});
