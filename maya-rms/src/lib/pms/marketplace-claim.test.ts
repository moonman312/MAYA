/**
 * Flow A's second half. The callback has already spent the grant and parked an
 * inert hotel; this is the step that gives it an owner. Until it runs the hotel
 * is is_active false with no membership, so the failure modes that matter are
 * "someone else's property gets attached to my account" and "the ticket works
 * twice".
 */
import { describe, expect, it, vi } from "vitest";
import { redeemMarketplaceClaim } from "./marketplace-claim";

const state = vi.hoisted(() => ({ claim: null as Record<string, unknown> | null, writes: [] as { table: string; payload: unknown }[] }));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: table === "pms_marketplace_claims" ? state.claim : null }),
        single: async () => ({ data: { id: "job-1" }, error: null }),
        upsert: (payload: unknown) => {
          state.writes.push({ table, payload });
          return q;
        },
        update: (payload: unknown) => {
          state.writes.push({ table: `${table}:update`, payload });
          return q;
        },
        insert: (payload: unknown) => {
          state.writes.push({ table: `${table}:insert`, payload });
          return q;
        },
      };
      (q as { then: unknown }).then = (res: (v: { error: null }) => unknown) => res({ error: null });
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const future = () => new Date(Date.now() + 3600_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

function setClaim(over: Record<string, unknown> = {}) {
  state.writes = [];
  state.claim = {
    token: "tok",
    hotel_id: "hotel-1",
    pms_type: "cloudbeds",
    property_name: "Sea View Inn",
    expires_at: future(),
    claimed_by: null,
    claimed_at: null,
    ...over,
  };
}

describe("redeemMarketplaceClaim", () => {
  it("gives the property an owner, settings, and an import job", async () => {
    setClaim();
    const res = await redeemMarketplaceClaim("tok", "user-1");
    expect(res).toMatchObject({ ok: true, hotelId: "hotel-1", alreadyClaimed: false });

    const tables = state.writes.map((w) => w.table);
    expect(tables).toContain("hotel_memberships");
    expect(tables).toContain("hotel_settings");
    expect(tables).toContain("hotels:update");
    expect(tables).toContain("import_jobs:insert");

    const membership = state.writes.find((w) => w.table === "hotel_memberships")!.payload as Record<string, unknown>;
    expect(membership).toMatchObject({ user_id: "user-1", role: "hotel_admin", status: "active" });
  });

  it("starts the property in simulation mode — nothing reaches live rates unasked", async () => {
    setClaim();
    await redeemMarketplaceClaim("tok", "user-1");
    const settings = state.writes.find((w) => w.table === "hotel_settings")!.payload as Record<string, unknown>;
    expect(settings.simulation_mode).toBe(true);
  });

  it("refuses a ticket someone else already claimed", async () => {
    setClaim({ claimed_at: new Date().toISOString(), claimed_by: "other-user" });
    expect(await redeemMarketplaceClaim("tok", "user-1")).toMatchObject({ ok: false, reason: "taken" });
  });

  it("lets the SAME user re-claim, so a refresh is not an error", async () => {
    setClaim({ claimed_at: new Date().toISOString(), claimed_by: "user-1" });
    expect(await redeemMarketplaceClaim("tok", "user-1")).toMatchObject({ ok: true, alreadyClaimed: true });
  });

  it("refuses an expired ticket and says to reconnect from the Marketplace", async () => {
    setClaim({ expires_at: past() });
    const res = await redeemMarketplaceClaim("tok", "user-1");
    expect(res).toMatchObject({ ok: false, reason: "expired" });
    if (!res.ok) expect(res.message).toMatch(/Marketplace/i);
  });

  it("refuses an unknown token", async () => {
    state.writes = [];
    state.claim = null;
    expect(await redeemMarketplaceClaim("nope", "user-1")).toMatchObject({ ok: false, reason: "not_found" });
  });
});
