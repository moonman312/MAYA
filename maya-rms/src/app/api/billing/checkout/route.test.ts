/**
 * Regression tests for what checkout does when no property exists yet.
 *
 * Payment is the first step of onboarding, so the usual caller has never
 * connected a PMS and owns nothing. hotel_subscriptions is keyed by hotel_id and
 * sync.ts drops any subscription whose metadata carries none, so the row a
 * payment will attach to has to exist before Stripe is ever called. These pin
 * that: the property is provisioned before the Checkout Session, its id is the
 * one in the subscription's metadata, an abandoned attempt is reused rather than
 * duplicated, and a rejected code leaves nothing behind.
 *
 * A minimal in-memory fake stands in for Supabase and Stripe's outbound calls
 * are captured, so the route runs outside a request context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter =
  | ["eq", string, unknown]
  | ["in", string, unknown[]]
  | ["ilike", string, string]
  | ["notNull", string];

function fakeSupabase(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
  );
  const failInsertFor = new Set<string>();
  let nextId = 0;
  const tableOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f[0] === "eq") return row[f[1]] === f[2];
      if (f[0] === "in") return f[2].includes(row[f[1]]);
      if (f[0] === "ilike") return String(row[f[1]]).toLowerCase() === f[2].toLowerCase();
      return row[f[1]] != null;
    });
  }

  function builder(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let pending: Row[] | null = null;
    let patch: Row | null = null;
    let single = false;
    let counting = false;
    let cap: number | null = null;

    const api = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        counting = Boolean(opts?.count);
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push(["eq", col, val]);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push(["in", col, vals]);
        return api;
      },
      ilike(col: string, val: string) {
        filters.push(["ilike", col, val]);
        return api;
      },
      not(col: string) {
        filters.push(["notNull", col]);
        return api;
      },
      limit(n: number) {
        cap = n;
        return api;
      },
      insert(payload: Row | Row[]) {
        pending = Array.isArray(payload) ? payload : [payload];
        mode = "insert";
        return api;
      },
      update(next: Row) {
        patch = next;
        mode = "update";
        return api;
      },
      delete() {
        mode = "delete";
        return api;
      },
      maybeSingle() {
        single = true;
        return run();
      },
      single() {
        single = true;
        return run();
      },
      then(resolve: (v: unknown) => void) {
        return run().then(resolve);
      },
    };

    async function run() {
      if (mode === "insert" && pending) {
        if (failInsertFor.has(table)) {
          return { data: null, error: { message: `insert into ${table} rejected` } };
        }
        const inserted = pending.map((r) => ({ id: r.id ?? `${table}-${nextId++}`, ...r }));
        tableOf(table).push(...inserted);
        return { data: single ? (inserted[0] ?? null) : inserted, error: null };
      }
      if (mode === "update" && patch) {
        const rows = tableOf(table).filter((r) => matches(r, filters));
        for (const r of rows) Object.assign(r, patch);
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (mode === "delete") {
        tables.set(
          table,
          tableOf(table).filter((r) => !matches(r, filters)),
        );
        return { data: null, error: null };
      }
      let rows = tableOf(table).filter((r) => matches(r, filters));
      if (cap != null) rows = rows.slice(0, cap);
      if (counting) return { data: null, count: rows.length, error: null };
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }

    return api;
  }

  const client = {
    from: (t: string) => builder(t),
    auth: { getUser: async () => ({ data: { user: { id: USER, email: "gm@driftwood.example" } } }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, tables, failInsertFor };
}

const USER = "user-1";
const CODE = { id: "code-1", code: "MHSFOUNDER", kind: "trial", trial_days: 30 };

const state = vi.hoisted(() => ({
  client: null as unknown,
  hotelId: null as string | null,
  rank: true,
  sessions: [] as Record<string, unknown>[],
  customers: [] as Record<string, unknown>[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => state.client }));
vi.mock("@/lib/hotel-context", () => ({
  resolveAccessibleHotelId: async () => state.hotelId,
  MAYA_ACTIVE_HOTEL_COOKIE: "maya_active_hotel",
}));
vi.mock("@/lib/require-supabase-hotel", () => ({ hasHotelRank: async () => state.rank }));
vi.mock("@/lib/billing/stripe", () => ({
  isStripeConfigured: () => true,
  priceIdFor: async () => "price_test",
  stripeClient: () => ({
    customers: {
      create: async (args: Record<string, unknown>) => {
        state.customers.push(args);
        return { id: "cus_test" };
      },
    },
    coupons: { create: async () => ({ id: "coupon_test" }) },
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          state.sessions.push(args);
          return { id: "cs_test", url: "https://checkout.stripe.test/pay" };
        },
      },
    },
  }),
}));

const { POST } = await import("./route");

function post(body: unknown = { rooms: 24, interval: "month", code: "MHSFOUNDER" }) {
  return POST(
    new Request("http://localhost/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Seeds a valid code, and optionally the row a previous attempt left behind. */
