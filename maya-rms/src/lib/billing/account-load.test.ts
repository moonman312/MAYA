/**
 * The shortfall countdown on the billing page has to agree with trueUpOne,
 * which waits for the full grace period after the notice about this shortfall.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./room-count", async (importActual) => ({
  ...(await importActual<typeof import("./room-count")>()),
  measureRooms: async () => ({ excluded: [], allExcluded: false }),
}));
const stripe = vi.hoisted(() => ({
  configured: false,
  fail: false,
  invoices: [] as { status: string; created: number }[],
  listed: [] as Record<string, unknown>[],
  preview: null as Record<string, unknown> | null,
}));
vi.mock("./stripe", () => ({
  isStripeConfigured: () => stripe.configured,
  stripeClient: () => ({
    invoices: {
      list: async (params: Record<string, unknown>) => {
        stripe.listed.push(params);
        if (stripe.fail) throw new Error("stripe is down");
        return { data: stripe.invoices };
      },
      createPreview: async () => {
        if (stripe.fail) throw new Error("stripe is down");
        return stripe.preview;
      },
    },
  }),
}));

import { loadAccountBilling, roomGraceDaysLeft } from "./account";

const NOW = new Date("2026-08-10T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const base = {
  hotel_id: "hotel-1",
  billed_rooms: 40,
  measured_rooms: 60,
  room_shortfall_since: daysAgo(10),
};

describe("roomGraceDaysLeft", () => {
  it("counts from the notice, not from the first measurement", () => {
    const left = roomGraceDaysLeft(
      { ...base, room_shortfall_notified_at: daysAgo(2), room_shortfall_notified_rooms: 60 },
      NOW,
    );
    expect(left).toBe(5);
  });

  it("is null when no notice went out", () => {
    expect(roomGraceDaysLeft({ ...base, room_shortfall_notified_at: null }, NOW)).toBeNull();
  });

  it("is null when the notice quoted a different count", () => {
    expect(
      roomGraceDaysLeft({ ...base, room_shortfall_notified_at: daysAgo(2), room_shortfall_notified_rooms: 25 }, NOW),
    ).toBeNull();
  });

  it("is null when the notice was about an earlier shortfall", () => {
    expect(
      roomGraceDaysLeft({ ...base, room_shortfall_notified_at: daysAgo(90), room_shortfall_notified_rooms: 60 }, NOW),
    ).toBeNull();
  });
});

describe("loadAccountBilling before the notice migration", () => {
  it("retries without the notice columns and shows no countdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const selects: string[] = [];
    const supabase = {
      from: () => {
        let columns = "";
        const chain = {
          select: (c: string) => {
            columns = c;
            selects.push(c);
            return chain;
          },
          eq: () => chain,
          maybeSingle: async () =>
            columns.includes("room_shortfall_notified_at")
              ? { data: null, error: { code: "42703", message: "column does not exist" } }
              : { data: { ...base, status: "active", billing_interval: "month" }, error: null },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    const billing = await loadAccountBilling(supabase, "hotel-1");
    vi.useRealTimers();
    expect(selects).toHaveLength(2);
    expect(billing?.roomTruth.kind).toBe("short");
    expect(billing?.roomGraceDaysLeft).toBeNull();
  });
});

/** One subscription row, read back whatever columns are asked for. */
function rowClient(row: Record<string, unknown>): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("loadAccountBilling for an unpaid subscription", () => {
  const unpaid = {
    hotel_id: "hotel-1",
    status: "unpaid",
    billing_interval: "month",
    billed_rooms: 40,
    // Stripe keeps opening periods on an unpaid subscription, so this is
    // still to come and says nothing about when payment stopped.
    current_period_end: "2026-09-01T00:00:00Z",
    stripe_subscription_id: "sub_unpaid",
  };

  beforeEach(() => {
    stripe.configured = true;
    stripe.fail = false;
    stripe.invoices = [];
    stripe.listed = [];
  });

  it("dates it from the oldest invoice still owed since the last one paid", async () => {
    // Newest first, as Stripe lists them.
    stripe.invoices = [
      { status: "draft", created: at("2026-08-01T00:00:00Z") },
      { status: "open", created: at("2026-07-01T00:00:00Z") },
      { status: "void", created: at("2026-06-15T00:00:00Z") },
      { status: "uncollectible", created: at("2026-06-01T00:00:00Z") },
      { status: "paid", created: at("2026-05-01T00:00:00Z") },
      // An earlier lapse that was paid off long ago does not count.
      { status: "uncollectible", created: at("2026-01-01T00:00:00Z") },
    ];
    const billing = await loadAccountBilling(rowClient(unpaid), "hotel-1");
    expect(stripe.listed[0]).toMatchObject({ subscription: "sub_unpaid" });
    expect(billing?.unpaidSince).toBe("2026-06-01T00:00:00.000Z");
    expect(billing?.renewsAt).toBe("2026-09-01T00:00:00Z");
  });

  it("shows no date rather than a wrong one when Stripe cannot be asked", async () => {
    stripe.fail = true;
    const billing = await loadAccountBilling(rowClient(unpaid), "hotel-1");
    expect(billing?.unpaidSince).toBeNull();
  });

  it("asks Stripe nothing about a subscription that is not unpaid", async () => {
    const billing = await loadAccountBilling(rowClient({ ...unpaid, status: "canceled" }), "hotel-1");
    expect(stripe.listed).toHaveLength(0);
    expect(billing?.unpaidSince).toBeNull();
  });
});

describe("loadAccountBilling for a live subscription", () => {
  const active = {
    hotel_id: "hotel-1",
    status: "active",
    billing_interval: "month",
    billed_rooms: 40,
    current_period_end: "2026-09-01T00:00:00Z",
    stripe_subscription_id: "sub_live",
    signup_code_id: null,
  };

  beforeEach(() => {
    stripe.configured = true;
    stripe.fail = false;
  });

  it("counts a code as applied only when Stripe's next invoice carries a discount", async () => {
    stripe.preview = { amount_due: 18_000, total_discount_amounts: [{ amount: 2_000, discount: "di_1" }] };
    const coded = await loadAccountBilling(rowClient(active), "hotel-1");
    expect(coded?.chargeCents).toBe(18_000);
    expect(coded?.codeApplied).toBe(true);

    // A proration from a room count change moves the total with no discount.
    stripe.preview = { amount_due: 23_400, total_discount_amounts: [] };
    const prorated = await loadAccountBilling(rowClient(active), "hotel-1");
    expect(prorated?.chargeCents).toBe(23_400);
    expect(prorated?.codeApplied).toBe(false);
  });

  it("claims no code when Stripe cannot be asked", async () => {
    stripe.fail = true;
    const billing = await loadAccountBilling(rowClient(active), "hotel-1");
    expect(billing?.chargeCents).toBeNull();
    expect(billing?.codeApplied).toBe(false);
  });
});
