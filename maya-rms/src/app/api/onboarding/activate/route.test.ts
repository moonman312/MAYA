/**
 * Going live is the act Terms 3.3 treats as confirming the rules were
 * reviewed. These pin that the act is recorded with the Terms in force, and
 * that failing to record it never undoes or blocks a switch that happened.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal/versions";

const state = vi.hoisted(() => ({
  updatedRows: [{ hotel_id: "hotel-1" }] as Record<string, unknown>[],
  adminConfigured: true,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as { message: string } | null,
  connectionUpdates: [] as { patch: Record<string, unknown>; hotelId: unknown }[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      update: () => ({
        eq: () => ({ select: async () => ({ data: state.updatedRows, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => state.adminConfigured,
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      return { data: null, error: state.rpcError };
    },
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (col: string, hotelId: unknown) => {
          if (table === "pms_connections" && col === "hotel_id") state.connectionUpdates.push({ patch, hotelId });
          return { error: null };
        },
      }),
    }),
  }),
}));

const { POST } = await import("./route");

function goLive(body: unknown = { termsVersion: TERMS_VERSION }) {
  return POST(
    new Request("http://localhost/api/onboarding/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-real-ip": "203.0.113.9", "user-agent": "Test/1.0" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.updatedRows = [{ hotel_id: "hotel-1" }];
  state.adminConfigured = true;
  state.rpcCalls = [];
  state.rpcError = null;
  state.connectionUpdates = [];
});

describe("going live", () => {
  it("makes the next tick re-read the hotel's base rates before its first live push", async () => {
    const res = await goLive();
    expect(res.status).toBe(200);
    expect(state.connectionUpdates).toEqual([{ patch: { base_rates_refreshed_at: null }, hotelId: "hotel-1" }]);
  });

  it("records the Terms in force with the act", async () => {
    const res = await goLive();
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toEqual({
      name: "platform_log_event",
      args: {
        p_event_type: "hotel.went_live",
        p_entity_type: "hotel",
        p_entity_id: "hotel-1",
        p_hotel_id: "hotel-1",
        p_detail: {
          actor_user_id: "user-1",
          terms_version: TERMS_VERSION,
          privacy_version: PRIVACY_VERSION,
          shown_terms_version: TERMS_VERSION,
          ip: "203.0.113.9",
          user_agent: "Test/1.0",
        },
      },
    });
  });

  it("still records it for an older client that sends no body", async () => {
    const res = await POST(new Request("http://localhost/api/onboarding/activate", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(state.rpcCalls[0].args.p_detail).toMatchObject({ terms_version: TERMS_VERSION, shown_terms_version: null });
  });

  it("answers ok, and logs, when the record cannot be written", async () => {
    state.rpcError = { message: "permission denied" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await goLive();
    expect(res.status).toBe(200);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
    errors.mockRestore();
  });

  it("records nothing when the switch did not happen", async () => {
    state.updatedRows = [];
    const res = await goLive();
    expect(res.status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
  });
});
