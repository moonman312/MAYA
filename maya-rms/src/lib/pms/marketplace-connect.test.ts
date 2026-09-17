/**
 * Flow A's callback when the property already has an owner — the reconnect
 * branch. Owning a property is not paying for it: an owner who claimed and
 * bounced off the card form still has a membership, and the scheduler only
 * leaves a 'pending' connection alone. So what matters here is which status
 * the branch leaves behind, and that the payment path still makes it live.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeFault, type FakeRow } from "../engine/fake-supabase.test";

const state = vi.hoisted(() => ({
  stripe: true,
  db: null as unknown as ReturnType<typeof import("../engine/fake-supabase.test").fakeSupabase>,
  events: [] as { fn: string; args: Record<string, unknown> }[],
  properties: [{ propertyId: "320691", name: "Sea View Inn" }] as { propertyId: string; name: string | null }[],
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/pms/cloudbeds-webhooks", () => ({ ensureAppStateWebhook: async () => ({ ok: true }) }));
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsListProperties: async () => state.properties,
  cloudbedsDiscoverPropertyId: async () => "320691",
  cloudbedsGetHotelDetails: async () => ({
    externalPropertyId: "320691",
    name: "Sea View Inn",
    timezone: "Europe/Lisbon",
    currency: "EUR",
  }),
}));

import { handleMarketplaceConnect } from "./marketplace-connect";
import { activateMarketplaceHotelIfPending } from "./marketplace-activate";

const TOKENS = {
  accessToken: "cbat_new",
  refreshToken: "cbrt_new",
  tokenType: "Bearer",
  scope: null,
  expiresAt: "2026-09-17T00:00:00.000Z",
};

/** A claimed property: it has an owner. Whether it has paid is up to each test. */
function claimedProperty(opts: {
  connection: string;
  subscription?: string;
  isActive?: boolean;
  fault?: FakeFault;
}) {
  const seed: Record<string, FakeRow[]> = {
    hotels: [
      {
        id: "hotel-1",
        name: "Sea View Inn",
        external_enterprise_id: "cloudbeds:320691",
        is_active: opts.isActive ?? false,
      },
    ],
    hotel_memberships: [{ hotel_id: "hotel-1", user_id: "user-1", status: "active" }],
    pms_connections: [{ id: "conn-1", hotel_id: "hotel-1", pms_type: "cloudbeds", status: opts.connection }],
    hotel_subscriptions: opts.subscription ? [{ hotel_id: "hotel-1", status: opts.subscription }] : [],
  };
  state.db = fakeSupabase(seed, {
    fault: opts.fault,
    rpc: (fn, args) => {
      state.events.push({ fn, args: args as Record<string, unknown> });
      return null;
    },
  });
  return state.db;
}

const connectionStatus = () => state.db.tables.pms_connections[0].status;
const loggedEvent = () =>
  state.events.find((e) => e.fn === "platform_log_event")?.args.p_event_type;

beforeEach(() => {
  state.stripe = true;
  state.events = [];
  state.properties = [{ propertyId: "320691", name: "Sea View Inn" }];
});

describe("handleMarketplaceConnect reconnecting a claimed property", () => {
  it("leaves an unpaid claimed property pending", async () => {
    claimedProperty({ connection: "pending" });

    const outcome = await handleMarketplaceConnect("cloudbeds", TOKENS);

    expect(outcome).toMatchObject({ kind: "reconnected", hotelId: "hotel-1" });
    expect(connectionStatus()).toBe("pending");
    expect(loggedEvent()).toBe("pms.marketplace_pending");
    // The fresh grant is still stored, so paying later needs no second click.
    expect(state.events.some((e) => e.fn === "pms_secret_set")).toBe(true);
  });

  it("stamps the connection as re-authorized, so rates held for a missing permission go out next tick", async () => {
    claimedProperty({ connection: "connected", subscription: "active" });
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(state.db.tables.pms_connections[0].reauthorized_at).toEqual(expect.any(String));
  });

  it("puts back 'pending' on an unpaid property an earlier reconnect marked connected", async () => {
    claimedProperty({ connection: "connected" });
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(connectionStatus()).toBe("pending");
  });

  it.each(["incomplete", "incomplete_expired", "unpaid", "canceled"])(
    "treats a subscription that is %s as unpaid",
    async (subscription) => {
      claimedProperty({ connection: "disconnected", subscription });
      await handleMarketplaceConnect("cloudbeds", TOKENS);
      expect(connectionStatus()).toBe("pending");
    },
  );

  it.each(["trialing", "active", "past_due"])(
    "marks a property whose subscription is %s connected",
    async (subscription) => {
      claimedProperty({ connection: "disconnected", subscription, isActive: true });

      await handleMarketplaceConnect("cloudbeds", TOKENS);

      expect(connectionStatus()).toBe("connected");
      expect(loggedEvent()).toBe("pms.connected");
    },
  );

  it("marks it connected on an install with no Stripe keys, same as the claim does", async () => {
    // Nothing can be paid there, and the claim already activated it without a
    // subscription. 'pending' would park it with nothing left to lift it.
    state.stripe = false;
    claimedProperty({ connection: "disconnected", isActive: true });
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(connectionStatus()).toBe("connected");
  });

  it("does not park a property whose payment lands while the reconnect is running", async () => {
    // Webhook activation fires between our subscription read and our write:
    // the subscription is recorded and the row already flipped to 'connected'
    // when the 'pending' write lands on top of it. Activation never runs twice.
    let activated = false;
    const db = claimedProperty({
      connection: "pending",
      fault: (call) => {
        if (!activated && call.table === "pms_connections" && call.op === "upsert") {
          activated = true;
          db.tables.hotel_subscriptions.push({ hotel_id: "hotel-1", status: "active" });
          db.tables.pms_connections[0].status = "connected";
        }
        return null;
      },
    });

    await handleMarketplaceConnect("cloudbeds", TOKENS);

    expect(connectionStatus()).toBe("connected");
  });
});

