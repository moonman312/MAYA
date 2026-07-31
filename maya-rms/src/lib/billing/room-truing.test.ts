/**
 * The only job in MAYA that increases what a customer pays without them asking.
 *
 * Two rules matter more than the arithmetic: nobody is charged before being told
 * about that exact number, and nobody is charged for a space they don't sleep
 * guests in. Everything below is one of those two.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dueForTruing, shortfallsNeedingNotice, trueUpOne, type ShortfallRow } from "./room-truing";
import { ROOM_SHORTFALL_GRACE_DAYS } from "./room-count";
import { MAX_ROOMS } from "./tiers";

const NOW = new Date("2026-08-10T12:00:00Z");
/** Comfortably outside the grace window. */
const LONG_AGO = "2026-07-01T12:00:00Z";

function row(o: Partial<ShortfallRow> = {}): ShortfallRow {
  return {
    hotel_id: "hotel-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    billing_interval: "month",
    billed_rooms: 20,
    measured_rooms: 60,
    room_shortfall_since: LONG_AGO,
    // Warned about this exact count — the default is an eligible row.
    room_shortfall_notified_at: LONG_AGO,
    room_shortfall_notified_rooms: 60,
    ...o,
  };
}

function fakeStripe(quantity = 20) {
  const updates: { id: string; params: Record<string, unknown>; options?: Record<string, unknown> }[] = [];
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => ({ id, items: { data: [{ id: "si_1", quantity }] } }),
      update: async (id: string, params: Record<string, unknown>, options?: Record<string, unknown>) => {
        updates.push({ id, params, options });
        return {};
      },
    },
  };
  return { stripe: stripe as unknown as Stripe, updates };
}

function fakeAdmin() {
  const patches: Record<string, unknown>[] = [];
  const admin = {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async () => {
          patches.push(patch);
          return { error: null };
        },
      }),
    }),
  };
  return { admin: admin as unknown as SupabaseClient, patches };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("nobody is charged more without having been told", () => {
  it("refuses to correct a property that was never emailed", async () => {
    // No email configured, no address on the customer, a Resend outage — in all
    // of them the grace period expiring means nothing, because the clock the
    // owner was supposed to be racing was never shown to them.
    const { stripe, updates } = fakeStripe();
    const { admin } = fakeAdmin();
    const outcome = await trueUpOne(
      admin,
      stripe,
      row({ room_shortfall_notified_at: null, room_shortfall_notified_rooms: null }),
      NOW,
    );
    expect(outcome).toEqual({ kind: "skipped", reason: "not_yet_notified" });
    expect(updates).toHaveLength(0);
  });

  it("refuses when the warning quoted a DIFFERENT number", async () => {
    // Told about 25 rooms, now measured at 60: they have not been told about 60,
    // and 60 is what the invoice would say.
    const { stripe, updates } = fakeStripe();
    const { admin } = fakeAdmin();
    const outcome = await trueUpOne(admin, stripe, row({ room_shortfall_notified_rooms: 25 }), NOW);
    expect(outcome).toEqual({ kind: "skipped", reason: "not_yet_notified" });
    expect(updates).toHaveLength(0);
  });

  it("corrects once the warning matches the measurement", async () => {
    const { stripe, updates } = fakeStripe();
    const { admin } = fakeAdmin();
    expect(await trueUpOne(admin, stripe, row(), NOW)).toEqual({ kind: "corrected", from: 20, to: 60 });
    expect(updates[0].params).toMatchObject({ items: [{ id: "si_1", quantity: 60 }] });
  });
});

describe("the grace period is real", () => {
  it("does nothing while the clock is still running", async () => {
    const { stripe, updates } = fakeStripe();
    const { admin } = fakeAdmin();
    const started = new Date(NOW.getTime() - (ROOM_SHORTFALL_GRACE_DAYS - 1) * 86_400_000).toISOString();
    const outcome = await trueUpOne(admin, stripe, row({ room_shortfall_since: started }), NOW);
    expect(outcome).toEqual({ kind: "skipped", reason: "in_grace" });
    expect(updates).toHaveLength(0);
  });
});

