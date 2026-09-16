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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVACY_VERSION, signupAcceptanceMetadata, TERMS_VERSION } from "@/lib/legal/versions";

type Row = Record<string, unknown>;
type Filter =
  | ["eq", string, unknown]
  | ["in", string, unknown[]]
  | ["ilike", string, string]
  | ["notNull", string]
  | ["isNull", string];

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
      if (f[0] === "isNull") return row[f[1]] == null;
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
      // findPendingHotelForUser skips deferred Marketplace properties with it.
      is(col: string) {
        filters.push(["isNull", col]);
        return api;
      },
      limit(n: number) {
        cap = n;
        return api;
      },
      order() {
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
    auth: {
      getUser: async () => ({
        data: { user: { id: USER, email: "gm@driftwood.example", user_metadata: state.userMetadata } },
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => state.rpc(name, args, tables),
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
  customerSearches: [] as string[],
  couponOpts: [] as Record<string, unknown>[],
  priceFails: false,
  adminConfigured: false,
  userMetadata: {} as Record<string, unknown>,
  rpc: (async () => ({ data: null, error: null })) as (
    name: string,
    args: Record<string, unknown>,
    tables: Map<string, Row[]>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => state.client }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => state.client,
  // Off unless a test is about adopting a signup's acceptance.
  isAdminConfigured: () => state.adminConfigured,
}));
// These tests are about what checkout does, not about throttling it.
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: async () => null }));
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
      // Matches on whichever metadata key the route asks about, same as the
      // real search endpoint would once the customer is indexed.
      search: async ({ query }: { query: string }) => {
        state.customerSearches.push(query);
        const m = /metadata\['(\w+)'\]:'([^']+)'/.exec(query);
        const [key, value] = [m?.[1] ?? "", m?.[2] ?? ""];
        return {
          data: state.customers
            .map((c, i) => ({
              id: `cus_test_${i + 1}`,
              metadata: c.metadata as Record<string, string> | undefined,
            }))
            .filter((c) => c.metadata?.[key] === value),
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

/** The caller accepted the Terms in force, as nearly every caller has. */
const ACCEPTED = {
  terms_acceptances: [
    { user_id: USER, terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, context: "signup" },
  ],
};

/** Seeds a valid code, and optionally the row a previous attempt left behind. */
function seed(extra: Record<string, Row[]> = {}) {
  const fake = fakeSupabase({ signup_codes: [{ ...CODE, is_active: true }], ...ACCEPTED, ...extra });
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
  state.customerSearches = [];
  state.couponOpts = [];
  state.priceFails = false;
  state.adminConfigured = false;
  state.userMetadata = {};
  state.rpc = async () => ({ data: null, error: null });
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
    // The hotel travels on the URL so the waiting screen knows what to watch
    // even when Stripe cannot be reached on the way back.
    expect(String(lastSession()?.success_url)).toMatch(/[?&]hotel=/);
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
    // Flow B: one property, one customer. It neither looks for nor stamps an
    // owner-keyed customer — that is the Marketplace group's arrangement.
    expect(state.customerSearches[0]).toContain("metadata['hotel_id']");
    expect(state.customers[0]).toMatchObject({ metadata: { hotel_id: "hotel-pending" } });
    expect((state.customers[0].metadata as Record<string, unknown>).user_id).toBeUndefined();
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

describe("tax and terms are off until someone says otherwise", () => {
  it("sends no tax or consent fields by default", async () => {
    seed();
    await post();
    const s = lastSession();
    expect(s?.automatic_tax).toBeUndefined();
    expect(s?.tax_id_collection).toBeUndefined();
    expect(s?.billing_address_collection).toBeUndefined();
    expect(s?.consent_collection).toBeUndefined();
  });

  it("collects tax, a fresh address and a tax id once MAYA_COLLECT_TAX is set", async () => {
    vi.stubEnv("MAYA_COLLECT_TAX", "true");
    seed();
    await post();
    const s = lastSession();
    expect(s?.automatic_tax).toEqual({ enabled: true });
    // Without both of these a returning customer is taxed on a stale address.
    expect(s?.billing_address_collection).toBe("required");
    expect(s?.customer_update).toEqual({ address: "auto" });
    expect(s?.tax_id_collection).toEqual({ enabled: true });
    vi.unstubAllEnvs();
  });

  it("treats any value other than true as off — a half-set flag must not imply tax is handled", async () => {
    vi.stubEnv("MAYA_COLLECT_TAX", "1");
    seed();
    await post();
    expect(lastSession()?.automatic_tax).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("asks for terms only once there is a page to point at", async () => {
    vi.stubEnv("MAYA_TERMS_URL", "https://maya.example.com/terms");
    seed();
    await post();
    expect(lastSession()?.consent_collection).toEqual({ terms_of_service: "required" });
    vi.unstubAllEnvs();
  });

  it("ignores a blank terms url", async () => {
    vi.stubEnv("MAYA_TERMS_URL", "   ");
    seed();
    await post();
    expect(lastSession()?.consent_collection).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe("the disclosure above the pay button", () => {
  const message = () =>
    String(((lastSession()?.custom_text as Row | undefined)?.submit as Row | undefined)?.message ?? "");

  it("links the Terms, says it renews, and names the card's stored uses on every session", async () => {
    seed();
    await post({ rooms: 24, interval: "year", code: "MHSFOUNDER" });
    const text = message();
    expect(text).toContain("[MAYA Terms of Service](https://www.get-maya.com/terms)");
    expect(text).toContain("renews automatically every year until you cancel");
    expect(text).toContain("stored and may be charged for room-count changes");
    expect(text).toContain("(Terms 7.6)");
    // A Flow B customer is this property's alone; nothing is offered elsewhere.
    expect(text).not.toContain("other properties");
    expect(text.length).toBeLessThan(600);
    expect(text).not.toMatch(/\u2014/);
  });

  it("says a trial becomes paid only when there is a trial", async () => {
    seed();
    await post();
    expect(message()).toContain("30-day free trial becomes a paid subscription unless you cancel before it ends");

    seed({ signup_codes: [{ id: "code-2", code: "PLAIN", kind: "discount", percent_off: 10, is_active: true }] });
    await post({ rooms: 24, interval: "month", code: "PLAIN" });
    expect(lastSession()?.subscription_data).not.toHaveProperty("trial_period_days");
    expect(message()).not.toContain("trial");
    expect(message()).toContain("every month");
  });

  it("never adds a consent checkbox", async () => {
    seed();
    await post();
    expect(lastSession()?.consent_collection).toBeUndefined();
    expect(lastSession()?.custom_text).not.toHaveProperty("terms_of_service_acceptance");
  });
});

describe("the Terms have to be on file before a card is taken", () => {
  it("answers 428 terms_required, and starts nothing, when they were never accepted", async () => {
    const fake = seed({ terms_acceptances: [] });
    const res = await post();
    expect(res.status).toBe(428);
    expect(await res.json()).toMatchObject({ reason: "terms_required" });
    expect(state.sessions).toHaveLength(0);
    expect(fake.tables.get("hotels") ?? []).toHaveLength(0);
  });

  it("does not count an acceptance of older versions", async () => {
    seed({
      terms_acceptances: [{ user_id: USER, terms_version: "0", privacy_version: PRIVACY_VERSION }],
    });
    expect((await post()).status).toBe(428);
  });

  it("adopts a signup's ticked box when the trigger did not write the row", async () => {
    const fake = seed({ terms_acceptances: [] });
    state.adminConfigured = true;
    state.userMetadata = signupAcceptanceMetadata("signup");
    const calls: string[] = [];
    state.rpc = async (name, _args, tables) => {
      calls.push(name);
      if (name !== "record_terms_acceptance_from_signup") return { data: null, error: null };
      tables.get("terms_acceptances")!.push({ user_id: USER, terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION });
      return { data: true, error: null };
    };
    const res = await post();
    expect(res.status).toBe(200);
    expect(calls).toContain("record_terms_acceptance_from_signup");
    expect(fake.tables.get("terms_acceptances")).toHaveLength(1);
  });

  it("still asks when the metadata carries no current acceptance", async () => {
    seed({ terms_acceptances: [] });
    state.adminConfigured = true;
    state.userMetadata = { full_name: "Ana" };
    const calls: string[] = [];
    state.rpc = async (name) => {
      calls.push(name);
      return { data: false, error: null };
    };
    expect((await post()).status).toBe(428);
    expect(calls).not.toContain("record_terms_acceptance_from_signup");
  });

  it("lets MHS staff through, as the accept screen does", async () => {
    seed({ terms_acceptances: [] });
    state.rpc = async (name) => ({ data: name === "is_platform_admin", error: null });
    expect((await post()).status).toBe(200);
  });

  it("proceeds, and logs, when acceptance cannot be read", async () => {
    const fake = seed();
    const realFrom = fake.client.from;
    fake.client.from = (t: string) =>
      t === "terms_acceptances"
        ? {
            select: () => {
              throw new Error("connection reset");
            },
          }
        : realFrom(t);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.sessions).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("checkout proceeding"));
    errors.mockRestore();
  });

  it("proceeds when the staff check itself fails", async () => {
    seed({ terms_acceptances: [] });
    state.rpc = async () => ({ data: null, error: { message: "timeout" } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post()).status).toBe(200);
    errors.mockRestore();
  });
});

describe("payment methods", () => {
  it("never offers bank debits — the card checks would fail a paying ACH customer", async () => {
    seed();
    await post();
    expect(lastSession()?.excluded_payment_method_types).toEqual(["us_bank_account"]);
    // Everything else stays dashboard-decided; pinning a positive list here
    // would re-create payment_method_types under another name.
    expect(lastSession()?.payment_method_types).toBeUndefined();
  });

  it("sends no saved-card options for a Flow B property — one property, one card, nothing to redisplay", async () => {
    // The redisplay widening is the Marketplace group's arrangement only.
    // A Flow B session must stay exactly what it was.
    seed();
    await post();
    expect(lastSession()?.saved_payment_method_options).toBeUndefined();
  });
});

describe("a property that arrived from the Cloudbeds Marketplace", () => {
  // Owned and connected, not paid for: exactly the shape checkout already
  // knows how to attach a subscription to. The claim row is what marks it.
  const arrival = {
    hotels: [
      { id: "hotel-mkt", name: "Sea View Inn", is_active: false, setup_pending_at: "2026-09-10T14:08:00Z" },
    ],
    hotel_memberships: [{ hotel_id: "hotel-mkt", user_id: USER, role: "hotel_admin", status: "active" }],
    pms_marketplace_claims: [
      {
        token: "tok",
        hotel_id: "hotel-mkt",
        pms_type: "cloudbeds",
        property_name: "Sea View Inn",
        claimed_by: USER,
        claimed_at: "2026-09-10T14:09:00Z",
      },
    ],
  };
  const original = process.env.MAYA_MARKETPLACE_TRIAL_DAYS;
  beforeEach(() => {
    process.env.MAYA_MARKETPLACE_TRIAL_DAYS = "7";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MAYA_MARKETPLACE_TRIAL_DAYS;
    else process.env.MAYA_MARKETPLACE_TRIAL_DAYS = original;
  });

  it("needs no code even with the PMS gate shut — the Marketplace listing is the gate", async () => {
    // No pms_signup_gates row, so cloudbeds reads as code-required for anyone
    // else (see the gate tests above). This caller still gets through.
    const { tables } = seed(arrival);
    const res = await post({ rooms: 24, interval: "month", code: "", pmsType: "cloudbeds" });
    expect(res.status).toBe(200);
    expect(lastSession()?.metadata).toMatchObject({ hotel_id: "hotel-mkt" });
    // The Marketplace property IS the property; nothing else gets provisioned.
    expect(tables.get("hotels")).toHaveLength(1);
  });

  it("gets the Marketplace trial, is labelled as such, and the customer belongs to the owner", async () => {
    seed(arrival);
    const res = await post({ rooms: 24, interval: "month", code: "", pmsType: "cloudbeds" });
    expect(res.status).toBe(200);
    expect(lastSession()?.subscription_data).toMatchObject({
      trial_period_days: 7,
      metadata: { hotel_id: "hotel-mkt", via: "marketplace_flow_a" },
    });
    // The customer stands for the owner across every property they pay for:
    // keyed on the user, no property name, no hotel on it.
    expect(state.customers[0]).toMatchObject({ metadata: { user_id: USER } });
    expect(state.customers[0].name).toBeUndefined();
    expect((state.customers[0].metadata as Record<string, unknown>).hotel_id).toBeUndefined();
    expect(state.customerOpts[0]).toMatchObject({ idempotencyKey: `maya_customer_user_${USER}` });
    // That shared customer is why only this flow says the card is offered again.
    const text = String(((lastSession()?.custom_text as Row).submit as Row).message);
    expect(text).toContain("7-day free trial");
    expect(text).toContain("and offered for your other properties (Terms 7.6)");
  });

  it("creates the owner's customer identically for every sibling, so the shared idempotency key cannot collide", async () => {
    const sibling = { id: "hotel-mkt-2", name: "Harbour House", is_active: false, setup_pending_at: "2026-09-10T14:08:00Z" };
    seed({
      ...arrival,
      hotels: [...arrival.hotels, sibling],
      hotel_memberships: [
        ...arrival.hotel_memberships,
        { hotel_id: "hotel-mkt-2", user_id: USER, role: "hotel_admin", status: "active" },
      ],
      pms_marketplace_claims: [
        ...arrival.pms_marketplace_claims,
        { ...arrival.pms_marketplace_claims[0], token: "tok2", hotel_id: "hotel-mkt-2", property_name: "Harbour House" },
      ],
    });
    const first = await post({ rooms: 24, interval: "month", code: "", pmsType: "cloudbeds", hotelId: "hotel-mkt" });
    expect(first.status).toBe(200);
    const created = JSON.parse(JSON.stringify(state.customers[0]));
    // Stripe's search index lags creation by up to a minute. Pretend it has not
    // caught up, so the second sibling reaches the create with the same key —
    // which Stripe only honours if the parameters are the same too.
    state.customers[0].metadata = {};
    const second = await post({ rooms: 24, interval: "month", code: "", pmsType: "cloudbeds", hotelId: "hotel-mkt-2" });
    expect(second.status).toBe(200);
    expect(state.customers).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(state.customers[1]))).toEqual(created);
    expect(state.customerOpts[1]).toEqual(state.customerOpts[0]);
  });

  it("lets a code's own trial replace the Marketplace one — they never stack", async () => {
    seed(arrival);
    const res = await post({ rooms: 24, interval: "month", code: "MHSFOUNDER", pmsType: "cloudbeds" });
    expect(res.status).toBe(200);
    expect(lastSession()?.subscription_data).toMatchObject({ trial_period_days: 30 });
  });

  it("grants no trial at all when the setting is off", async () => {
    process.env.MAYA_MARKETPLACE_TRIAL_DAYS = "0";
    seed(arrival);
    const res = await post({ rooms: 24, interval: "month", code: "", pmsType: "cloudbeds" });
    expect(res.status).toBe(200);
    expect(lastSession()?.subscription_data).not.toHaveProperty("trial_period_days");
  });

  it("still rejects a typo'd code — the gate bypass never skips validating text they typed", async () => {
    seed(arrival);
    const res = await post({ rooms: 24, interval: "month", code: "NOTAREALCODE", pmsType: "cloudbeds" });
    expect(res.status).toBe(403);
    expect(state.sessions).toHaveLength(0);
  });
});

describe("a Marketplace group, paid for one property at a time", () => {
  // Two properties parked by one grant and handed to one owner by one claim.
  // Subscriptions are per hotel, so each needs its own checkout; the owner
  // names which one, and the card taken for the first is kept for the second.
  const groupClaim = (hotelId: string, name: string) => ({
    token: `tok-${hotelId}`,
    hotel_id: hotelId,
    pms_type: "cloudbeds",
    property_name: name,
    claimed_by: USER,
    claimed_at: "2026-09-10T14:09:00Z",
    group_key: "grp-1",
  });
  const group = {
    hotels: [
      { id: "hotel-a", name: "Sea View Inn", is_active: false, setup_pending_at: "2026-09-10T14:08:00Z", created_at: "2026-09-10T14:08:00Z" },
      { id: "hotel-b", name: "Bay Lodge", is_active: false, setup_pending_at: "2026-09-10T14:08:01Z", created_at: "2026-09-10T14:08:01Z" },
    ],
    hotel_memberships: [
      { hotel_id: "hotel-a", user_id: USER, role: "hotel_admin", status: "active" },
      { hotel_id: "hotel-b", user_id: USER, role: "hotel_admin", status: "active" },
    ],
    pms_marketplace_claims: [groupClaim("hotel-a", "Sea View Inn"), groupClaim("hotel-b", "Bay Lodge")],
  };
  const pay = (hotelId: string) =>
    post({ rooms: 12, interval: "month", code: "", pmsType: "cloudbeds", hotelId });

  it("pays for the property the owner names, not the oldest parked one", async () => {
    seed(group);
    const res = await pay("hotel-b");
    expect(res.status).toBe(200);
    expect(lastSession()?.metadata).toMatchObject({ hotel_id: "hotel-b" });
    expect(lastSession()?.subscription_data).toMatchObject({
      metadata: { hotel_id: "hotel-b", via: "marketplace_flow_a" },
    });
    // The session names the property; the customer names only the owner.
    expect(state.customers[0]).toMatchObject({ metadata: { user_id: USER } });
  });

  it("refuses a property the caller does not own", async () => {
    seed({
      ...group,
      hotel_memberships: [{ hotel_id: "hotel-a", user_id: USER, role: "hotel_admin", status: "active" }],
    });
    const res = await pay("hotel-b");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("That property isn't yours to pay for.");
    expect(state.sessions).toHaveLength(0);
  });

  it("refuses a named property that is not a parked Marketplace one", async () => {
    // Owned, pending, but no claim: a Flow B placeholder. Naming it by id is
    // not how that one gets paid for.
    seed({ ...group, pms_marketplace_claims: [groupClaim("hotel-a", "Sea View Inn")] });
    expect((await pay("hotel-b")).status).toBe(403);
    // Owned and claimed, but already live.
    seed({
      ...group,
      hotels: [group.hotels[0], { ...group.hotels[1], is_active: true, setup_pending_at: null }],
    });
    expect((await pay("hotel-b")).status).toBe(403);
    expect(state.sessions).toHaveLength(0);
  });

  it("answers 409 for a named property that is already paid for", async () => {
    seed({
      ...group,
      hotel_subscriptions: [{ hotel_id: "hotel-b", stripe_subscription_id: "sub_b", status: "trialing" }],
    });
    const res = await pay("hotel-b");
    expect(res.status).toBe(409);
    expect(state.sessions).toHaveLength(0);
  });

  it("puts both properties on one Stripe customer, keyed on the owner", async () => {
    // What makes the second checkout find the card the first one took.
    seed(group);
    expect((await pay("hotel-a")).status).toBe(200);
    expect((await pay("hotel-b")).status).toBe(200);
    expect(state.customers).toHaveLength(1);
    // Owner-keyed and nothing property-specific on it — see the identical-
    // parameters test above for why the hotel must stay off this customer.
    expect(state.customers[0]).toMatchObject({ metadata: { user_id: USER } });
    expect((state.customers[0].metadata as Row).hotel_id).toBeUndefined();
    expect(state.customerOpts[0]).toMatchObject({ idempotencyKey: `maya_customer_user_${USER}` });
    expect(state.sessions[1].customer).toBe(state.sessions[0].customer);
    // Each session is still its own property's.
    expect((state.sessions[0].metadata as Row).hotel_id).toBe("hotel-a");
    expect((state.sessions[1].metadata as Row).hotel_id).toBe("hotel-b");
  });

  it("asks Checkout to list the card the first sibling saved, without a second consent box", async () => {
    // Sharing the customer is not enough. Subscription-mode Checkout stamps the
    // card it collects allow_redisplay=limited, and Checkout only lists `always`
    // by default — so without this the second sibling's Checkout showed an
    // empty card form and no sign of the card just entered
    // (docs.stripe.com/payments/checkout/save-during-payment?payment-ui=stripe-hosted).
    // The consent to offer it again is in the Terms of Service accepted at
    // signup, so Checkout's own "save for later" box must not come back: toEqual
    // fails on a payment_method_save key as well as on a missing filter.
    seed(group);
    expect((await pay("hotel-a")).status).toBe(200);
    expect((await pay("hotel-b")).status).toBe(200);
    for (const s of state.sessions) {
      expect(s.saved_payment_method_options).toEqual({
        allow_redisplay_filters: ["always", "limited"],
      });
    }
    // The card still has to be collected: it is what starts billing after the
    // trial and what the 48-hour re-check confirms.
    expect(state.sessions[1].payment_method_collection).toBe("always");
  });

  it("still finds a customer minted before owners were stamped on them", async () => {
    // Search on user_id misses, the older hotel_id search still hits.
    seed(group);
    state.customers.push({ email: "gm@driftwood.example", metadata: { hotel_id: "hotel-a" } });
    expect((await pay("hotel-a")).status).toBe(200);
    expect(state.customers).toHaveLength(1);
    expect(lastSession()?.customer).toBe("cus_test_1");
  });

  it("without a named property, pays for the oldest parked one", async () => {
    seed(group);
    const res = await post({ rooms: 12, interval: "month", code: "", pmsType: "cloudbeds" });
    expect(res.status).toBe(200);
    expect(lastSession()?.metadata).toMatchObject({ hotel_id: "hotel-a" });
  });
});
