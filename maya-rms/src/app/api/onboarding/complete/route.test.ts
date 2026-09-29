/**
 * Finish on the review. Row security turns a lower role's write into an
 * update of no rows with no error, so this used to answer ok while nothing
 * was saved. It now checks the role first and reads the write back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  canManage: true as boolean,
  updatedRows: [{ hotel_id: "hotel-1" }] as Record<string, unknown>[],
  updateError: null as { message: string } | null,
  updates: [] as Record<string, unknown>[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc: async (name: string) => ({ data: name === "can_manage_hotel" ? state.canManage : null, error: null }),
    from: (table: string) => {
      if (table === "room_types") {
        return {
          select: () => ({
            eq: () => ({ eq: async () => ({ data: [{ total_rooms: 12 }, { total_rooms: 8 }], error: null }) }),
          }),
        };
      }
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            select: async () => {
              state.updates.push(patch);
              return { data: state.updateError ? null : state.updatedRows, error: state.updateError };
            },
          }),
        }),
      };
    },
  }),
}));

const { POST } = await import("./route");

beforeEach(() => {
  state.canManage = true;
  state.updatedRows = [{ hotel_id: "hotel-1" }];
  state.updateError = null;
  state.updates = [];
});

describe("finishing the review", () => {
  it("marks it done and says so", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, totalRooms: 20 });
    expect(state.updates[0]).toMatchObject({ payment_tier_rooms: 20 });
    expect(typeof state.updates[0].review_completed_at).toBe("string");
  });

  it("tells someone below Revenue Manager, and writes nothing", async () => {
    state.canManage = false;
    const res = await POST();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only a Revenue Manager or above can finish the review.");
    expect(state.updates).toHaveLength(0);
  });

  it("does not answer ok when the write reached no row", async () => {
    state.updatedRows = [];
    const res = await POST();
    expect(res.status).toBe(409);
    expect((await res.json()).ok).toBeUndefined();
  });

  it("passes a failed write on", async () => {
    state.updateError = { message: "connection reset" };
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("connection reset");
  });
});
