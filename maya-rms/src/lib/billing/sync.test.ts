import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CARD_REVERIFY_AFTER_HOURS,
  isEntitled,
  persistSubscription,
  projectSubscription,
  type SubscriptionProjection,
} from "./sync";

const CREATED = Math.floor(Date.parse("2026-07-29T12:00:00Z") / 1000);

function sub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
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
          current_period_end: Math.floor(Date.parse("2026-08-29T12:00:00Z") / 1000),
          price: { recurring: { interval: "month" } },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("projectSubscription", () => {
  it("maps a healthy subscription onto a row", () => {
    const row = projectSubscription(sub())!;
    expect(row).toMatchObject({
      hotel_id: "hotel-1",
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      status: "active",
      billing_interval: "month",
      billed_rooms: 40,
      cancel_at_period_end: false,
    });
    expect(row.current_period_end).toBe("2026-08-29T12:00:00.000Z");
  });

  it("makes the first card check due at once, and pins it to creation", () => {
    // Two checks: this one now, and a second at signup + 48h that patchFor arms
    // after this one passes. Anchored on now() instead of the subscription's own
    // creation, every redelivery of an old event would move the deadline out and
    // the check would never come due.
    const first = projectSubscription(sub())!;
    const replayed = projectSubscription(sub())!;
    expect(first.card_verify_due_at).toBe(replayed.card_verify_due_at);
    expect(first.card_verify_due_at).toBe(new Date(CREATED * 1000).toISOString());
    expect(Date.parse(first.card_verify_due_at!)).toBeLessThan(
      CREATED * 1000 + CARD_REVERIFY_AFTER_HOURS * 3600_000,
    );
  });

  it("refuses a subscription with no hotel attached", () => {
    // Created by hand in the dashboard: there is nothing to attach it to, and
    // guessing a hotel would bill the wrong one.
    expect(projectSubscription(sub({ metadata: {} }))).toBeNull();
    expect(projectSubscription(sub({ metadata: { hotel_id: "" } }))).toBeNull();
  });

  it("refuses an interval it cannot bill", () => {
    const weekly = sub({
      items: { data: [{ quantity: 10, price: { recurring: { interval: "week" } } }] },
    });
    expect(projectSubscription(weekly)).toBeNull();
  });

  it("reads the customer whether it arrives as an id or an object", () => {
    expect(projectSubscription(sub({ customer: { id: "cus_expanded" } }))!.stripe_customer_id).toBe(
      "cus_expanded",
    );
  });

  it("falls back to the subscription's own period end when the item has none", () => {
    // current_period_end moved onto the item in recent API versions; a version
    // bump in either direction must not blank the renewal date.
    const legacy = sub({
      current_period_end: Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
      items: { data: [{ quantity: 10, price: { recurring: { interval: "month" } } }] },
    });
    expect(projectSubscription(legacy)!.current_period_end).toBe("2026-09-01T00:00:00.000Z");
  });

  it("carries a trial end and a signup code through", () => {
    const trialing = sub({
      status: "trialing",
      trial_end: Math.floor(Date.parse("2026-08-05T12:00:00Z") / 1000),
      metadata: { hotel_id: "hotel-1", signup_code_id: "code-9" },
    });
    const row = projectSubscription(trialing)!;
    expect(row.status).toBe("trialing");
    expect(row.trial_end).toBe("2026-08-05T12:00:00.000Z");
    expect(row.signup_code_id).toBe("code-9");
  });
});

describe("persistSubscription", () => {
  /** `current` is what hotel_subscriptions already holds for this hotel. */
  function fakeAdmin(current: { stripe_subscription_id: string; status: string } | null = null) {
    const upserts: unknown[] = [];
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: current, error: null }) }),
        }),
        upsert: (row: unknown) => {
          upserts.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;
    return { admin, upserts };
  }

  const row = (o: Partial<SubscriptionProjection> = {}): SubscriptionProjection => ({
    hotel_id: "hotel-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    status: "active",
    billing_interval: "month",
    billed_rooms: 40,
    current_period_end: null,
    trial_end: null,
    cancel_at_period_end: false,
    card_verify_due_at: null,
    signup_code_id: null,
    ...o,
  });

  it("upserts on hotel_id so a redelivery updates rather than duplicates", async () => {
    const { admin, upserts } = fakeAdmin();
    expect((await persistSubscription(admin, row())).ok).toBe(true);
    expect(upserts).toHaveLength(1);
  });

  it("drops a zero-quantity subscription instead of failing the webhook forever", async () => {
    // The column rejects it, so retrying can never succeed — acknowledge and log
    // rather than making Stripe redeliver something unfixable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin, upserts } = fakeAdmin();
    const res = await persistSubscription(admin, row({ billed_rooms: 0 }));
    expect(res.ok).toBe(true);
    expect(upserts).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reports a real write failure so Stripe retries", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        upsert: () => Promise.resolve({ error: { message: "deadlock" } }),
      }),
    } as unknown as SupabaseClient;
    const res = await persistSubscription(admin, row());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("deadlock");
    spy.mockRestore();
  });

  describe("one hotel, one subscription", () => {
    it("ignores a late cancellation for a subscription that was already replaced", async () => {
      // Stripe redelivers for days. A "canceled" for last month's subscription
      // landing after this month's is live would otherwise switch off a hotel that
      // is paying perfectly well.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { admin, upserts } = fakeAdmin({ stripe_subscription_id: "sub_live", status: "active" });
      const res = await persistSubscription(admin, row({ stripe_subscription_id: "sub_old", status: "canceled" }));
      expect(res.ok).toBe(true);
      expect(upserts).toHaveLength(0);
      spy.mockRestore();
    });

    it("shouts when a second live subscription appears for one hotel", async () => {
      // Two checkouts raced. Both bill the customer; only one can be recorded.
      // Silence here is how a double charge goes unnoticed until they complain.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { admin, upserts } = fakeAdmin({ stripe_subscription_id: "sub_first", status: "active" });
      await persistSubscription(admin, row({ stripe_subscription_id: "sub_second", status: "active" }));
      expect(upserts).toHaveLength(1);
      const logged = String(spy.mock.calls.at(-1)?.[0] ?? "");
      expect(logged).toContain("duplicate_live_subscription");
      expect(logged).toContain("sub_first");
      expect(logged).toContain("sub_second");
      spy.mockRestore();
    });

    it("lets a re-subscribe through, because the old one is not alive", async () => {
      const { admin, upserts } = fakeAdmin({ stripe_subscription_id: "sub_dead", status: "canceled" });
      await persistSubscription(admin, row({ stripe_subscription_id: "sub_fresh", status: "active" }));
      expect(upserts).toHaveLength(1);
    });

    it("updates the recorded subscription in place as usual", async () => {
      const { admin, upserts } = fakeAdmin({ stripe_subscription_id: "sub_new", status: "trialing" });
      await persistSubscription(admin, row({ stripe_subscription_id: "sub_new", status: "active" }));
      expect(upserts).toHaveLength(1);
    });
  });
});

describe("isEntitled", () => {
  it("keeps pricing running through the retry window", () => {
    // Cutting a hotel off on the first failed charge is worse than carrying them
    // through Stripe's ~2 week dunning with a banner.
    expect(isEntitled("trialing")).toBe(true);
    expect(isEntitled("active")).toBe(true);
    expect(isEntitled("past_due")).toBe(true);
  });

  it("stops once the retries have run out or it was never paid", () => {
    for (const s of ["unpaid", "canceled", "incomplete", "incomplete_expired", "paused", null, undefined, ""]) {
      expect(isEntitled(s)).toBe(false);
    }
  });
});
