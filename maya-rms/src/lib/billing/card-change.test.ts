/**
 * The owner saves a new default card in the billing portal. These pin down
 * what follows (A35): subscriptions on the old default card (or, when there
 * was no default, on the one card every one of them carries) move to the new card,
 * subscriptions with no card of their own already follow it, a subscription
 * on a different card of its own is never touched, and every overdue one that
 * moved or follows has its open invoice paid with the new card at once. Only
 * the subscription each hotel is on today counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  defaultCardChanged,
  followNewDefaultCard,
  oldCardFor,
  planFor,
  previousDefaultCard,
  stampedMoveFrom,
} from "./card-change";

type Call = { op: string; args: unknown[] };

function invoice(id: string, created: number, o: Record<string, unknown> = {}) {
  return { id, object: "invoice", status: "open", created, ...o };
}

function sub(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    object: "subscription",
    status: "past_due",
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
  retrieve?: (id: string) => unknown;
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
        return { data: o.subs ?? [sub("sub_1")], has_more: false };
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
      retrieve: async (...args: unknown[]) => {
        calls.push({ op: "invoices.retrieve", args });
        return o.retrieve ? o.retrieve(String(args[0])) : { id: args[0], status: "open" };
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

/** What was handed to a person through the billing watchdog (problems.ts). */
const handed = vi.hoisted(() => [] as { key: string; title: string; hotelId?: string | null; detail: string }[]);
vi.mock("./problems", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./problems")>()),
  recordBillingProblem: async (_admin: unknown, problem: { key: string; title: string; hotelId?: string | null; detail: string }) => {
    handed.push(problem);
    return { recorded: true };
  },
}));

/** The owner had pm_old as the default and saved pm_new. */
const fromOld = { previousCard: "pm_old", eventId: "evt_1" };
/** The customer had no default card before (Checkout never sets one). */
const fromNone = { previousCard: null, eventId: "evt_1" };

const cardError = (code: string) =>
  Object.assign(new Error("Your card was declined."), { type: "StripeCardError", rawType: "card_error", code: "card_declined", decline_code: code });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  handed.length = 0;
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

describe("previousDefaultCard", () => {
  it("reads the old card off the event, as an id or an object", () => {
    expect(previousDefaultCard({ invoice_settings: { default_payment_method: "pm_old" } })).toBe("pm_old");
    expect(previousDefaultCard({ invoice_settings: { default_payment_method: { id: "pm_obj" } } })).toBe("pm_obj");
  });

  it("is null when there was no default before, or the event says nothing", () => {
    expect(previousDefaultCard({ invoice_settings: { default_payment_method: null } })).toBeNull();
    expect(previousDefaultCard({ email: "x" })).toBeNull();
    expect(previousDefaultCard(undefined)).toBeNull();
  });
});

describe("oldCardFor", () => {
  const cards = (...own: (string | null)[]) => own.map((c) => ({ own: c }));

  it("is the customer's old default when it had one", () => {
    expect(oldCardFor("pm_old", cards("pm_other", "pm_third"), "pm_new")).toEqual({ card: "pm_old", ambiguous: false });
  });

  it("is the one card every subscription carries when there was no default", () => {
    expect(oldCardFor(null, cards("pm_a", "pm_a"), "pm_new")).toEqual({ card: "pm_a", ambiguous: false });
  });

  it("counts a subscription MAYA moved for this change as still on its old card, so a redelivery reaches the same answer", () => {
    expect(oldCardFor(null, [{ own: "pm_a" }, { own: "pm_new", movedFrom: "pm_a" }], "pm_new")).toEqual({ card: "pm_a", ambiguous: false });
  });

  it("is unknown when one subscription is on the new card by any other way", () => {
    // A group property paid with that card on purpose, or the portal moving it.
    expect(oldCardFor(null, cards("pm_a", "pm_new"), "pm_new")).toEqual({ card: null, ambiguous: true });
  });

  it("is unknown when one subscription has no card of its own beside one that has", () => {
    expect(oldCardFor(null, cards("pm_a", "pm_a", null), "pm_new")).toEqual({ card: null, ambiguous: true });
    expect(oldCardFor(null, cards(null, "pm_a"), "pm_new")).toEqual({ card: null, ambiguous: true });
  });

  it("is unknown when there was no default and the subscriptions are on different cards", () => {
    expect(oldCardFor(null, cards("pm_a", "pm_b"), "pm_new")).toEqual({ card: null, ambiguous: true });
  });

  it("is nothing when no subscription has a card of its own, or all are on the new card", () => {
    expect(oldCardFor(null, cards(null, null), "pm_new")).toEqual({ card: null, ambiguous: false });
    expect(oldCardFor(null, cards("pm_new", null), "pm_new")).toEqual({ card: null, ambiguous: false });
  });
});

