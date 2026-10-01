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
  connections: [{ pms_type: "cloudbeds", status: "connected" }] as Record<string, unknown>[],
  updates: 0,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/hotel-context", () => ({ resolveAccessibleHotelId: async () => "hotel-1" }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      update: () => {
        state.updates += 1;
        return { eq: () => ({ select: async () => ({ data: state.updatedRows, error: null }) }) };
      },
      select: () => ({ eq: async () => ({ data: state.connections, error: null }) }),
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
  state.connections = [{ pms_type: "cloudbeds", status: "connected" }];
  state.updates = 0;
});

describe("what going live refuses", () => {
  it("refuses when the page shows another property than the active one, and changes nothing", async () => {
    const res = await goLive({ termsVersion: TERMS_VERSION, hotelId: "hotel-2" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("This page is for another property. Reload and try again.");
    expect(state.updates).toBe(0);
    expect(state.rpcCalls).toHaveLength(0);
    // The property the page shows is the active one: it goes live.
    expect((await goLive({ termsVersion: TERMS_VERSION, hotelId: "hotel-1" })).status).toBe(200);
    expect(state.updates).toBe(1);
  });

  it("refuses a property on a system MAYA doesn't send prices to, as the strip and review card say", async () => {
    state.connections = [{ pms_type: "mews", status: "connected" }];
    const res = await goLive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("MAYA doesn't send prices to Mews yet, so there is nothing to switch on.");
    expect(state.updates).toBe(0);
    // No connection yet: still allowed, the confirm said nothing is sent until one is.
    state.connections = [];
    expect((await goLive()).status).toBe(200);
  });
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
