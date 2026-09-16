/**
 * Flow A's second half. The callback has already spent the grant and parked an
 * inert hotel; this is the step that gives it an owner. Until it runs the hotel
 * is is_active false with no membership, so the failure modes that matter are
 * "someone else's property gets attached to my account" and "the ticket works
 * twice".
 */
import { describe, expect, it, vi } from "vitest";
import { PRIVACY_VERSION, signupAcceptanceMetadata, TERMS_VERSION } from "@/lib/legal/versions";
import { redeemMarketplaceClaim, type ClaimEvidence } from "./marketplace-claim";

const state = vi.hoisted(() => ({
  claim: null as Record<string, unknown> | null,
  siblings: [] as Record<string, unknown>[],
  writes: [] as { table: string; payload: unknown }[],
  stripe: true,
  acceptances: [] as Record<string, unknown>[],
  acceptanceTable: true,
  rpcCalls: [] as string[],
  unpaidNext: null as string | null,
  queued: [] as string[],
}));

// Which property the claim queues is decided by the subscribe screen's own
// queue; here it only matters that the claim asks for it.
vi.mock("@/lib/billing/pending-hotel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/pending-hotel")>();
  return {
    ...actual,
    listUnpaidMarketplaceHotels: async (...args: Parameters<typeof actual.listUnpaidMarketplaceHotels>) =>
      state.unpaidNext ? [{ hotelId: state.unpaidNext }] : actual.listUnpaidMarketplaceHotels(...args),
  };
});
vi.mock("@/lib/pms/eager-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pms/eager-import")>();
  return {
    ...actual,
    queuePrePaymentImport: async (...args: Parameters<typeof actual.queuePrePaymentImport>) => {
      state.queued.push(args[1]);
      return actual.queuePrePaymentImport(...args);
    },
  };
});

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      // Only terms_acceptances is filtered: recordAcceptance looks for an
      // identical row before it writes one.
      const filters: [string, unknown][] = [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        is: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
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
          if (table === "terms_acceptances") state.acceptances.push(payload as Record<string, unknown>);
          return q;
        },
      };
      if (table === "terms_acceptances") {
        (q as { then: unknown }).then = (res: (v: unknown) => unknown) =>
          res(
            state.acceptanceTable
              ? {
                  error: null,
                  data: state.acceptances.filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v)),
                }
              : { data: null, error: { code: "42P01", message: 'relation "terms_acceptances" does not exist' } },
          );
        return q;
      }
      // Siblings for the claims table; a row back from the hotels compare-and-set
      // so activation (when it runs) believes it won the flip.
      (q as { then: unknown }).then = (res: (v: { error: null; data?: unknown }) => unknown) =>
        res({
          error: null,
          data: table === "pms_marketplace_claims" ? state.siblings : table === "hotels" ? [{ id: "hotel-1" }] : [],
        });
      return q;
    },
    rpc: async (name: string) => {
      state.rpcCalls.push(name);
      return { data: null, error: null };
    },
  }),
}));

const future = () => new Date(Date.now() + 3600_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

function setClaim(over: Record<string, unknown> = {}, siblings: Record<string, unknown>[] = []) {
  state.writes = [];
  state.stripe = true;
  state.siblings = siblings;
  state.acceptances = [
    { user_id: "user-1", terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, context: "signup", hotel_id: null },
  ];
  state.acceptanceTable = true;
  state.rpcCalls = [];
  state.unpaidNext = null;
  state.queued = [];
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

describe("the acceptance record a claim leaves", () => {
  const evidence: ClaimEvidence = {
    email: "owner@seaview.example",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    metadata: {},
  };
  const claimRows = () => state.writes.filter((w) => w.table === "terms_acceptances:insert").map((w) => w.payload);

  it("ties the owner's acceptance to the claimed property, with where it came from", async () => {
    setClaim();
    const res = await redeemMarketplaceClaim("tok", "user-1", evidence);
    expect(res).toMatchObject({ ok: true });
    expect(claimRows()).toEqual([
      {
        user_id: "user-1",
        email: "owner@seaview.example",
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        context: "claim",
        hotel_id: "hotel-1",
        ip: "203.0.113.7",
        user_agent: "Mozilla/5.0",
        source: "app",
      },
    ]);
  });

  it("writes one per property of a group grant", async () => {
    setClaim({ group_key: "cloudbeds:group:1,2" }, [{ token: "tok-b", hotel_id: "hotel-2", expires_at: future() }]);
    await redeemMarketplaceClaim("tok", "user-1", evidence);
    expect(claimRows().map((r) => (r as Record<string, unknown>).hotel_id)).toEqual(["hotel-1", "hotel-2"]);
  });

  it("does not invent an acceptance for someone who never ticked the box", async () => {
    setClaim();
    state.acceptances = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await redeemMarketplaceClaim("tok", "user-1", evidence);
    expect(res).toMatchObject({ ok: true });
    expect(claimRows()).toEqual([]);
    errors.mockRestore();
  });

  it("adopts a signup's tick the trigger missed, then records the claim", async () => {
    setClaim();
    state.acceptances = [];
    await redeemMarketplaceClaim("tok", "user-1", { ...evidence, metadata: signupAcceptanceMetadata("claim") });
    expect(state.rpcCalls).toContain("record_terms_acceptance_from_signup");
  });

  it("still claims, and logs, when the table is missing", async () => {
    setClaim();
    state.acceptanceTable = false;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await redeemMarketplaceClaim("tok", "user-1", evidence);
    expect(res).toMatchObject({ ok: true, hotelId: "hotel-1", alreadyClaimed: false });
    expect(claimRows()).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("terms_acceptances is missing"));
    errors.mockRestore();
  });

  it("still claims when the acceptance lookup throws", async () => {
    setClaim();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    state.acceptances = new Proxy(state.acceptances, {
      get(target, prop) {
        if (prop === "filter") throw new Error("socket hang up");
        return Reflect.get(target, prop);
      },
    });
    const res = await redeemMarketplaceClaim("tok", "user-1", evidence);
    expect(res).toMatchObject({ ok: true, hotelId: "hotel-1" });
    expect(claimRows()).toEqual([]);
    errors.mockRestore();
  });

  it("records the acceptance AND queues the import for the property shown next", async () => {
    setClaim();
    state.unpaidNext = "hotel-1";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await redeemMarketplaceClaim("tok", "user-1", evidence);
    expect(res).toMatchObject({ ok: true });
    expect(claimRows().map((r) => (r as Record<string, unknown>).hotel_id)).toEqual(["hotel-1"]);
    expect(state.queued).toEqual(["hotel-1"]);
    errors.mockRestore();
  });
});