describe("paying after an unpaid reconnect", () => {
  it("still goes live through activation", async () => {
    const db = claimedProperty({ connection: "pending" });
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(connectionStatus()).toBe("pending");

    // The subscription lands; the webhook activates the property.
    db.tables.hotel_subscriptions.push({ hotel_id: "hotel-1", status: "active" });
    const result = await activateMarketplaceHotelIfPending(db.client, "hotel-1", {
      claim: {
        token: "tok",
        hotel_id: "hotel-1",
        pms_type: "cloudbeds",
        property_name: "Sea View Inn",
        claimed_by: "user-1",
        claimed_at: "2026-09-15T00:00:00.000Z",
      },
    });

    expect(result).toMatchObject({ activated: true, hotelId: "hotel-1" });
    expect(connectionStatus()).toBe("connected");
    expect(db.tables.hotels[0].is_active).toBe(true);
  });
});

describe("an import a disconnect stopped", () => {
  const stopped = () => ({
    id: "job-1",
    hotel_id: "hotel-1",
    pms_type: "cloudbeds",
    status: "canceled",
    phase: "historical",
    last_error: "Stopped: the PMS connection was disconnected.",
    created_at: "2026-09-15T00:00:00.000Z",
    stats: {},
  });

  it("carries on when a paying property reconnects", async () => {
    const db = claimedProperty({ connection: "disconnected", subscription: "active", isActive: true });
    db.tables.import_jobs = [stopped()];
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status: "queued", phase: "historical", last_error: null });
  });

  it("waits for the subscribe screen when the property has not paid", async () => {
    const db = claimedProperty({ connection: "disconnected" });
    db.tables.import_jobs = [stopped()];
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(db.tables.import_jobs[0].status).toBe("canceled");
  });

  it("does not import a paying property again when its import had finished", async () => {
    const db = claimedProperty({ connection: "disconnected", subscription: "active", isActive: true });
    db.tables.import_jobs = [{ ...stopped(), status: "completed", phase: "done" }];
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0].status).toBe("completed");
  });
});

