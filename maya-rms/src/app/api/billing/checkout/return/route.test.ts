/**
 * Regression tests for the post-Checkout landing.
 *
 * This exists to beat the webhook: the PMS picker decides whether the caller has
 * paid by reading hotel_subscriptions, and Stripe redirects the browser back long
 * before the webhook necessarily lands. Without the write here, someone who has
 * just handed over a card gets shown the payment form again.
 *
 * The projection itself is the real sync.ts — a faked projectSubscription would
 * pass while the real one dropped the row. Only Stripe's reads and the database
 * are stood in for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const USER = "user-1";
const CREATED = Math.floor(Date.parse("2026-07-29T12:00:00Z") / 1000);

const state = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  session: null as unknown,
  subscription: null as unknown,
  throws: null as Error | null,
  upserts: [] as Record<string, unknown>[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () =>
    ({
      auth: { getUser: async () => ({ data: { user: state.user } }) },
    }) as unknown as SupabaseClient,
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () =>
    ({
      from: () => ({
        // persistSubscription reads the recorded subscription first, so a late
        // event can't revoke a live one. Nothing recorded here: this is a fresh
        // signup, which is the case these tests are about.
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
        upsert: (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    }) as unknown as SupabaseClient,
}));
vi.mock("@/lib/billing/stripe", () => ({
  isStripeConfigured: () => true,
  stripeClient: () => ({
    checkout: {
      sessions: {
        retrieve: async () => {
          if (state.throws) throw state.throws;
          return state.session;
        },
      },
    },
    subscriptions: { retrieve: async () => state.subscription },
  }),
}));

const { GET } = await import("./route");

function get(query = "?session_id=cs_test") {
  return GET(new Request(`http://localhost/api/billing/checkout/return${query}`));
}

function subscription(o: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "trialing",
    created: CREATED,
    cancel_at_period_end: false,
    trial_end: CREATED + 30 * 86400,
    metadata: { hotel_id: "hotel-pending", user_id: USER, signup_code_id: "code-1" },
    items: {
      data: [
        {
          quantity: 24,
          current_period_end: CREATED + 30 * 86400,
          price: { recurring: { interval: "month" } },
        },
      ],
    },
    ...o,
  };
}

const location = (res: Response) => res.headers.get("location") ?? "";

beforeEach(() => {
  state.user = { id: USER };
  state.session = { id: "cs_test", subscription: "sub_1", metadata: { user_id: USER } };
  state.subscription = subscription();
  state.throws = null;
  state.upserts = [];
});

describe("beating the webhook", () => {
  it("writes the subscription before handing the caller to the PMS picker", async () => {
    const res = await get();
    expect(location(res)).toContain("/onboarding/connect");
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({
      hotel_id: "hotel-pending",
      stripe_subscription_id: "sub_1",
      status: "trialing",
      billed_rooms: 24,
      billing_interval: "month",
    });
  });

  it("waits for the webhook when Stripe cannot be reached, rather than the payment form", async () => {
    state.throws = new Error("stripe unreachable");
    const res = await get();
    // This used to go to the PMS picker on the theory that its guard would sort
    // it out. Its guard sends anyone without a recorded payment to /onboarding,
    // which renders the payment form — so someone who had just paid was invited
    // to pay again. The confirming screen waits for the webhook and moves them
    // on by itself.
    expect(location(res)).toContain("/onboarding/confirming");
    expect(state.upserts).toHaveLength(0);
  });

  it("records an unpaid subscription as what it is, rather than skipping it", async () => {
    state.subscription = subscription({ status: "incomplete", trial_end: null });
    await get();
    // Not entitled, so onboarding sends them back to payment — but the row is
    // there, which is what makes that decision possible at all.
    expect(state.upserts[0]).toMatchObject({ status: "incomplete" });
  });
});

describe("what it refuses to believe", () => {
  it("ignores a session id belonging to somebody else", async () => {
    state.session = { id: "cs_test", subscription: "sub_1", metadata: { user_id: "user-2" } };
    const res = await get();
    expect(location(res)).toContain("/onboarding");
    expect(location(res)).not.toContain("/connect");
    expect(state.upserts).toHaveLength(0);
  });

  it("ignores an arrival with no session id at all", async () => {
    const res = await get("");
    expect(location(res)).toContain("/onboarding");
    expect(state.upserts).toHaveLength(0);
  });

  it("sends a signed-out caller to log in", async () => {
    state.user = null;
    const res = await get();
    expect(location(res)).toContain("/login");
    expect(state.upserts).toHaveLength(0);
  });
});

describe("nobody who paid is shown the payment form again", () => {
  it("waits when the subscription exists but isn't live yet", async () => {
    // `incomplete` writes fine and entitles nobody. Treating a successful write
    // as success sent them to the picker, whose guard bounced them to the
    // payment form — the exact screen a paying customer must never see next.
    state.throws = null;
    state.subscription = subscription({ status: "incomplete", trial_end: null });
    const res = await get();
    expect(location(res)).toContain("/onboarding/confirming");
    // Still recorded: the row is how the webhook and the UI agree later.
    expect(state.upserts).toHaveLength(1);
  });

  it("goes straight through once the subscription is live", async () => {
    // No waiting screen when there is nothing to wait for.
    state.throws = null;
    state.subscription = subscription({ status: "trialing" });
    expect(location(await get())).toContain("/onboarding/connect");
  });
});
