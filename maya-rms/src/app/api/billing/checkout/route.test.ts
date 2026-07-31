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
  customerOpts: [] as Record<string, unknown>[],
  couponOpts: [] as Record<string, unknown>[],
  priceFails: false,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => state.client,
  // The rate limiter reads this and no-ops when it is false. These tests are
  // about what checkout does, not about throttling it.
  isAdminConfigured: () => false,
}));
vi.mock("@/lib/hotel-context", () => ({
  resolveAccessibleHotelId: async () => state.hotelId,
  MAYA_ACTIVE_HOTEL_COOKIE: "maya_active_hotel",
}));
vi.mock("@/lib/require-supabase-hotel", () => ({ hasHotelRank: async () => state.rank }));
vi.mock("@/lib/billing/stripe", () => ({
  isStripeConfigured: () => true,
  priceIdFor: async () => {
    if (state.priceFails) {
      throw new Error(
        'No active Stripe price with lookup_key "maya_rooms_monthly_v1". Run scripts/stripe-bootstrap.mts --apply against this account.',
      );
    }
    return "price_test";
  },
  stripeClient: () => ({
    customers: {
      create: async (args: Record<string, unknown>, opts?: Record<string, unknown>) => {
        state.customers.push(args);
        state.customerOpts.push(opts ?? {});
        return { id: `cus_test_${state.customers.length}` };
      },
      // Matches on the hotel_id the route stamps into metadata, same as the
      // real search endpoint would once the customer is indexed.
      search: async ({ query }: { query: string }) => {
        const hotelId = /:'([^']+)'/.exec(query)?.[1];
        return {
          data: state.customers
            .map((c, i) => ({
              id: `cus_test_${i + 1}`,
              metadata: c.metadata as Record<string, string> | undefined,
            }))
            .filter((c) => c.metadata?.hotel_id === hotelId),
        };
      },
    },
    coupons: {
      create: async (_args: Record<string, unknown>, opts?: Record<string, unknown>) => {
        state.couponOpts.push(opts ?? {});
        return { id: "coupon_test" };
      },
    },
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
  state.customerOpts = [];
  state.couponOpts = [];
  state.priceFails = false;
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
    // The message names a path that exists. "Billing settings" sent people
    // looking for a screen with no such name; /billing and /settings both 404.
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/account/billing");
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

describe("the per-PMS access-code gate", () => {
  it("changes nothing when no PMS is declared — every caller today", async () => {
    // No pmsType means every existing caller. Confirms the refactor that
    // threads codeRequired through didn't quietly change the default path: no
    // code, no pmsType, still refused exactly as before.
    seed();
    const res = await post({ rooms: 24, interval: "month", code: "" });
    expect(res.status).toBe(403);
    expect(state.sessions).toHaveLength(0);
  });

  it("still requires a code when the declared PMS has no gate row at all", async () => {
    // A PMS the table doesn't know about yet — fresh environment, a typo, a
    // migration not yet run. Failing toward MORE scarcity is the safe default.
    seed();
    const res = await post({ rooms: 24, interval: "month", code: "", pmsType: "cloudbeds" });
    expect(res.status).toBe(403);
  });

  it("lets checkout through with no code once that PMS's gate is off", async () => {
    seed({ pms_signup_gates: [{ pms_type: "cloudbeds", requires_signup_code: false }] });
    const res = await post({ rooms: 24, interval: "month", code: "", pmsType: "cloudbeds" });
    expect(res.status).toBe(200);
    // No code was used, so nothing to attribute the subscription to.
    expect(lastSession()?.subscription_data).not.toHaveProperty("metadata.signup_code_id");
    expect((lastSession()?.metadata as Record<string, unknown>)?.signup_code_id).toBeUndefined();
  });

  it("does not open every PMS just because one gate is off", async () => {
    seed({ pms_signup_gates: [{ pms_type: "cloudbeds", requires_signup_code: false }] });
    const res = await post({ rooms: 24, interval: "month", code: "", pmsType: "mews" });
    expect(res.status).toBe(403);
  });

  it("still honours a real code even when the gate is off", async () => {
    // The gate only ever widens who may check out with NO code. A discount or
    // trial code the customer actually has keeps working exactly as before.
    seed({ pms_signup_gates: [{ pms_type: "cloudbeds", requires_signup_code: false }] });
    const res = await post({ rooms: 24, interval: "month", code: "MHSFOUNDER", pmsType: "cloudbeds" });
    expect(res.status).toBe(200);
    expect(lastSession()?.subscription_data).toMatchObject({ trial_period_days: 30 });
  });

  it("still rejects a typo'd code even when the gate is off", async () => {
    // Silently discarding a bad code would leave someone who thought they had a
    // discount finding out on their card statement instead.
    seed({ pms_signup_gates: [{ pms_type: "cloudbeds", requires_signup_code: false }] });
    const res = await post({ rooms: 24, interval: "month", code: "NOTAREALCODE", pmsType: "cloudbeds" });
    expect(res.status).toBe(403);
    expect(state.sessions).toHaveLength(0);
  });
});

describe("the Stripe customer, across repeated attempts", () => {
  const pending = {
    hotels: [{ id: "hotel-pending", is_active: false, setup_pending_at: "2026-07-01T00:00:00Z" }],
    hotel_memberships: [
      { hotel_id: "hotel-pending", user_id: USER, role: "hotel_admin", status: "active" },
    ],
  };

  it("finds the customer an abandoned attempt minted instead of creating another", async () => {
    // No subscription row exists until a payment completes, so an earlier
    // attempt's customer is only reachable through the hotel_id on it. Without
    // that lookup, three bounces off the card form left three customers on one
    // email in the dashboard.
    seed(pending);
    await post();
    await post();
    expect(state.customers).toHaveLength(1);
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[1].customer).toBe(state.sessions[0].customer);
  });

  it("creates with an idempotency key keyed on the property", async () => {
    // Search indexing lags creation, so a fast retry can miss the customer it
    // just made. The key is what makes Stripe hand the same one back.
    seed(pending);
    await post();
    expect(state.customerOpts[0]).toMatchObject({ idempotencyKey: "maya_customer_hotel-pending" });
  });

  it("prefers the customer recorded against a dead subscription", async () => {
    seed({
      ...pending,
      hotel_subscriptions: [
        {
          hotel_id: "hotel-pending",
          stripe_customer_id: "cus_prior",
          stripe_subscription_id: "sub_dead",
          status: "canceled",
        },
      ],
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.customers).toHaveLength(0);
    expect(lastSession()?.customer).toBe("cus_prior");
  });
});

describe("a percent code's coupon", () => {
  it("is created under an idempotency key, so identical retries share one", async () => {
    // The annual-rescaled coupon is deliberately never cached on the code row;
    // the key is the only thing keeping a bounce-and-retry from minting a
    // duplicate per attempt.
    seed({
      signup_codes: [
        {
          id: "code-pct",
          code: "TWENTY",
          kind: "percent_off",
          percent_off: 20,
          duration_months: 3,
          is_active: true,
          stripe_coupon_id: null,
        },
      ],
    });
    const res = await post({ rooms: 24, interval: "year", code: "TWENTY" });
    expect(res.status).toBe(200);
    const key = String(state.couponOpts[0]?.idempotencyKey);
    expect(key).toContain("code-pct");
    expect(key).toContain("year");
  });
});

describe("when Stripe itself is broken", () => {
  it("logs the real error and answers with something generic", async () => {
    seed();
    state.priceFails = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post();

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    // The lookup key and the repo script are for the log, not the card form.
    expect(body.error).not.toContain("lookup_key");
    expect(body.error).not.toContain("stripe-bootstrap");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("lookup_key"));
    errors.mockRestore();
  });
});
