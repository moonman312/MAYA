/**
 * Flow A's second half. The callback has already spent the grant and parked an
 * inert hotel; this is the step that gives it an owner. Until it runs the hotel
 * is is_active false with no membership, so the failure modes that matter are
 * "someone else's property gets attached to my account" and "the ticket works
 * twice".
 */
import { describe, expect, it, vi } from "vitest";
import { redeemMarketplaceClaim } from "./marketplace-claim";

const state = vi.hoisted(() => ({
  claim: null as Record<string, unknown> | null,
  siblings: [] as Record<string, unknown>[],
  writes: [] as { table: string; payload: unknown }[],
  stripe: true,
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: table === "pms_marketplace_claims" ? state.claim : null }),
        single: async () => ({ data: { id: "job-1" }, error: null }),
        neq: () => q,
        in: () => q,
        not: () => q,
        limit: () => q,
        order: () => q,
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
      // Siblings for the claims table; a row back from the hotels compare-and-set
      // so activation (when it runs) believes it won the flip.
      (q as { then: unknown }).then = (res: (v: { error: null; data?: unknown }) => unknown) =>
        res({
          error: null,
          data: table === "pms_marketplace_claims" ? state.siblings : table === "hotels" ? [{ id: "hotel-1" }] : [],
        });
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const future = () => new Date(Date.now() + 3600_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

function setClaim(over: Record<string, unknown> = {}, siblings: Record<string, unknown>[] = []) {
  state.writes = [];
  state.stripe = true;
  state.siblings = siblings;
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
  it("gives the property an owner and settings, and leaves it parked until it is paid for", async () => {
    setClaim();
    const res = await redeemMarketplaceClaim("tok", "user-1");
    expect(res).toMatchObject({ ok: true, hotelId: "hotel-1", alreadyClaimed: false, hotelIds: ["hotel-1"] });

    const tables = state.writes.map((w) => w.table);
    expect(tables).toContain("hotel_memberships");
    expect(tables).toContain("hotel_settings");
    // Not live: that waits for the subscription to land (marketplace-activate.ts).
    // Which property's import the claim queues is eager-import.test.ts.
    expect(tables).not.toContain("hotels:update");
    expect(tables).not.toContain("pms_connections:update");

    const membership = (state.writes.find((w) => w.table === "hotel_memberships")!.payload as Record<string, unknown>[])[0];
    expect(membership).toMatchObject({ hotel_id: "hotel-1", user_id: "user-1", role: "hotel_admin", status: "active" });
  });

  it("goes live at once on an install with no Stripe keys — there is no payment to wait for", async () => {
    setClaim();
    state.stripe = false;
    const res = await redeemMarketplaceClaim("tok", "user-1");
    expect(res).toMatchObject({ ok: true });

    const tables = state.writes.map((w) => w.table);
    expect(tables).toContain("hotels:update");
    expect(tables).toContain("import_jobs:insert");
    expect(tables).toContain("onboarding_states");
    const job = state.writes.find((w) => w.table === "import_jobs:insert")!.payload as Record<string, unknown>;
    expect(job).toMatchObject({ hotel_id: "hotel-1", pms_type: "cloudbeds", status: "queued", requested_by: "user-1" });
  });

  it("starts the property in simulation mode — nothing reaches live rates unasked", async () => {
    setClaim();
    await redeemMarketplaceClaim("tok", "user-1");
    const settings = (state.writes.find((w) => w.table === "hotel_settings")!.payload as Record<string, unknown>[])[0];
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

  it("claims EVERY property of a group grant, not just the one in the link", async () => {
    // The owner clicked one link. Handing back the first hotel and leaving the
    // siblings parked is the same silent drop this whole path exists to fix.
    setClaim({ group_key: "cloudbeds:group:1,2,3" }, [
      { token: "tok-b", hotel_id: "hotel-2", expires_at: future() },
      { token: "tok-c", hotel_id: "hotel-3", expires_at: future() },
    ]);
    const res = await redeemMarketplaceClaim("tok", "user-1");

    expect(res).toMatchObject({ ok: true, hotelIds: ["hotel-1", "hotel-2", "hotel-3"] });
    const memberships = state.writes.find((w) => w.table === "hotel_memberships")!.payload as Record<string, unknown>[];
    expect(memberships.map((m) => m.hotel_id)).toEqual(["hotel-1", "hotel-2", "hotel-3"]);
    // All three stay parked: each needs its own subscription to go live.
    expect(state.writes.map((w) => w.table)).not.toContain("hotels:update");
  });

  it("skips a sibling whose own window has lapsed", async () => {
    setClaim({ group_key: "cloudbeds:group:1,2" }, [
      { token: "tok-b", hotel_id: "hotel-2", expires_at: past() },
    ]);
    const res = await redeemMarketplaceClaim("tok", "user-1");
    expect(res).toMatchObject({ ok: true, hotelIds: ["hotel-1"] });
  });

  it("a single-property claim touches exactly one hotel", async () => {
    setClaim({ group_key: null }, [{ token: "other", hotel_id: "unrelated", expires_at: future() }]);
    const res = await redeemMarketplaceClaim("tok", "user-1");
    expect(res).toMatchObject({ ok: true, hotelIds: ["hotel-1"] });
  });
});