describe("how the correction is charged", () => {
  it("prorates onto the next invoice rather than charging today", async () => {
    // A fair adjustment that arrives as a same-day charge is a chargeback.
    const { stripe, updates } = fakeStripe();
    const { admin } = fakeAdmin();
    await trueUpOne(admin, stripe, row(), NOW);
    expect(updates[0].params).toMatchObject({ proration_behavior: "create_prorations" });
  });

  it("keys the update so an overlapping sweep can't raise it twice", async () => {
    const { stripe, updates } = fakeStripe();
    const { admin } = fakeAdmin();
    await trueUpOne(admin, stripe, row(), NOW);
    expect(String(updates[0].options?.idempotencyKey)).toContain("hotel-1");
    expect(String(updates[0].options?.idempotencyKey)).toContain("60");
  });

  it("stops the clock so the property isn't corrected again next pass", async () => {
    const { stripe } = fakeStripe();
    const { admin, patches } = fakeAdmin();
    await trueUpOne(admin, stripe, row(), NOW);
    expect(patches[0]).toMatchObject({ room_shortfall_since: null });
    expect(patches[0]).toHaveProperty("room_corrected_at");
  });

  it("leaves billed_rooms to the webhook, the only writer of what Stripe says", async () => {
    const { stripe } = fakeStripe();
    const { admin, patches } = fakeAdmin();
    await trueUpOne(admin, stripe, row(), NOW);
    expect(patches[0]).not.toHaveProperty("billed_rooms");
  });
});

describe("cases where correcting would be wrong", () => {
  it("does nothing when the shortfall resolved itself since the measurement", async () => {
    const { stripe, updates } = fakeStripe();
    const { admin } = fakeAdmin();
    const outcome = await trueUpOne(admin, stripe, row({ billed_rooms: 60, measured_rooms: 60 }), NOW);
    expect(outcome).toEqual({ kind: "no_longer_short" });
    expect(updates).toHaveLength(0);
  });

  it("notices Stripe is already at the right quantity", async () => {
    // Our row can be a webhook behind. Re-reading Stripe is what stops a stale
    // local number from re-raising a count the owner already fixed.
    const { stripe, updates } = fakeStripe(60);
    const { admin } = fakeAdmin();
    expect(await trueUpOne(admin, stripe, row(), NOW)).toEqual({ kind: "no_longer_short" });
    expect(updates).toHaveLength(0);
  });

  it("refuses to invent a price above the self-serve ceiling", async () => {
    // 500 rooms is the largest bracket MAYA sells. Beyond it there is nothing to
    // bill against, so it waits for a human rather than guessing.
    const { stripe, updates } = fakeStripe();
    const { admin } = fakeAdmin();
    const outcome = await trueUpOne(
      admin,
      stripe,
      row({ measured_rooms: 900, room_shortfall_notified_rooms: 900 }),
      NOW,
    );
    expect(outcome).toEqual({ kind: "too_large", measured: 900 });
    expect(updates).toHaveLength(0);
  });

  it("skips a row with no subscription to change", async () => {
    const { stripe } = fakeStripe();
    const { admin } = fakeAdmin();
    expect(await trueUpOne(admin, stripe, row({ stripe_subscription_id: null }), NOW)).toEqual({
      kind: "skipped",
      reason: "no_subscription",
    });
  });
});

function fakeQueryAdmin() {
  const filters: Array<[string, string, unknown]> = [];
  const chain = {
    select: () => chain,
    not: (col: string, op: string, val: unknown) => {
      filters.push([`not.${op}`, col, val]);
      return chain;
    },
    lte: (col: string, val: unknown) => {
      filters.push(["lte", col, val]);
      return chain;
    },
    eq: (col: string, val: unknown) => {
      filters.push(["eq", col, val]);
      return chain;
    },
    order: () => chain,
    limit: async () => ({ data: [], error: null }),
  };
  return { admin: { from: () => chain } as unknown as SupabaseClient, filters };
}

describe("the batch windows exclude what only a human can price", () => {
  // Both queries take the oldest 25 by room_shortfall_since, and an
  // above-ceiling property never resolves on its own — a handful of them at
  // the head would hold the window forever and starve every hotel behind.
  it("keeps above-ceiling properties out of the correction batch", async () => {
    const { admin, filters } = fakeQueryAdmin();
    await dueForTruing(admin, NOW);
    expect(filters).toContainEqual(["lte", "measured_rooms", MAX_ROOMS]);
  });

  it("keeps them out of the warning batch too", async () => {
    const { admin, filters } = fakeQueryAdmin();
    await shortfallsNeedingNotice(admin);
    expect(filters).toContainEqual(["lte", "measured_rooms", MAX_ROOMS]);
  });
});
