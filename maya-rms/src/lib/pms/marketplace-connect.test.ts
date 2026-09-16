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
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/pms/cloudbeds-webhooks", () => ({ ensureAppStateWebhook: async () => ({ ok: true }) }));
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsListProperties: async () => [{ propertyId: "320691", name: "Sea View Inn" }],
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
    hotel_memberships: [{ hotel_id: "hotel-1", user_id: "user-1" }],
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
