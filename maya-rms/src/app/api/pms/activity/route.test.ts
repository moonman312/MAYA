/**
 * The dashboard draws the reconnect banner from this route's connection. A
 * never-paid Marketplace property the retention sweep emptied has no
 * connection row at all, which used to mean no banner and an empty dashboard.
 * It now reads as disconnected, so the owner gets the ordinary prompt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeRow } from "@/lib/engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  user: null as unknown as ReturnType<typeof import("@/lib/engine/fake-supabase.test").fakeSupabase>,
  admin: null as unknown as ReturnType<typeof import("@/lib/engine/fake-supabase.test").fakeSupabase>,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => state.admin.client,
  isAdminConfigured: () => true,
}));
vi.mock("@/lib/require-supabase-hotel", () => ({
  requireSupabaseHotel: async () => ({ ok: true, supabase: state.user.client, hotelId: "hotel-1" }),
  hasHotelRank: async () => true,
}));

const { GET } = await import("./route");

function world(opts: { connections: FakeRow[]; claimed: boolean; purged: boolean }) {
  const hotels = [{ id: "hotel-1", name: "Sea View Inn", is_active: true, data_purged_at: opts.purged ? "2027-03-01T00:00:00.000Z" : null }];
  state.user = fakeSupabase({ pms_connections: opts.connections, pms_request_log: [] });
  state.admin = fakeSupabase({
    hotels,
    pms_connections: opts.connections,
    pms_marketplace_claims: opts.claimed
      ? [{ hotel_id: "hotel-1", pms_type: "cloudbeds", claimed_by: "user-1", claimed_at: "2026-09-01T00:00:00.000Z" }]
      : [],
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/pms/activity", () => {
  it("reads a purged Marketplace property as disconnected, so the reconnect banner shows", async () => {
    world({ connections: [], claimed: true, purged: true });
    const body = await (await GET()).json();
    expect(body.connection).toMatchObject({ pms_type: "cloudbeds", status: "disconnected" });
    expect(body.pms).toMatchObject({ authKind: "oauth2_authorization_code", displayName: "Cloudbeds", canManage: true });
    expect(body.historyRemoved).toBe(true);
  });

  it("leaves a hotel that never had a Marketplace claim with no connection", async () => {
    world({ connections: [], claimed: false, purged: false });
    const body = await (await GET()).json();
    expect(body.connection).toBeNull();
    expect(body.historyRemoved).toBe(false);
  });

  it("reports a real connection as it is", async () => {
    const conn = { hotel_id: "hotel-1", pms_type: "cloudbeds", status: "connected", last_sync_at: null, last_tested_at: null };
    world({ connections: [conn], claimed: true, purged: false });
    const body = await (await GET()).json();
    expect(body.connection).toMatchObject({ status: "connected" });
    expect(body.historyRemoved).toBe(false);
  });
});