describe("stampedMoveFrom", () => {
  it("reads the card a move came from only off a stamp of the same event", () => {
    const meta = { hotel_id: "h", maya_card_moved_from: "pm_a", maya_card_moved_event: "evt_1" };
    expect(stampedMoveFrom(meta, "evt_1")).toBe("pm_a");
    expect(stampedMoveFrom(meta, "evt_2")).toBeNull();
    expect(stampedMoveFrom(meta, undefined)).toBeNull();
    expect(stampedMoveFrom({ hotel_id: "h" }, "evt_1")).toBeNull();
  });
});

describe("planFor", () => {
  it("moves only a subscription on the old default card", () => {
    expect(planFor("pm_old", "pm_new", "pm_old")).toBe("move");
    expect(planFor(null, "pm_new", "pm_old")).toBe("follows");
    expect(planFor("pm_new", "pm_new", "pm_old")).toBe("already");
    expect(planFor("pm_mine", "pm_new", "pm_old")).toBe("own_card");
    expect(planFor("pm_mine", "pm_new", null)).toBe("own_card");
  });
});

describe("followNewDefaultCard", () => {
  it("moves a subscription on the old default card, then pays its overdue invoices oldest first", async () => {
    const f = fakeStripe({ invoices: { sub_1: [invoice("in_new", 300), invoice("in_old", 100)] } });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);

    expect(f.of("subscriptions.list")[0].args[0]).toEqual({ customer: "cus_1", limit: 100 });
    expect(f.of("subscriptions.update").map((c) => c.args)).toEqual([
      [
        "sub_1",
        { default_payment_method: "pm_new", metadata: { maya_card_moved_from: "pm_old", maya_card_moved_event: "evt_1" } },
        { idempotencyKey: "maya_card_move_evt_1_sub_1_pm_new" },
      ],
    ]);
    expect(f.of("invoices.list")[0].args[0]).toMatchObject({ subscription: "sub_1", status: "open" });
    expect(f.of("invoices.pay").map((c) => c.args)).toEqual([
      ["in_old", { payment_method: "pm_new", off_session: true }, { idempotencyKey: "maya_overdue_pay_in_old_pm_new" }],
      ["in_new", { payment_method: "pm_new", off_session: true }, { idempotencyKey: "maya_overdue_pay_in_new_pm_new" }],
    ]);
    // Moved before it is paid, so Stripe's own retries use the new card too
    // if this payment is declined.
    const order = f.calls.map((c) => c.op).filter((op) => op === "subscriptions.update" || op === "invoices.pay");
    expect(order[0]).toBe("subscriptions.update");
    expect(r).toMatchObject({
      acted: true,
      card: "pm_new",
      oldCard: "pm_old",
      moved: ["sub_1"],
      kept: [],
      attempts: [
        { subscription: "sub_1", hotel: "hotel-sub_1", invoice: "in_old", outcome: "paid" },
        { subscription: "sub_1", hotel: "hotel-sub_1", invoice: "in_new", outcome: "paid" },
      ],
    });
  });

  it("pays an unpaid subscription the same way (G22)", async () => {
    const f = fakeStripe({ subs: [sub("sub_1", { status: "unpaid" })] });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_1"]);
    expect(r).toMatchObject({ moved: ["sub_1"], attempts: [{ outcome: "paid" }] });
  });

  it("moves an active or trialing subscription without paying anything", async () => {
    // The trial case: a card that failed the 48-hour check is replaced, and
    // the charge at the end of the trial must come from the new one.
    const f = fakeStripe({ subs: [sub("sub_1", { status: "active" }), sub("sub_2", { status: "trialing" })] });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(f.of("subscriptions.update").map((c) => c.args[0])).toEqual(["sub_1", "sub_2"]);
    expect(f.of("invoices.list")).toHaveLength(0);
    expect(f.of("invoices.pay")).toHaveLength(0);
    expect(r).toMatchObject({ moved: ["sub_1", "sub_2"], attempts: [] });
  });

  it("never touches a subscription on a different card of its own, even an overdue one", async () => {
    // A group: The Harbour Inn on the owner's card, the guesthouse on a card
    // of its own on purpose.
    const f = fakeStripe({
      subs: [sub("sub_inn"), sub("sub_guest", { default_payment_method: "pm_guesthouse" })],
      invoices: { sub_inn: [invoice("in_inn", 1)], sub_guest: [invoice("in_guest", 1)] },
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(f.of("subscriptions.update").map((c) => c.args[0])).toEqual(["sub_inn"]);
    expect(f.of("invoices.list").map((c) => (c.args[0] as { subscription: string }).subscription)).toEqual(["sub_inn"]);
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_inn"]);
    expect(r).toMatchObject({ moved: ["sub_inn"], kept: ["sub_guest"] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("own_card_left_alone"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"overdue":true'));
  });

  it("takes the one card all the subscriptions share as the old default when there was none", async () => {
    // Checkout puts the card on each subscription and never sets a customer
    // default, so the first card saved in the portal is a change from none.
    const f = fakeStripe({
      subs: [sub("sub_1", { default_payment_method: "pm_checkout" }), sub("sub_2", { default_payment_method: "pm_checkout", status: "active" })],
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromNone);
    expect(f.of("subscriptions.update").map((c) => c.args[0])).toEqual(["sub_1", "sub_2"]);
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_1"]);
    expect(r).toMatchObject({ oldCard: "pm_checkout", ambiguous: false, moved: ["sub_1", "sub_2"], kept: [] });
  });

  it("leaves every subscription with its own card alone when there was no default and they differ", async () => {
    const f = fakeStripe({
      subs: [
        sub("sub_1", { default_payment_method: "pm_a" }),
        sub("sub_2", { default_payment_method: "pm_b" }),
        sub("sub_3", { default_payment_method: null }),
      ],
      invoices: { sub_1: [invoice("in_1", 1)], sub_2: [invoice("in_2", 1)], sub_3: [invoice("in_3", 1)] },
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromNone);
    expect(f.of("subscriptions.update")).toHaveLength(0);
    // The one with no card of its own already follows the new default.
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_3"]);
    expect(r).toMatchObject({ oldCard: null, ambiguous: true, moved: [], kept: ["sub_1", "sub_2"] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("old_card_unknown_left_alone"));
  });

  it("never moves a group property off its own card when another one already sits on the new card (no default before)", async () => {
    // A group under one customer, no default: The Harbour Inn on pm_x, the
    // guesthouse on pm_n on purpose. The owner makes pm_n the default.
    const f = fakeStripe({
      subs: [
        sub("sub_inn", { status: "active", default_payment_method: "pm_x" }),
        sub("sub_guest", { status: "active", default_payment_method: "pm_n" }),
      ],
      customer: { id: "cus_1", invoice_settings: { default_payment_method: "pm_n" } },
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromNone);
    expect(f.of("subscriptions.update")).toHaveLength(0);
    expect(r).toMatchObject({ oldCard: null, ambiguous: true, moved: [], kept: ["sub_inn"] });

    // And the other way round: making pm_x the default moves nobody either.
    const g = fakeStripe({
      subs: [
        sub("sub_inn", { status: "active", default_payment_method: "pm_x" }),
        sub("sub_guest", { status: "active", default_payment_method: "pm_n" }),
      ],
      customer: { id: "cus_1", invoice_settings: { default_payment_method: "pm_x" } },
    });
    const again = await followNewDefaultCard(admin, g.stripe, "cus_1", fromNone);
    expect(g.of("subscriptions.update")).toHaveLength(0);
    expect(again).toMatchObject({ ambiguous: true, moved: [], kept: ["sub_guest"] });
  });

  it("leaves the one on its own card alone when the portal itself moved the overdue one to the new card, and pays the overdue one", async () => {
    // The proof's setup: overdue sub on the failing card, the other on its own
    // Mastercard, no default. The portal put the overdue one on pm_new itself.
    const f = fakeStripe({
      subs: [
        sub("sub_overdue", { status: "past_due", default_payment_method: "pm_new" }),
        sub("sub_own", { status: "active", default_payment_method: "pm_mastercard" }),
      ],
      invoices: { sub_overdue: [invoice("in_due", 1)] },
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromNone);
    expect(f.of("subscriptions.update")).toHaveLength(0);
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_due"]);
    expect(r).toMatchObject({ ambiguous: true, moved: [], kept: ["sub_own"] });
  });

  it("leaves the one on its own card alone when the portal cleared the overdue one's card, and pays the overdue one", async () => {
    const f = fakeStripe({
      subs: [
        sub("sub_overdue", { status: "past_due", default_payment_method: null }),
        sub("sub_own", { status: "active", default_payment_method: "pm_mastercard" }),
      ],
      invoices: { sub_overdue: [invoice("in_due", 1)] },
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromNone);
    expect(f.of("subscriptions.update")).toHaveLength(0);
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_due"]);
    expect(r).toMatchObject({ ambiguous: true, moved: [], kept: ["sub_own"] });
  });

  it("finishes a half-done move on redelivery: the one MAYA moved for this event still counts as on the old card", async () => {
    // First delivery moved sub_1 and died before sub_2. The stamp says so.
    const f = fakeStripe({
      subs: [
        sub("sub_1", {
          status: "active",
          default_payment_method: "pm_new",
          metadata: { hotel_id: "hotel-sub_1", maya_card_moved_from: "pm_checkout", maya_card_moved_event: "evt_1" },
        }),
        sub("sub_2", { status: "active", default_payment_method: "pm_checkout" }),
      ],
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromNone);
    expect(f.of("subscriptions.update").map((c) => c.args[0])).toEqual(["sub_2"]);
    expect(r).toMatchObject({ oldCard: "pm_checkout", ambiguous: false, moved: ["sub_2"], kept: [] });

    // A stamp from another change proves nothing about this one.
    const g = fakeStripe({
      subs: [
        sub("sub_1", {
          status: "active",
          default_payment_method: "pm_new",
          metadata: { hotel_id: "hotel-sub_1", maya_card_moved_from: "pm_checkout", maya_card_moved_event: "evt_0" },
        }),
        sub("sub_2", { status: "active", default_payment_method: "pm_checkout" }),
      ],
    });
    const other = await followNewDefaultCard(admin, g.stripe, "cus_1", fromNone);
    expect(g.of("subscriptions.update")).toHaveLength(0);
    expect(other).toMatchObject({ ambiguous: true, kept: ["sub_2"] });
  });

  it("pays an overdue subscription that already follows the default or sits on the new card, without moving it", async () => {
    const f = fakeStripe({
      subs: [sub("sub_1", { default_payment_method: null }), sub("sub_2", { default_payment_method: "pm_new" })],
      invoices: { sub_1: [invoice("in_1", 1)], sub_2: [invoice("in_2", 1)] },
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(f.of("invoices.pay")).toHaveLength(2);
    expect(f.of("subscriptions.update")).toHaveLength(0);
    expect(r).toMatchObject({ moved: [] });
  });

  it("is safe on redelivery: a subscription already moved is not moved again, and the payment replays its key", async () => {
    const first = fakeStripe();
    await followNewDefaultCard(admin, first.stripe, "cus_1", fromOld);
    // Stripe redelivers. The subscription is on pm_new now, and the invoice
    // was paid; had it still been open, the same key asks Stripe for its
    // first answer rather than a second charge.
    const again = fakeStripe({
      subs: [sub("sub_1", { default_payment_method: "pm_new", status: "active" })],
    });
    const r = await followNewDefaultCard(admin, again.stripe, "cus_1", fromOld);
    expect(again.of("subscriptions.update")).toHaveLength(0);
    expect(again.of("invoices.pay")).toHaveLength(0);
    expect(r).toMatchObject({ acted: true, moved: [], kept: [] });
    const half = fakeStripe({ subs: [sub("sub_1", { default_payment_method: "pm_new" })] });
    await followNewDefaultCard(admin, half.stripe, "cus_1", fromOld);
    expect(half.of("invoices.pay")[0].args[2]).toEqual(first.of("invoices.pay")[0].args[2]);
  });

  it("reads the default card back from Stripe rather than trusting the event", async () => {
    const f = fakeStripe({
      customer: { id: "cus_1", invoice_settings: { default_payment_method: { id: "pm_latest", object: "payment_method" } } },
    });
    await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(f.of("customers.retrieve")[0].args[0]).toBe("cus_1");
    expect(f.of("subscriptions.update")[0].args[1]).toMatchObject({ default_payment_method: "pm_latest" });
    expect(f.of("invoices.pay")[0].args[1]).toEqual({ payment_method: "pm_latest", off_session: true });
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
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);

    // in_b is never tried: same card, same bank, same answer.
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_a", "in_c"]);
    expect(r).toMatchObject({
      acted: true,
      attempts: [
        { subscription: "sub_1", invoice: "in_a", outcome: "declined", code: "insufficient_funds" },
        { subscription: "sub_2", invoice: "in_c", outcome: "paid" },
      ],
      // Both were on the old card, so both move whatever the bank said.
      moved: ["sub_1", "sub_2"],
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("insufficient_funds"));
    // The owner may not know their new card was declined too: a person does.
    expect(handed).toEqual([
      expect.objectContaining({ key: "billing-card-change:sub_1", hotelId: "hotel-sub_1", title: "A new card was declined on an overdue subscription" }),
    ]);
    expect(handed[0].detail).toContain("in_a");
    expect(handed[0].detail).toContain("insufficient_funds");
  });

  it("treats Stripe refusing the invoice itself as an answer, not an outage, and not as a declined card", async () => {
    const f = fakeStripe({
      pay: () => {
        throw Object.assign(new Error("This invoice can no longer be paid"), { type: "StripeInvalidRequestError", rawType: "invalid_request_error", code: "invoice_not_open" });
      },
      retrieve: (id) => ({ id, status: "uncollectible" }),
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(r).toMatchObject({ attempts: [{ invoice: "in_1", outcome: "refused", code: "invoice_not_open" }], moved: ["sub_1"] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("invoice_not_payable"));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("still_overdue_owner_needs_another_card"));
    expect(handed.map((p) => [p.key, p.title])).toEqual([
      ["billing-card-change:sub_1", "Stripe would not take payment for an overdue invoice"],
    ]);
  });

  it("counts an invoice Stripe's own retry paid first as already paid, raises nothing, and goes on to the next", async () => {
    // Stripe's retry (or the portal's pay button) won the race for in_a.
    const f = fakeStripe({
      invoices: { sub_1: [invoice("in_a", 1), invoice("in_b", 2)] },
      pay: (id) => {
        if (id === "in_a") {
          throw Object.assign(new Error("Invoice is already paid"), { type: "StripeInvalidRequestError", rawType: "invalid_request_error", code: "invoice_already_paid" });
        }
        return { id, status: "paid" };
      },
      retrieve: (id) => ({ id, status: "paid" }),
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_a", "in_b"]);
    expect(r).toMatchObject({
      attempts: [
        { invoice: "in_a", outcome: "already_paid", code: "invoice_already_paid" },
        { invoice: "in_b", outcome: "paid" },
      ],
    });
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("still_overdue_owner_needs_another_card"));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("invoice_not_payable"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("invoice_already_paid"));
  });

  it("keeps a refusal as a refusal when the invoice cannot be read back", async () => {
    const f = fakeStripe({
      pay: () => {
        throw Object.assign(new Error("nope"), { type: "StripeInvalidRequestError", rawType: "invalid_request_error", code: "invoice_not_open" });
      },
      retrieve: () => {
        throw Object.assign(new Error("connection reset"), { type: "StripeConnectionError" });
      },
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(r).toMatchObject({ attempts: [{ outcome: "refused" }] });
  });

  it("throws what a retry could fix, so the webhook asks Stripe to redeliver", async () => {
    const f = fakeStripe({
      pay: () => {
        throw Object.assign(new Error("connection reset"), { type: "StripeConnectionError" });
      },
    });
    await expect(followNewDefaultCard(admin, f.stripe, "cus_1", fromOld)).rejects.toThrow("connection reset");
  });

  it("throws when a move fails for a reason a retry could fix", async () => {
    const f = fakeStripe({
      update: () => {
        throw Object.assign(new Error("rate limited"), { type: "StripeRateLimitError" });
      },
    });
    await expect(followNewDefaultCard(admin, f.stripe, "cus_1", fromOld)).rejects.toThrow("rate limited");
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("logs a move Stripe refuses for a person to do, and still pays with the new card", async () => {
    const f = fakeStripe({
      update: () => {
        throw Object.assign(new Error("No such PaymentMethod"), { type: "StripeInvalidRequestError", rawType: "invalid_request_error", code: "resource_missing" });
      },
    });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(r).toMatchObject({ moved: [], moveRefused: ["sub_1"], attempts: [{ outcome: "paid" }] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("move_subscription_to_new_card_by_hand"));
    expect(handed.map((p) => p.title)).toEqual(["Stripe would not move a subscription onto the new card"]);
  });

  it("sends no idempotency key on a move when there is no event to key it on", async () => {
    const f = fakeStripe();
    await followNewDefaultCard(admin, f.stripe, "cus_1", { previousCard: "pm_old" });
    expect(f.of("subscriptions.update")[0].args[2]).toBeUndefined();
  });

  it("does nothing without a default card", async () => {
    const f = fakeStripe({ customer: { id: "cus_1", invoice_settings: { default_payment_method: null } } });
    expect(await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld)).toEqual({ acted: false, reason: "no_card" });
    expect(f.of("subscriptions.list")).toHaveLength(0);
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("does nothing for a deleted customer", async () => {
    const f = fakeStripe({ customer: { id: "cus_1", deleted: true } });
    expect(await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld)).toEqual({ acted: false, reason: "customer_deleted" });
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("touches nothing that no longer bills, or that our checkout did not make", async () => {
    const f = fakeStripe({
      subs: [
        sub("sub_1", { status: "canceled" }),
        sub("sub_2", { status: "incomplete_expired" }),
        sub("sub_3", { status: "paused" }),
        sub("sub_4", { metadata: {} }),
      ],
    });
    expect(await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld)).toEqual({ acted: false, reason: "no_subscriptions" });
    expect(f.of("subscriptions.update")).toHaveLength(0);
    expect(f.of("invoices.list")).toHaveLength(0);
    expect(f.of("invoices.pay")).toHaveLength(0);
  });

  it("leaves a subscription alone once its hotel is on a newer one", async () => {
    // sub_old went unpaid, then a second checkout put the hotel on sub_new.
    // Paying or moving sub_old would revive it beside sub_new and bill twice.
    const f = fakeStripe({
      subs: [sub("sub_old", { status: "unpaid", metadata: { hotel_id: "hotel-1" } })],
      invoices: { sub_old: [invoice("in_old", 1)] },
    });
    const { admin: moved, reads } = fakeAdmin({ "hotel-1": "sub_new" });
    const r = await followNewDefaultCard(moved, f.stripe, "cus_1", fromOld);
    expect(reads).toEqual(["hotel_subscriptions:hotel-1"]);
    expect(r).toEqual({ acted: false, reason: "superseded", superseded: ["sub_old"] });
    expect(f.of("invoices.list")).toHaveLength(0);
    expect(f.of("invoices.pay")).toHaveLength(0);
    expect(f.of("subscriptions.update")).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("stale_subscription_not_touched"));
  });

  it("still acts on the hotel's own subscription beside a stale one", async () => {
    const f = fakeStripe({
      subs: [sub("sub_old", { status: "unpaid", metadata: { hotel_id: "hotel-1" } }), sub("sub_2")],
      invoices: { sub_old: [invoice("in_old", 1)], sub_2: [invoice("in_2", 1)] },
    });
    const r = await followNewDefaultCard(fakeAdmin({ "hotel-1": "sub_new" }).admin, f.stripe, "cus_1", fromOld);
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_2"]);
    expect(f.of("subscriptions.update").map((c) => c.args[0])).toEqual(["sub_2"]);
    expect(r).toMatchObject({ acted: true, superseded: ["sub_old"], moved: ["sub_2"] });
  });

  it("a stale subscription's card does not count toward the shared card when there was no default", async () => {
    const f = fakeStripe({
      subs: [
        sub("sub_old", { default_payment_method: "pm_dead", metadata: { hotel_id: "hotel-1" } }),
        sub("sub_2", { default_payment_method: "pm_checkout" }),
      ],
      invoices: { sub_2: [invoice("in_2", 1)] },
    });
    const r = await followNewDefaultCard(fakeAdmin({ "hotel-1": "sub_new" }).admin, f.stripe, "cus_1", fromNone);
    expect(r).toMatchObject({ oldCard: "pm_checkout", moved: ["sub_2"], superseded: ["sub_old"] });
  });

  it("acts on nothing for a hotel with no subscription on record", async () => {
    const f = fakeStripe();
    const r = await followNewDefaultCard(fakeAdmin({ "hotel-sub_1": null }).admin, f.stripe, "cus_1", fromOld);
    expect(r).toEqual({ acted: false, reason: "superseded", superseded: ["sub_1"] });
    expect(f.of("invoices.pay")).toHaveLength(0);
    expect(f.of("subscriptions.update")).toHaveLength(0);
  });

  it("throws when the hotel's subscription cannot be read, so Stripe redelivers", async () => {
    const f = fakeStripe();
    await expect(
      followNewDefaultCard(fakeAdmin({}, { message: "db down" }).admin, f.stripe, "cus_1", fromOld),
    ).rejects.toThrow("db down");
    expect(f.of("invoices.pay")).toHaveLength(0);
    expect(f.of("subscriptions.update")).toHaveLength(0);
  });

  it("pays only invoices that are open", async () => {
    const f = fakeStripe({ invoices: { sub_1: [invoice("in_draft", 1, { status: "draft" }), invoice("in_open", 2)] } });
    await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(f.of("invoices.pay").map((c) => c.args[0])).toEqual(["in_open"]);
  });

  it("reports an overdue subscription with nothing open instead of paying anything", async () => {
    const f = fakeStripe({ invoices: { sub_1: [] } });
    const r = await followNewDefaultCard(admin, f.stripe, "cus_1", fromOld);
    expect(r).toMatchObject({ acted: true, attempts: [], noOpenInvoice: ["sub_1"], moved: ["sub_1"] });
    expect(handed.map((p) => [p.key, p.title])).toEqual([
      ["billing-card-change:sub_1", "An overdue subscription has no open invoice to pay"],
    ]);
  });

  it("hands nothing to a person when every overdue invoice was paid", async () => {
    await followNewDefaultCard(admin, fakeStripe().stripe, "cus_1", fromOld);
    expect(handed).toEqual([]);
  });
});