describe("a property whose never-paid data the retention sweep removed", () => {
  /** What the sweep leaves: owner, claim and property, no connection, no jobs, data_purged_at set. */
  function purged(opts: { isActive?: boolean; subscription?: string } = {}) {
    const db = claimedProperty({ connection: "gone", subscription: opts.subscription, isActive: opts.isActive });
    db.tables.pms_connections = [];
    db.tables.import_jobs = [];
    db.tables.hotels[0].data_purged_at = "2027-03-01T00:00:00.000Z";
    db.tables.hotels[0].setup_pending_at = opts.isActive ? null : "2026-09-01T00:00:00.000Z";
    db.tables.hotels[0].setup_deferred_at = null;
    db.tables.hotels[0].created_at = "2026-09-01T00:00:00.000Z";
    db.tables.pms_marketplace_claims = [
      { token: "tok", hotel_id: "hotel-1", pms_type: "cloudbeds", claimed_by: "user-1", claimed_at: "2026-09-01T00:00:00.000Z" },
    ];
    return db;
  }

  it("queues a fresh full import on reconnect, and the unpaid property stays parked", async () => {
    const db = purged();
    const outcome = await handleMarketplaceConnect("cloudbeds", TOKENS);

    expect(outcome).toMatchObject({ kind: "reconnected", hotelId: "hotel-1" });
    expect(connectionStatus()).toBe("pending");
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({
      status: "queued",
      phase: "discover",
      requested_by: "user-1",
    });
    expect(db.tables.hotels[0].is_active).toBe(false);
  });

  it("queues it for a property paid for before the reconnect, and onboarding follows the new job", async () => {
    const db = purged({ isActive: true, subscription: "active" });
    await handleMarketplaceConnect("cloudbeds", TOKENS);

    expect(connectionStatus()).toBe("connected");
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status: "queued", phase: "discover" });
    expect(db.tables.onboarding_states[0]).toMatchObject({
      hotel_id: "hotel-1",
      import_job_id: db.tables.import_jobs[0].id,
    });
  });

  it("payment after the reconnect adopts that import instead of starting another", async () => {
    const db = purged();
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    const jobId = db.tables.import_jobs[0].id;

    db.tables.hotel_subscriptions.push({ hotel_id: "hotel-1", status: "trialing" });
    const result = await activateMarketplaceHotelIfPending(db.client, "hotel-1");

    expect(result).toMatchObject({ activated: true, importJobId: jobId });
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(connectionStatus()).toBe("connected");
  });

  it("reconnects as before when the column is not there yet", async () => {
    const db = purged();
    db.tables.hotels[0].data_purged_at = undefined;
    const fault: FakeFault = (call) =>
      call.table === "hotels" && call.columns.includes("data_purged_at")
        ? { code: "42703", message: "column hotels.data_purged_at does not exist" }
        : null;
    state.db = fakeSupabase(db.tables, {
      fault,
      rpc: (fn, args) => {
        state.events.push({ fn, args: args as Record<string, unknown> });
        return null;
      },
    });

    const outcome = await handleMarketplaceConnect("cloudbeds", TOKENS);

    expect(outcome).toMatchObject({ kind: "reconnected" });
    expect(connectionStatus()).toBe("pending");
    expect(state.db.tables.import_jobs).toEqual([]);
  });

  it("does not import again a property that was never purged", async () => {
    const db = claimedProperty({ connection: "disconnected", subscription: "active", isActive: true });
    db.tables.pms_marketplace_claims = [
      { token: "tok", hotel_id: "hotel-1", pms_type: "cloudbeds", claimed_by: "user-1", claimed_at: "2026-09-01T00:00:00.000Z" },
    ];
    db.tables.import_jobs = [
      { id: "job-1", hotel_id: "hotel-1", pms_type: "cloudbeds", status: "completed", phase: "done", created_at: "2026-09-02T00:00:00.000Z" },
    ];
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0].status).toBe("completed");
  });

  it("imports only the group sibling the subscribe screen shows next", async () => {
    const db = purged();
    state.properties = [
      { propertyId: "320691", name: "Sea View Inn" },
      { propertyId: "320692", name: "Sea View Annex" },
    ];
    db.tables.hotels.push({
      ...db.tables.hotels[0],
      id: "hotel-2",
      name: "Sea View Annex",
      external_enterprise_id: "cloudbeds:320692",
      created_at: "2026-09-01T00:00:01.000Z",
    });
    db.tables.hotel_memberships.push({ hotel_id: "hotel-2", user_id: "user-1", status: "active" });
    db.tables.pms_marketplace_claims.push({ ...db.tables.pms_marketplace_claims[0], token: "tok2", hotel_id: "hotel-2" });

    const outcome = await handleMarketplaceConnect("cloudbeds", TOKENS);

    expect(outcome).toMatchObject({ kind: "reconnected" });
    expect(db.tables.pms_connections.map((c) => c.status)).toEqual(["pending", "pending"]);
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ hotel_id: "hotel-1", status: "queued" });
  });

  it("a trial that ended unpaid waits for payment, and paying again queues the import", async () => {
    const db = purged({ isActive: true, subscription: "canceled" });
    await handleMarketplaceConnect("cloudbeds", TOKENS);
    expect(connectionStatus()).toBe("pending");
    expect(db.tables.import_jobs).toEqual([]);

    db.tables.hotel_subscriptions[0].status = "active";
    const result = await activateMarketplaceHotelIfPending(db.client, "hotel-1");

    expect(result).toMatchObject({ activated: false, reason: "already_active" });
    expect(connectionStatus()).toBe("connected");
    expect(db.tables.import_jobs).toHaveLength(1);
    expect(db.tables.import_jobs[0]).toMatchObject({ status: "queued", phase: "discover", requested_by: "user-1" });
    expect(db.tables.onboarding_states[0]).toMatchObject({ import_job_id: db.tables.import_jobs[0].id });
  });
});
