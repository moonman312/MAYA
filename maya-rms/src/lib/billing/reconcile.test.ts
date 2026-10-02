/**
 * The nightly Stripe check (A40): MAYA's copy of each subscription is re-read
 * from Stripe and corrected, a live subscription MAYA never heard of is
 * recorded, and a person is told whenever the copy was wrong, because that
 * means Stripe's messages are not getting through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

const watch = vi.hoisted(() => ({
  problems: [] as { key: string; title: string; hotelId?: string | null; detail: string }[],
  sweeps: [] as { job: string; detail: Record<string, unknown> }[],
  lastSweep: null as { at: string; detail: Record<string, unknown> } | null,
  followUps: [] as { sub: string; hotel: string; status: string }[],
}));

vi.mock("./problems", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./problems")>()),
  recordBillingProblem: async (_admin: unknown, p: { key: string; title: string; hotelId?: string | null; detail: string }) => {
    watch.problems.push(p);
    return { recorded: true };
  },
  recordBillingSweep: async (_admin: unknown, job: string, detail: Record<string, unknown>) => {
    watch.sweeps.push({ job, detail });
    return { recorded: true };
  },
  lastBillingSweep: async () => watch.lastSweep,
}));
vi.mock("./after-save", () => ({
  afterSubscriptionSaved: async (_a: unknown, _s: unknown, sub: { id: string }, row: { hotel_id: string; status: string }) => {
    watch.followUps.push({ sub: sub.id, hotel: row.hotel_id, status: row.status });
  },
}));

const { differences, sweepStripeReconcile } = await import("./reconcile");

const NOW = new Date("2026-10-01T08:40:00Z");
const PERIOD_END = Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000);

type Row = Record<string, unknown>;

/** hotel_subscriptions: the list the sweep reads, and the reads and upserts persistSubscription makes. */
function fakeAdmin(rows: Row[], opts: { readError?: string; upsertError?: string } = {}) {
  const upserts: Row[] = [];
  const admin = {
    from: () => {
      let hotel: string | null = null;
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === "hotel_id") hotel = String(val);
          return chain;
        },
        order: async () =>
          opts.readError ? { data: null, error: { message: opts.readError } } : { data: rows.map((r) => ({ ...r })), error: null },
        maybeSingle: async () => ({ data: rows.find((r) => r.hotel_id === hotel) ?? null, error: null }),
        upsert: async (row: Row) => {
          upserts.push(row);
          if (opts.upsertError) return { error: { message: opts.upsertError } };
          const at = rows.findIndex((r) => r.hotel_id === row.hotel_id);
          if (at >= 0) rows[at] = { ...rows[at], ...row };
          else rows.push(row);
          return { error: null };
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { admin, upserts };
}

function sub(o: Row = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    created: Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
    cancel_at_period_end: false,
    cancel_at: null,
    trial_end: null,
    metadata: { hotel_id: "hotel-1" },
    items: { data: [{ quantity: 20, current_period_end: PERIOD_END, price: { recurring: { interval: "month" } } }] },
    ...o,
  } as unknown as Stripe.Subscription;
}

/** What MAYA holds for a subscription matching sub(). */
function row(o: Row = {}): Row {
  return {
    hotel_id: "hotel-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    status: "active",
    billing_interval: "month",
    billed_rooms: 20,
    current_period_end: "2026-10-20T00:00:00+00:00",
    trial_end: null,
    cancel_at_period_end: false,
    ...o,
  };
}

function fakeStripe(subs: Record<string, Stripe.Subscription>, recent: Stripe.Subscription[] = [], opts: { retrieveError?: Error } = {}) {
  const retrieved: string[] = [];
  const lists: Record<string, unknown>[] = [];
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        retrieved.push(id);
        if (opts.retrieveError) throw opts.retrieveError;
        const found = subs[id];
        if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { statusCode: 404 });
        return found;
      },
      list: async (params: Record<string, unknown>) => {
        lists.push(params);
        return { data: recent, has_more: false };
      },
    },
  } as unknown as Stripe;
  return { stripe, retrieved, lists };
}

