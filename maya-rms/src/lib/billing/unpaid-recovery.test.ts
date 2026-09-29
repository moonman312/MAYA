/**
 * An owner whose subscription went unpaid is told "Update your card and the
 * subscription restarts where it left off". These pin down what makes that
 * true: the new default card pays the open invoices of this customer's unpaid
 * subscriptions, and nothing else is charged, retried or touched. Only the
 * subscription each hotel is on today counts: one a newer checkout replaced
 * stays unpaid, or the property would be billed twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultCardChanged, payUnpaidAfterCardUpdate } from "./unpaid-recovery";

type Call = { op: string; args: unknown[] };

function invoice(id: string, created: number, o: Record<string, unknown> = {}) {
  return { id, object: "invoice", status: "open", created, ...o };
}

function sub(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    object: "subscription",
    status: "unpaid",
    customer: "cus_1",
    default_payment_method: "pm_old",
    metadata: { hotel_id: `hotel-${id}` },
    ...o,
  };
}

function fakeStripe(o: {
  customer?: Record<string, unknown>;
  subs?: Record<string, unknown>[];
  invoices?: Record<string, Record<string, unknown>[]>;
  pay?: (id: string) => unknown;
  update?: (id: string) => unknown;
} = {}) {
  const calls: Call[] = [];
  const stripe = {
    customers: {
      retrieve: async (...args: unknown[]) => {
        calls.push({ op: "customers.retrieve", args });
        return o.customer ?? { id: "cus_1", invoice_settings: { default_payment_method: "pm_new" } };
      },
    },
    subscriptions: {
      list: async (...args: unknown[]) => {
        calls.push({ op: "subscriptions.list", args });
        return { data: o.subs ?? [sub("sub_1")] };
      },
      update: async (...args: unknown[]) => {
        calls.push({ op: "subscriptions.update", args });
        return o.update ? o.update(String(args[0])) : { id: args[0] };
      },
    },
    invoices: {
      list: async (...args: unknown[]) => {
        calls.push({ op: "invoices.list", args });
        const params = args[0] as { subscription: string };
        const bySub: Record<string, Record<string, unknown>[]> = o.invoices ?? { sub_1: [invoice("in_1", 100)] };
        return { data: bySub[params.subscription] ?? [] };
      },
      pay: async (...args: unknown[]) => {
        calls.push({ op: "invoices.pay", args });
        return o.pay ? o.pay(String(args[0])) : { id: args[0], status: "paid" };
      },
    },
  } as unknown as Stripe;
  return { stripe, calls, of: (op: string) => calls.filter((c) => c.op === op) };
}

/**
 * hotel_subscriptions, as the webhook's admin client reads it. By default each
 * hotel is on the subscription its test name says (hotel-sub_1 is on sub_1);
 * `recorded` overrides that, and null means the hotel has no row.
 */
