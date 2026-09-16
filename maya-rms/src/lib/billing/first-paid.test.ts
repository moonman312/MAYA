/**
 * first_paid_at is the one billing fact the never-paid retention sweep trusts
 * to tell a former customer from a trial that never converted, so it has to be
 * written for real money only, written once, and written even when Stripe
 * delivers the invoice before the subscription it belongs to.
 */
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { fakeSupabase, missingColumn, type FakeRow } from "../engine/fake-supabase.test";
import { recordFirstPayment } from "./first-paid";

const PAID_AT = Math.floor(Date.parse("2026-09-20T08:00:00Z") / 1000);

function invoice(o: Record<string, unknown> = {}, subscriptionMeta: Record<string, string> | null = null) {
  return {
    id: "in_1",
    status: "paid",
    amount_paid: 42_00,
    created: PAID_AT - 60,
    status_transitions: { paid_at: PAID_AT },
    parent: { subscription_details: { subscription: "sub_1", metadata: subscriptionMeta } },
    ...o,
  } as unknown as Stripe.Invoice;
}

function stripeWith(sub: Record<string, unknown> | null) {
  const calls: string[] = [];
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push(id);
        return sub;
      },
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

const subscription = (metadata: Record<string, string>) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  created: PAID_AT - 86400,
  cancel_at_period_end: false,
  trial_end: null,
  metadata,
  items: { data: [{ quantity: 12, current_period_end: PAID_AT + 30 * 86400, price: { recurring: { interval: "month" } } }] },
});

const row = (o: FakeRow = {}): FakeRow => ({
  hotel_id: "hotel-1",
  stripe_subscription_id: "sub_1",
  status: "active",
  first_paid_at: null,
  ...o,
});

describe("recordFirstPayment", () => {
  it("stamps when a subscription's invoice charges real money", async () => {
    const db = fakeSupabase({ hotel_subscriptions: [row()] });
    const r = await recordFirstPayment(db.client, stripeWith(null).stripe, invoice());
    expect(r).toEqual({ stamped: true, hotelId: "hotel-1" });
    expect(db.tables.hotel_subscriptions[0].first_paid_at).toBe("2026-09-20T08:00:00.000Z");
  });

  it.each([
    ["a trial's zero invoice", { amount_paid: 0 }],
    ["a 100%-off code", { amount_paid: 0, status: "paid" }],
    ["an invoice that is not paid", { status: "open" }],
  ])("ignores %s", async (_label, over) => {
    const db = fakeSupabase({ hotel_subscriptions: [row()] });
    const r = await recordFirstPayment(db.client, stripeWith(null).stripe, invoice(over));
    expect(r).toEqual({ stamped: false, reason: "not_charged" });
    expect(db.tables.hotel_subscriptions[0].first_paid_at).toBeNull();
    expect(db.calls.some((c) => c.op === "update")).toBe(false);
  });

  it("never moves a first payment already recorded", async () => {
    const db = fakeSupabase({ hotel_subscriptions: [row({ first_paid_at: "2025-01-01T00:00:00.000Z" })] });
    const r = await recordFirstPayment(db.client, stripeWith(null).stripe, invoice());
    expect(r).toEqual({ stamped: false, reason: "already_stamped" });
    expect(db.tables.hotel_subscriptions[0].first_paid_at).toBe("2025-01-01T00:00:00.000Z");
  });

  it("records the subscription first when the invoice arrives before it", async () => {
    const db = fakeSupabase({ hotel_subscriptions: [] });
    const { stripe, calls } = stripeWith(subscription({ hotel_id: "hotel-1" }));
    const r = await recordFirstPayment(db.client, stripe, invoice());
    expect(r).toEqual({ stamped: true, hotelId: "hotel-1" });
    expect(calls).toEqual(["sub_1"]);
    expect(db.tables.hotel_subscriptions[0]).toMatchObject({
      hotel_id: "hotel-1",
      stripe_subscription_id: "sub_1",
      first_paid_at: "2026-09-20T08:00:00.000Z",
    });
  });

  it("still stamps the property when the paid subscription has since been replaced", async () => {
    const db = fakeSupabase({ hotel_subscriptions: [row({ stripe_subscription_id: "sub_2" })] });
    const r = await recordFirstPayment(db.client, stripeWith(null).stripe, invoice({}, { hotel_id: "hotel-1" }));
    expect(r).toEqual({ stamped: true, hotelId: "hotel-1" });
    expect(db.tables.hotel_subscriptions[0]).toMatchObject({ stripe_subscription_id: "sub_2", first_paid_at: "2026-09-20T08:00:00.000Z" });
  });

  it("leaves a subscription sold outside our checkout alone", async () => {
    const db = fakeSupabase({ hotel_subscriptions: [] });
    const r = await recordFirstPayment(db.client, stripeWith(subscription({})).stripe, invoice());
    expect(r).toEqual({ stamped: false, reason: "no_hotel" });
    expect(db.tables.hotel_subscriptions).toHaveLength(0);
  });

  it("says the column is missing instead of failing, ahead of its migration", async () => {
    const db = fakeSupabase(
      { hotel_subscriptions: [row()] },
      { fault: (c) => (c.op === "update" ? missingColumn("hotel_subscriptions", "first_paid_at") : null) },
    );
    const r = await recordFirstPayment(db.client, stripeWith(null).stripe, invoice());
    expect(r).toEqual({ stamped: false, reason: "column_missing" });
  });

  it("reports a failed write as an error the webhook can retry", async () => {
    const db = fakeSupabase(
      { hotel_subscriptions: [row()] },
      { fault: (c) => (c.op === "update" ? { message: "connection reset" } : null) },
    );
    const r = await recordFirstPayment(db.client, stripeWith(null).stripe, invoice());
    expect(r).toEqual({ stamped: false, reason: "error", message: "connection reset" });
  });
});