beforeEach(() => {
  watch.problems = [];
  watch.sweeps = [];
  watch.lastSweep = null;
  watch.followUps = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("differences", () => {
  it("names what matters, and keeps dates apart", () => {
    const fresh = { ...row(), status: "canceled", billed_rooms: 24, cancel_at_period_end: true, current_period_end: "2026-11-20T00:00:00.000Z" };
    const d = differences(row() as never, fresh as never);
    expect(d.important).toEqual(["status active → canceled", "rooms 20 → 24", "now set to cancel"]);
    expect(d.dates).toEqual(["period end"]);
  });

  it("reads the same moment written two ways as the same", () => {
    const fresh = { ...row(), current_period_end: "2026-10-20T00:00:00.000Z" };
    expect(differences(row() as never, fresh as never)).toEqual({ important: [], dates: [] });
  });
});

describe("sweepStripeReconcile", () => {
  it("leaves a matching copy alone and says it ran", async () => {
    const { admin, upserts } = fakeAdmin([row()]);
    const { stripe, lists } = fakeStripe({ sub_1: sub() });
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ examined: 1, matched: 1, corrected: 0, recovered: 0, failed: 0, partial: false });
    expect(upserts).toEqual([]);
    expect(watch.problems).toEqual([]);
    expect(watch.sweeps).toEqual([{ job: "stripe-reconcile", detail: expect.objectContaining({ examined: 1, matched: 1, cursor: null }) }]);
    // Only the last three days of new subscriptions, of every status.
    expect(lists[0]).toMatchObject({ status: "all", created: { gte: Math.floor((NOW.getTime() - 3 * 86_400_000) / 1000) } });
  });

  it("corrects a cancellation MAYA never heard about, and tells a person", async () => {
    // The owner cancelled; Stripe's message was refused. Without this the
    // property would be priced for ever.
    const { admin, upserts } = fakeAdmin([row()]);
    const { stripe } = fakeStripe({ sub_1: sub({ status: "canceled" }) });
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ corrected: 1, differences: [{ hotelId: "hotel-1", changes: ["status active → canceled"] }] });
    expect(upserts[0]).toMatchObject({ hotel_id: "hotel-1", status: "canceled" });
    expect(watch.problems).toEqual([
      expect.objectContaining({ key: "billing-drift:hotel-1", hotelId: "hotel-1", title: "MAYA's copy of a subscription was out of date" }),
    ]);
    expect(watch.problems[0].detail).toContain("status active → canceled");
    expect(watch.problems[0].detail).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("corrects a date that moved at renewal without bothering anyone", async () => {
    const { admin, upserts } = fakeAdmin([row({ current_period_end: "2026-09-20T00:00:00+00:00" })]);
    const { stripe } = fakeStripe({ sub_1: sub() });
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ corrected: 1, differences: [] });
    expect(upserts).toHaveLength(1);
    expect(watch.problems).toEqual([]);
  });

  it("never re-reads a subscription that is over", async () => {
    const { admin } = fakeAdmin([row({ status: "canceled" }), row({ hotel_id: "hotel-2", stripe_subscription_id: "sub_2", status: "incomplete_expired" })]);
    const { stripe, retrieved } = fakeStripe({});
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(retrieved).toEqual([]);
    expect(result.examined).toBe(0);
  });

  it("switches on a new customer whose messages never arrived", async () => {
    // Paid, closed the tab, and Stripe's messages were refused: only the
    // checkout page would have recorded it.
    const fresh = sub({ id: "sub_new", status: "trialing", metadata: { hotel_id: "hotel-new" } });
    const { admin, upserts } = fakeAdmin([]);
    const { stripe } = fakeStripe({}, [fresh]);
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ recovered: 1 });
    expect(upserts[0]).toMatchObject({ hotel_id: "hotel-new", stripe_subscription_id: "sub_new", status: "trialing" });
    // And what the webhook would have done next: go live, the welcome email.
    expect(watch.followUps).toEqual([{ sub: "sub_new", hotel: "hotel-new", status: "trialing" }]);
    expect(watch.problems.map((p) => p.key)).toEqual(["billing-drift:hotel-new"]);
  });

  it("records nothing for a new subscription that is not live, or that our checkout did not make", async () => {
    const { admin, upserts } = fakeAdmin([]);
    const { stripe } = fakeStripe({}, [
      sub({ id: "sub_inc", status: "incomplete", metadata: { hotel_id: "hotel-a" } }),
      sub({ id: "sub_hand", metadata: {} }),
    ]);
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result.recovered).toBe(0);
    expect(upserts).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  it("does not swap one live subscription for another: that is a double charge for a person", async () => {
    const { admin, upserts } = fakeAdmin([row()]);
    const { stripe } = fakeStripe({ sub_1: sub() }, [sub({ id: "sub_twin" })]);
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result.recovered).toBe(0);
    expect(upserts).toEqual([]);
    expect(watch.problems).toEqual([
      expect.objectContaining({ key: "billing-duplicate-subscription:hotel-1", title: "Two live subscriptions on one property" }),
    ]);
  });

  it("takes a newer live subscription in place of one that ended", async () => {
    const { admin, upserts } = fakeAdmin([row({ status: "canceled", stripe_subscription_id: "sub_old" })]);
    const { stripe } = fakeStripe({}, [sub({ id: "sub_again" })]);
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result.recovered).toBe(1);
    expect(upserts[0]).toMatchObject({ stripe_subscription_id: "sub_again", status: "active" });
  });

  it("tells a person once when subscriptions cannot be read, and carries on with the rest", async () => {
    const { admin } = fakeAdmin([row(), row({ hotel_id: "hotel-2", stripe_subscription_id: "sub_missing" })]);
    const { stripe } = fakeStripe({ sub_1: sub() });
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ examined: 2, matched: 1, failed: 1 });
    expect(watch.problems).toEqual([
      expect.objectContaining({ key: "billing-reconcile-failed", title: "The nightly Stripe check could not check every subscription" }),
    ]);
    expect(watch.problems[0].detail).toContain("sub_missing");
  });

  it("says so when MAYA's own list cannot be read, and still reports the run", async () => {
    const { admin } = fakeAdmin([], { readError: "timeout" });
    const { stripe, retrieved } = fakeStripe({});
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result.errors).toEqual(["timeout"]);
    expect(retrieved).toEqual([]);
    expect(watch.problems.map((p) => p.key)).toEqual(["billing-sweep-failed:stripe-reconcile"]);
    expect(watch.sweeps).toEqual([{ job: "stripe-reconcile", detail: { examined: 0, error: "timeout" } }]);
  });

  it("stops at its time budget and the next run carries on where it stopped", async () => {
    const rows = ["a", "b", "c", "d"].map((h) => row({ hotel_id: `hotel-${h}`, stripe_subscription_id: `sub_${h}` }));
    const subs = Object.fromEntries(["a", "b", "c", "d"].map((h) => [`sub_${h}`, sub({ id: `sub_${h}`, metadata: { hotel_id: `hotel-${h}` } })]));
    let t = 0;
    const clock = () => (t += 10);

    const first = fakeStripe(subs);
    const r1 = await sweepStripeReconcile({ admin: fakeAdmin(rows).admin, stripe: first.stripe, now: NOW, budgetMs: 25, clock });
    expect(r1.partial).toBe(true);
    expect(first.retrieved).toEqual(["sub_a", "sub_b"]);
    expect(watch.sweeps.at(-1)?.detail).toMatchObject({ partial: true, cursor: "hotel-b" });

    watch.lastSweep = { at: NOW.toISOString(), detail: watch.sweeps.at(-1)!.detail };
    t = 0;
    const second = fakeStripe(subs);
    await sweepStripeReconcile({ admin: fakeAdmin(rows).admin, stripe: second.stripe, now: NOW, budgetMs: 1000, clock });
    expect(second.retrieved).toEqual(["sub_c", "sub_d", "sub_a", "sub_b"]);
    expect(watch.sweeps.at(-1)?.detail).toMatchObject({ partial: false, cursor: null });
  });

  it("counts a write that fails as a failure, without following it up", async () => {
    const { admin } = fakeAdmin([row()], { upsertError: "deadlock" });
    const { stripe } = fakeStripe({ sub_1: sub({ status: "past_due" }) });
    const result = await sweepStripeReconcile({ admin, stripe, now: NOW });
    expect(result).toMatchObject({ corrected: 0, failed: 1 });
    expect(watch.followUps).toEqual([]);
    expect(watch.problems.map((p) => p.key)).toEqual(["billing-reconcile-failed"]);
  });
});