function seed(extra: Record<string, Row[]> = {}) {
  const fake = fakeSupabase({ signup_codes: [{ ...CODE, is_active: true }], ...extra });
  state.client = fake.client;
  return fake;
}

const lastSession = () => state.sessions.at(-1) as Record<string, Row> | undefined;

beforeEach(() => {
  state.hotelId = null;
  state.rank = true;
  state.sessions = [];
  state.customers = [];
});

describe("a first-time signup, with no property yet", () => {
  it("provisions the property before Stripe and puts its id in the subscription metadata", async () => {
    const { tables } = seed();
    const res = await post();
    expect(res.status).toBe(200);

    const hotels = tables.get("hotels") ?? [];
    expect(hotels).toHaveLength(1);
    // Invisible until the PMS connect adopts it: resolveAccessibleHotelId
    // filters on is_active, so a half-finished signup owns nothing it can see.
    expect(hotels[0]).toMatchObject({ is_active: false });
    expect(hotels[0].setup_pending_at).toBeTruthy();

    expect(tables.get("hotel_memberships")?.[0]).toMatchObject({
      user_id: USER,
      role: "hotel_admin",
      status: "active",
    });

    // The whole point: sync.ts can attach this payment.
    expect(lastSession()?.subscription_data).toMatchObject({
      metadata: { hotel_id: hotels[0].id, user_id: USER, signup_code_id: CODE.id },
    });
  });

  it("reuses the property an abandoned attempt left behind instead of making another", async () => {
    const { tables } = seed({
      hotels: [{ id: "hotel-pending", is_active: false, setup_pending_at: "2026-07-01T00:00:00Z" }],
      hotel_memberships: [
        { hotel_id: "hotel-pending", user_id: USER, role: "hotel_admin", status: "active" },
      ],
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(tables.get("hotels")).toHaveLength(1);
    expect(lastSession()?.metadata).toMatchObject({ hotel_id: "hotel-pending" });
  });

  it("picks the paid row when two checkouts raced, rather than selling a second subscription", async () => {
    seed({
      hotels: [
        { id: "hotel-a", is_active: false, setup_pending_at: "2026-07-01T00:00:00Z" },
        { id: "hotel-b", is_active: false, setup_pending_at: "2026-07-01T00:00:01Z" },
      ],
      hotel_memberships: [
        { hotel_id: "hotel-a", user_id: USER, role: "hotel_admin", status: "active" },
        { hotel_id: "hotel-b", user_id: USER, role: "hotel_admin", status: "active" },
      ],
      hotel_subscriptions: [
        { hotel_id: "hotel-b", stripe_subscription_id: "sub_1", status: "active" },
      ],
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(state.sessions).toHaveLength(0);
  });

  it("sends Stripe back through the return route so the next page knows they paid", async () => {
    seed();
    await post();
    expect(String(lastSession()?.success_url)).toContain("/api/billing/checkout/return");
  });

  it("leaves nothing behind when the code is rejected", async () => {
    const { tables } = seed();
    const res = await post({ rooms: 24, interval: "month", code: "NOPE" });
    expect(res.status).toBe(403);
    expect(tables.get("hotels") ?? []).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
  });

  it("leaves nothing behind when the room count is unusable", async () => {
    const { tables } = seed();
    const res = await post({ rooms: 0, interval: "month", code: "MHSFOUNDER" });
    expect(res.status).toBe(400);
    expect(tables.get("hotels") ?? []).toHaveLength(0);
  });

  it("refuses a second subscription for a property that already has one", async () => {
    seed({
      hotels: [{ id: "hotel-pending", is_active: false, setup_pending_at: "2026-07-01T00:00:00Z" }],
      hotel_memberships: [
        { hotel_id: "hotel-pending", user_id: USER, role: "hotel_admin", status: "active" },
      ],
      hotel_subscriptions: [
        { hotel_id: "hotel-pending", stripe_subscription_id: "sub_1", status: "active" },
      ],
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(state.sessions).toHaveLength(0);
  });

  it("lets a property retry after a subscription that never came to anything", async () => {
    // Testing "not canceled" instead of "entitled" trapped every dead-but-not-
    // canceled state: incomplete (they closed the card form), incomplete_expired,
    // unpaid after dunning gave up. Each one produced a 409 telling the owner to
    // manage a subscription in billing settings that would never charge or serve
    // them — a hotel with no way forward and nothing to cancel.
    for (const deadStatus of ["incomplete", "incomplete_expired", "unpaid", "canceled"]) {
      state.sessions = [];
      seed({
        hotels: [{ id: "hotel-pending", is_active: false, setup_pending_at: "2026-07-01T00:00:00Z" }],
        hotel_memberships: [
          { hotel_id: "hotel-pending", user_id: USER, role: "hotel_admin", status: "active" },
        ],
        hotel_subscriptions: [
          { hotel_id: "hotel-pending", stripe_subscription_id: "sub_dead", status: deadStatus },
        ],
      });
      const res = await post();
      expect(res.status, `status ${deadStatus} should not block a retry`).toBe(200);
      expect(state.sessions).toHaveLength(1);
    }
  });

  it("still refuses while a subscription is trialing or merely behind on payment", async () => {
    // past_due is entitled — Stripe is still retrying and the hotel is still
    // being served, so a second subscription would double-bill them.
    for (const liveStatus of ["trialing", "active", "past_due"]) {
      state.sessions = [];
      seed({
        hotels: [{ id: "hotel-pending", is_active: false, setup_pending_at: "2026-07-01T00:00:00Z" }],
        hotel_memberships: [
          { hotel_id: "hotel-pending", user_id: USER, role: "hotel_admin", status: "active" },
        ],
        hotel_subscriptions: [
          { hotel_id: "hotel-pending", stripe_subscription_id: "sub_live", status: liveStatus },
        ],
      });
      const res = await post();
      expect(res.status, `status ${liveStatus} should block`).toBe(409);
      expect(state.sessions).toHaveLength(0);
    }
  });

  it("reports a failure to provision rather than starting a payment with nowhere to land", async () => {
    const { failInsertFor } = seed();
    failInsertFor.add("hotels");
    const res = await post();
    expect(res.status).toBe(500);
    expect(state.sessions).toHaveLength(0);
  });
});

describe("a property that already exists", () => {
  it("still needs General Manager, and provisions nothing when the caller is below it", async () => {
    const { tables } = seed({ hotels: [{ id: "hotel-real", name: "Driftwood", is_active: true }] });
    state.hotelId = "hotel-real";
    state.rank = false;

    const res = await post();
    expect(res.status).toBe(403);
    expect(tables.get("hotels")).toHaveLength(1);
    expect(state.sessions).toHaveLength(0);
  });

  it("subscribes that property, and names it on the Stripe customer", async () => {
    seed({ hotels: [{ id: "hotel-real", name: "Driftwood", is_active: true }] });
    state.hotelId = "hotel-real";

    const res = await post();
    expect(res.status).toBe(200);
    expect(lastSession()?.metadata).toMatchObject({ hotel_id: "hotel-real" });
    expect(state.customers[0]).toMatchObject({ name: "Driftwood" });
  });
});