function fakeAdmin(recorded: Record<string, string | null> = {}, error: { message: string } | null = null) {
  const reads: string[] = [];
  const admin = {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, hotel: string) => ({
          maybeSingle: async () => {
            reads.push(`${table}:${hotel}`);
            if (error) return { data: null, error };
            const sub = hotel in recorded ? recorded[hotel] : hotel.replace(/^hotel-/, "");
            return { data: sub ? { stripe_subscription_id: sub } : null, error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  return { admin, reads };
}

const admin = fakeAdmin().admin;

const cardError = (code: string) =>
  Object.assign(new Error("Your card was declined."), { type: "StripeCardError", rawType: "card_error", code: "card_declined", decline_code: code });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("defaultCardChanged", () => {
  it("is true when the default card moved, including from none", () => {
    expect(defaultCardChanged({ invoice_settings: { default_payment_method: "pm_old" } })).toBe(true);
    expect(defaultCardChanged({ invoice_settings: { default_payment_method: null } })).toBe(true);
  });

  it("is false for any other change to the customer", () => {
    expect(defaultCardChanged({ email: "old@example.test" })).toBe(false);
    expect(defaultCardChanged({ invoice_settings: { footer: null } })).toBe(false);
    expect(defaultCardChanged(undefined)).toBe(false);
    expect(defaultCardChanged(null)).toBe(false);
  });
});

describe("payUnpaidAfterCardUpdate", () => {
  it("pays the open invoices oldest first, with the card the owner just set", async () => {
    const f = fakeStripe({ invoices: { sub_1: [invoice("in_new", 300), invoice("in_old", 100)] } });
    const r = await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");

    expect(f.of("subscriptions.list")[0].args[0]).toMatchObject({ customer: "cus_1", status: "unpaid" });
    expect(f.of("invoices.list")[0].args[0]).toMatchObject({ subscription: "sub_1", status: "open" });
    expect(f.of("invoices.pay").map((c) => c.args)).toEqual([
      ["in_old", { payment_method: "pm_new", off_session: true }, { idempotencyKey: "maya_unpaid_pay_in_old_pm_new" }],
      ["in_new", { payment_method: "pm_new", off_session: true }, { idempotencyKey: "maya_unpaid_pay_in_new_pm_new" }],
    ]);
    expect(r).toMatchObject({
      attempted: true,
      card: "pm_new",
      attempts: [
        { subscription: "sub_1", hotel: "hotel-sub_1", invoice: "in_old", outcome: "paid" },
        { subscription: "sub_1", hotel: "hotel-sub_1", invoice: "in_new", outcome: "paid" },
      ],
    });
  });

  it("reads the default card back from Stripe rather than trusting the event", async () => {
    const f = fakeStripe({
      customer: { id: "cus_1", invoice_settings: { default_payment_method: { id: "pm_latest", object: "payment_method" } } },
    });
    await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");
    expect(f.of("customers.retrieve")[0].args[0]).toBe("cus_1");
    expect(f.of("invoices.pay")[0].args[1]).toEqual({ payment_method: "pm_latest", off_session: true });
  });

  it("moves the subscription onto the card that paid, so the next renewal uses it too", async () => {
    const f = fakeStripe();
    const r = await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");
    expect(f.of("subscriptions.update").map((c) => c.args)).toEqual([
      ["sub_1", { default_payment_method: "pm_new" }, { idempotencyKey: "maya_unpaid_card_sub_1_pm_new" }],
    ]);
    expect(r).toMatchObject({ moved: ["sub_1"] });
  });

  it("leaves a subscription alone that already follows the customer's card", async () => {
    const f = fakeStripe({ subs: [sub("sub_1", { default_payment_method: null }), sub("sub_2", { default_payment_method: "pm_new" })], invoices: { sub_1: [invoice("in_1", 1)], sub_2: [invoice("in_2", 1)] } });
    const r = await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");
    expect(f.of("invoices.pay")).toHaveLength(2);
    expect(f.of("subscriptions.update")).toHaveLength(0);
    expect(r).toMatchObject({ moved: [] });
  });

  it("acknowledges a decline, stops on that subscription, and still pays the next one", async () => {
    const f = fakeStripe({
      subs: [sub("sub_1"), sub("sub_2")],
      invoices: { sub_1: [invoice("in_a", 1), invoice("in_b", 2)], sub_2: [invoice("in_c", 1)] },
      pay: (id) => {
        if (id === "in_a") throw cardError("insufficient_funds");
        return { id, status: "paid" };
      },
    });
    const r = await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");

    // in_b is never tried: same card, same bank, same answer.
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_a", "in_c"]);
    expect(r).toMatchObject({
      attempted: true,
      attempts: [
        { subscription: "sub_1", invoice: "in_a", outcome: "declined", code: "insufficient_funds" },
        { subscription: "sub_2", invoice: "in_c", outcome: "paid" },
      ],
      moved: ["sub_2"],
    });
    // The declined one keeps its card; nothing paid on the new one yet.
    expect(f.of("subscriptions.update").map((c) => c.args[0])).toEqual(["sub_2"]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("insufficient_funds"));
  });

  it("treats Stripe refusing the invoice itself as an answer, not an outage", async () => {
    const f = fakeStripe({
      pay: () => {
        throw Object.assign(new Error("Invoice is already paid"), { type: "StripeInvalidRequestError", rawType: "invalid_request_error", code: "invoice_not_open" });
      },
    });
    const r = await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");
    expect(r).toMatchObject({ attempts: [{ invoice: "in_1", outcome: "refused", code: "invoice_not_open" }], moved: [] });
  });

  it("throws what a retry could fix, so the webhook asks Stripe to redeliver", async () => {
    const f = fakeStripe({
      pay: () => {
        throw Object.assign(new Error("connection reset"), { type: "StripeConnectionError" });
      },
    });
    await expect(payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1")).rejects.toThrow("connection reset");
  });

  it("does nothing without a default card", async () => {
    const f = fakeStripe({ customer: { id: "cus_1", invoice_settings: { default_payment_method: null } } });
    expect(await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1")).toEqual({ attempted: false, reason: "no_card" });
    expect(f.of("subscriptions.list")).toHaveLength(0);
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("does nothing for a deleted customer", async () => {
    const f = fakeStripe({ customer: { id: "cus_1", deleted: true } });
    expect(await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1")).toEqual({ attempted: false, reason: "customer_deleted" });
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("touches nothing when no subscription of ours is unpaid", async () => {
    // Only 'unpaid' is asked for; anything else Stripe hands back, and a
    // subscription made by hand with no hotel, are left alone regardless.
    const f = fakeStripe({ subs: [sub("sub_1", { status: "past_due" }), sub("sub_2", { metadata: {} })] });
    expect(await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1")).toEqual({ attempted: false, reason: "nothing_unpaid" });
    expect(f.of("invoices.list")).toHaveLength(0);
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("leaves an unpaid subscription alone once its hotel is on a newer one", async () => {
    // sub_old went unpaid, then a second checkout put the hotel on sub_new.
    // Paying sub_old would revive it beside sub_new and bill the hotel twice.
    const f = fakeStripe({
      subs: [sub("sub_old", { metadata: { hotel_id: "hotel-1" } })],
      invoices: { sub_old: [invoice("in_old", 1)] },
    });
    const { admin: moved, reads } = fakeAdmin({ "hotel-1": "sub_new" });
    const r = await payUnpaidAfterCardUpdate(moved, f.stripe, "cus_1");
    expect(reads).toEqual(["hotel_subscriptions:hotel-1"]);
    expect(r).toEqual({ attempted: false, reason: "superseded", superseded: ["sub_old"] });
    expect(f.of("invoices.list")).toHaveLength(0);
    expect(f.of("invoices.pay")).toHaveLength(0);
    expect(f.of("subscriptions.update")).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("stale_unpaid_not_revived"));
  });

  it("still pays the hotel's own unpaid subscription beside a stale one", async () => {
    const f = fakeStripe({
      subs: [sub("sub_old", { metadata: { hotel_id: "hotel-1" } }), sub("sub_2")],
      invoices: { sub_old: [invoice("in_old", 1)], sub_2: [invoice("in_2", 1)] },
    });
    const r = await payUnpaidAfterCardUpdate(fakeAdmin({ "hotel-1": "sub_new" }).admin, f.stripe, "cus_1");
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_2"]);
    expect(r).toMatchObject({ attempted: true, superseded: ["sub_old"], moved: ["sub_2"] });
  });

  it("pays nothing for a hotel with no subscription on record", async () => {
    const f = fakeStripe();
    const r = await payUnpaidAfterCardUpdate(fakeAdmin({ "hotel-sub_1": null }).admin, f.stripe, "cus_1");
    expect(r).toEqual({ attempted: false, reason: "superseded", superseded: ["sub_1"] });
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("throws when the hotel's subscription cannot be read, so Stripe redelivers", async () => {
    const f = fakeStripe();
    await expect(
      payUnpaidAfterCardUpdate(fakeAdmin({}, { message: "db down" }).admin, f.stripe, "cus_1"),
    ).rejects.toThrow("db down");
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("pays only invoices that are open", async () => {
    const f = fakeStripe({ invoices: { sub_1: [invoice("in_draft", 1, { status: "draft" }), invoice("in_open", 2)] } });
    await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_open"]);
  });

  it("reports an unpaid subscription with nothing open instead of paying anything", async () => {
    const f = fakeStripe({ invoices: { sub_1: [] } });
    const r = await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");
    expect(r).toMatchObject({ attempted: true, attempts: [], noOpenInvoice: ["sub_1"], moved: [] });
    expect(f.of("subscriptions.update")).toHaveLength(0);
  });

  it("keeps the payment when moving the card fails afterwards", async () => {
    const f = fakeStripe({
      update: () => {
        throw new Error("rate limited");
      },
    });
    const r = await payUnpaidAfterCardUpdate(admin, f.stripe, "cus_1");
    expect(r).toMatchObject({ attempts: [{ outcome: "paid" }], moved: [] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("move_subscription_to_new_card_by_hand"));
  });
});
