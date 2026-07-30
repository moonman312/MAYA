/**
 * Webhook tests, with REAL signature verification.
 *
 * The signature check is the only thing standing between this URL and anyone
 * who wants to grant themselves a subscription, so these use Stripe's own
 * signer and verifier rather than stubbing them — a mocked constructEvent would
 * pass while the real one rejected every delivery, or worse, the reverse.
 * Only the outbound reads (subscriptions.retrieve) and the database are faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

const SECRET = "whsec_test_secret";
const signer = new Stripe("sk_test_signing_only");

const state = vi.hoisted(() => ({
  retrieved: null as unknown,
  retrieveError: null as Error | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  insertError: null as { code?: string; message: string } | null,
  upsertError: null as { message: string } | null,
  upserts: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/billing/stripe", async () => {
  const real = new Stripe("sk_test_signing_only");
  return {
    isStripeConfigured: () => true,
    stripeClient: () => ({
      webhooks: real.webhooks,
      subscriptions: {
        retrieve: async () => {
          if (state.retrieveError) throw state.retrieveError;
          return state.retrieved;
        },
      },
    }),
  };
});

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () =>
    ({
      from: (table: string) => ({
        upsert: (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return Promise.resolve({ error: state.upsertError });
        },
        insert: (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return Promise.resolve({ error: state.insertError });
        },
      }),
    }) as unknown as SupabaseClient,
}));

const { POST } = await import("./route");

const CREATED = Math.floor(Date.parse("2026-07-29T12:00:00Z") / 1000);

function subscription(o: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    created: CREATED,
    cancel_at_period_end: false,
    trial_end: null,
    metadata: { hotel_id: "hotel-1" },
    items: {
      data: [
        {
          quantity: 40,
          current_period_end: CREATED + 30 * 86400,
          price: { recurring: { interval: "month" } },
        },
      ],
    },
    ...o,
  };
}

/** A real, correctly signed delivery of `event`. */
function signedRequest(event: Record<string, unknown>, secret = SECRET) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  state.retrieved = subscription();
  state.retrieveError = null;
  state.inserts = [];
  state.insertError = null;
  state.upserts = [];
  state.upsertError = null;
});

describe("signature enforcement", () => {
  it("refuses a body with no signature at all", async () => {
    const res = await POST(
      new Request("http://localhost/api/stripe/webhook", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(400);
    expect(state.upserts).toHaveLength(0);
  });

  it("refuses a forged signature", async () => {
    const req = signedRequest(
      { id: "evt_1", type: "customer.subscription.updated", data: { object: subscription() } },
      "whsec_the_wrong_secret",
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    // The whole point: an attacker who knows this URL still writes nothing.
    expect(state.upserts).toHaveLength(0);
  });

  it("refuses a replay outside the timestamp tolerance", async () => {
    const payload = JSON.stringify({
      id: "evt_old",
      type: "customer.subscription.updated",
      data: { object: subscription() },
    });
    const header = signer.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
    });
    const res = await POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": header },
        body: payload,
      }),
    );
    expect(res.status).toBe(400);
    expect(state.upserts).toHaveLength(0);
  });

  it("is down rather than permissive when the secret is unset", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await POST(
      signedRequest({ id: "evt_1", type: "customer.subscription.updated", data: { object: subscription() } }),
    );
    expect(res.status).toBe(503);
    expect(state.upserts).toHaveLength(0);
  });
});

describe("subscription events", () => {
  it("persists a correctly signed subscription update", async () => {
    const res = await POST(
      signedRequest({ id: "evt_1", type: "customer.subscription.updated", data: { object: subscription() } }),
    );
    expect(res.status).toBe(200);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({
      hotel_id: "hotel-1",
      stripe_subscription_id: "sub_1",
      status: "active",
      billed_rooms: 40,
    });
  });

  it("uses the re-fetched subscription, not the one in the event body", async () => {
    // Deliveries arrive out of order, so a stale 'active' payload must not
    // overwrite the 'canceled' that Stripe currently reports.
    state.retrieved = subscription({ status: "canceled" });
    await POST(
      signedRequest({
        id: "evt_1",
        type: "customer.subscription.updated",
        data: { object: subscription({ status: "active" }) },
      }),
    );
    expect(state.upserts[0]).toMatchObject({ status: "canceled" });
  });

  it("acknowledges a subscription with no hotel so Stripe stops retrying", async () => {
    state.retrieved = subscription({ metadata: {} });
    const res = await POST(
      signedRequest({ id: "evt_1", type: "customer.subscription.deleted", data: { object: subscription() } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "no_hotel_metadata" });
    expect(state.upserts).toHaveLength(0);
  });

  it("asks Stripe to retry when the database write fails", async () => {
    state.upsertError = { message: "deadlock detected" };
    const res = await POST(
      signedRequest({ id: "evt_1", type: "customer.subscription.updated", data: { object: subscription() } }),
    );
    expect(res.status).toBe(500);
  });

  it("asks Stripe to retry when the re-fetch fails", async () => {
    state.retrieveError = new Error("stripe unreachable");
    const res = await POST(
      signedRequest({ id: "evt_1", type: "customer.subscription.updated", data: { object: subscription() } }),
    );
    expect(res.status).toBe(500);
  });
});

describe("checkout.session.completed", () => {
  const session = (o: Record<string, unknown> = {}) => ({
    id: "cs_1",
    object: "checkout.session",
    subscription: "sub_1",
    customer_details: { email: "gm@driftwood.example" },
    metadata: { hotel_id: "hotel-1", user_id: "user-1", signup_code_id: "code-9" },
    ...o,
  });

  it("records who redeemed the code, with their email", async () => {
    const res = await POST(
      signedRequest({ id: "evt_2", type: "checkout.session.completed", data: { object: session() } }),
    );
    expect(res.status).toBe(200);
    const redemption = state.inserts.find((i) => i.table === "signup_code_redemptions");
    expect(redemption?.row).toMatchObject({
      code_id: "code-9",
      hotel_id: "hotel-1",
      user_id: "user-1",
      email: "gm@driftwood.example",
    });
    // And it still syncs the subscription itself.
    expect(state.upserts).toHaveLength(1);
  });

  it("treats a duplicate redemption as the redelivery it is", async () => {
    state.insertError = { code: "23505", message: "duplicate key" };
    const res = await POST(
      signedRequest({ id: "evt_2", type: "checkout.session.completed", data: { object: session() } }),
    );
    expect(res.status).toBe(200);
    expect(state.upserts).toHaveLength(1);
  });

  it("records nothing when no code was used", async () => {
    const res = await POST(
      signedRequest({
        id: "evt_2",
        type: "checkout.session.completed",
        data: { object: session({ metadata: { hotel_id: "hotel-1" } }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(state.inserts).toHaveLength(0);
    expect(state.upserts).toHaveLength(1);
  });
});

describe("unrelated events", () => {
  it("acknowledges without touching anything", async () => {
    const res = await POST(
      signedRequest({ id: "evt_3", type: "invoice.paid", data: { object: { id: "in_1" } } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "invoice.paid" });
    expect(state.upserts).toHaveLength(0);
  });
});
