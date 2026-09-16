/**
 * Pins how the portal link is scoped for a Marketplace group, and what happens
 * when Stripe refuses the scoping.
 *
 * One owner's customer bills every property in the group, so a General Manager
 * of one property would see the whole group in a full portal. The route
 * narrows the session with flow_data — but a flow is only accepted while its
 * feature is switched on in the portal configuration, which is a dashboard
 * toggle. These check the narrowing happens when it should, that a refused flow
 * is answered with a refusal (loudly, naming the toggle) and NEVER with the
 * full portal, and that unrelated Stripe failures fail the same way.
 *
 * Same shape as ../checkout/route.test.ts: an in-memory Supabase and a Stripe
 * client that records what it was asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const USER = "user-1";
const HOTEL = "hotel-a";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  adminConfigured: true,
  portalCalls: [] as Record<string, unknown>[],
  // What sessions.create does, per call, in order. Missing = succeed.
  portalPlan: [] as Array<null | (() => never)>,
}));

function fakeSupabase() {
  const rows = (t: string) => state.tables[t] ?? [];
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      neq(col: string, val: unknown) {
        filters.push((r) => r[col] !== val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      // findPendingHotelForUser's shapes: not(col, "is", null) and is(col, null).
      not(col: string) {
        filters.push((r) => r[col] != null);
        return api;
      },
      is(col: string) {
        filters.push((r) => r[col] == null);
        return api;
      },
      order: () => api,
      limit: () => api,
      async maybeSingle() {
        return { data: rows(table).find((r) => filters.every((f) => f(r))) ?? null, error: null };
      },
      then(resolve: (v: unknown) => void) {
        return Promise.resolve({ data: rows(table).filter((r) => filters.every((f) => f(r))), error: null }).then(
          resolve,
        );
      },
    };
    return api;
  }
  return {
    from: (t: string) => builder(t),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: USER } } } }),
      getUser: async () => ({ data: { user: { id: USER } } }),
    },
  };
}

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => fakeSupabase() }));
vi.mock("@/lib/require-supabase-hotel", () => ({
  requireSupabaseHotelRank: async () => ({ ok: true, supabase: fakeSupabase(), hotelId: HOTEL }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => fakeSupabase(),
  isAdminConfigured: () => state.adminConfigured,
}));
vi.mock("@/lib/billing/stripe", () => ({
  isStripeConfigured: () => true,
  stripeClient: () => ({
    billingPortal: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          state.portalCalls.push(args);
          const step = state.portalPlan[state.portalCalls.length - 1];
          if (step) step();
          return { url: `https://billing.stripe.test/session/${state.portalCalls.length}` };
        },
      },
    },
  }),
}));

const { POST } = await import("./route");

/** The billing page's button sends no body; the onboarding link sends { pending: true }. */
function portalRequest(body?: unknown) {
  return new Request("http://localhost/api/billing/portal", {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

/** The shape the Stripe SDK throws: rawType is what the API sent, type is the class name. */
function stripeError(fields: { message: string; rawType?: string; param?: string; type?: string }) {
  const err = new Error(fields.message) as Error & Record<string, unknown>;
  err.type = fields.type ?? "StripeInvalidRequestError";
  err.rawType = fields.rawType ?? "invalid_request_error";
  if (fields.param) err.param = fields.param;
  return err;
}
const throwing = (err: Error) => () => {
  throw err;
};

const subscribed = (hotelId: string, extra: Row = {}) => ({
  hotel_id: hotelId,
  stripe_customer_id: "cus_owner",
  stripe_subscription_id: `sub_${hotelId}`,
  status: "active",
  ...extra,
});

beforeEach(() => {
  state.tables = {};
  state.adminConfigured = true;
  state.portalCalls = [];
  state.portalPlan = [];
  vi.stubEnv("MAYA_INVITE_REDIRECT_BASE", "https://maya.example.com/");
});

const lastCall = () => state.portalCalls.at(-1) as Record<string, unknown>;

describe("a property billed on its own customer", () => {
  it("opens the full portal with no flow", async () => {
    state.tables = { hotel_subscriptions: [subscribed(HOTEL)] };
    const res = await POST(portalRequest());
    expect(res.status).toBe(200);
    expect(state.portalCalls).toHaveLength(1);
    expect(lastCall().flow_data).toBeUndefined();
    expect(lastCall()).toMatchObject({ customer: "cus_owner", return_url: "https://maya.example.com/account/billing" });
  });

  it("answers 404 when nothing was ever set up through checkout", async () => {
    const res = await POST(portalRequest());
    expect(res.status).toBe(404);
    expect(state.portalCalls).toHaveLength(0);
  });
});

describe("a Marketplace group on the owner's one customer", () => {
  const group = () => ({
    hotel_subscriptions: [subscribed(HOTEL), subscribed("hotel-b")],
    hotel_memberships: [
      { hotel_id: HOTEL, user_id: USER, role: "general_manager", status: "active" },
      // Below General Manager on the sibling: the caller must not see it.
      { hotel_id: "hotel-b", user_id: USER, role: "revenue_manager", status: "active" },
    ],
  });

  it("narrows the portal to this hotel's subscription and comes back here afterwards", async () => {
    state.tables = group();
    const res = await POST(portalRequest());
    expect(res.status).toBe(200);
    expect(lastCall().flow_data).toEqual({
      type: "subscription_update",
      subscription_update: { subscription: `sub_${HOTEL}` },
      after_completion: { type: "redirect", redirect: { return_url: "https://maya.example.com/account/billing" } },
    });
  });

  it("falls back to the card-on-file flow when this hotel has no subscription id", async () => {
    const g = group();
    g.hotel_subscriptions[0] = subscribed(HOTEL, { stripe_subscription_id: null });
    state.tables = g;
    await POST(portalRequest());
    expect(lastCall().flow_data).toMatchObject({ type: "payment_method_update" });
  });

  it("opens the full portal when the caller can manage every property on the customer", async () => {
    const g = group();
    g.hotel_memberships[1].role = "hotel_admin";
    state.tables = g;
    await POST(portalRequest());
    expect(lastCall().flow_data).toBeUndefined();
  });

  it("narrows when it cannot tell — no service role to read the siblings with", async () => {
    state.tables = group();
    state.adminConfigured = false;
    await POST(portalRequest());
    expect(lastCall().flow_data).toBeDefined();
  });
});

describe("when Stripe refuses the flow because the portal feature is off", () => {
  const group = () => ({
    hotel_subscriptions: [subscribed(HOTEL), subscribed("hotel-b")],
    hotel_memberships: [
      { hotel_id: HOTEL, user_id: USER, role: "general_manager", status: "active" },
      { hotel_id: "hotel-b", user_id: USER, role: "revenue_manager", status: "active" },
    ],
  });

  it("answers 502 without a second attempt, and names the dashboard toggle in the log", async () => {
    // The flow was set BECAUSE the caller is below General Manager on hotel-b.
    // An unscoped retry would open hotel-b's subscription and card to them,
    // so there is none: exactly one call to Stripe, and a refusal.
    state.tables = group();
    state.portalPlan = [
      throwing(
        stripeError({
          message: "You cannot use `flow_data` of type `subscription_update` because that feature is not enabled in your portal configuration.",
          param: "flow_data[type]",
        }),
      ),
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(portalRequest());

    expect(res.status).toBe(502);
    expect(state.portalCalls).toHaveLength(1);
    expect(state.portalCalls[0].flow_data).toBeDefined();
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/account owner/);
    expect(body.error).not.toContain("flow_data");
    const logged = String(errors.mock.calls[0]?.[0]);
    expect(logged).toContain("portal_flow_disabled");
    expect(logged).toContain("Customer portal");
    expect(logged).toContain("subscription_update");
    errors.mockRestore();
  });

  it("recognises the refusal from the message alone when Stripe sends no param — still no retry", async () => {
    state.tables = group();
    state.portalPlan = [
      throwing(stripeError({ message: "The subscription_update feature is disabled for this configuration." })),
    ];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(portalRequest());
    expect(res.status).toBe(502);
    expect(state.portalCalls).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe("when Stripe fails for any other reason", () => {
  it("does not retry, answers 502, and keeps Stripe's wording out of the response", async () => {
    // No portal configuration at all — exactly what a fresh sandbox has. A
    // second call would fail the same way, so there is none.
    state.tables = { hotel_subscriptions: [subscribed(HOTEL)] };
    state.portalPlan = [
      throwing(
        stripeError({
          message:
            "No configuration provided and your test mode default configuration has not been created. Provide a configuration or create your default by saving your customer portal settings in test mode at https://dashboard.stripe.com/test/settings/billing/portal.",
        }),
      ),
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(portalRequest());
    expect(res.status).toBe(502);
    expect(state.portalCalls).toHaveLength(1);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("dashboard.stripe.com");
    // The operator gets told what to click.
    expect(String(errors.mock.calls[0]?.[0])).toContain("Customer portal");
    errors.mockRestore();
  });

  it("does not treat an unrelated invalid_request_error on a scoped session as a flow refusal", async () => {
    state.tables = {
      hotel_subscriptions: [subscribed(HOTEL), subscribed("hotel-b")],
      hotel_memberships: [
        { hotel_id: HOTEL, user_id: USER, role: "general_manager", status: "active" },
        { hotel_id: "hotel-b", user_id: USER, role: "revenue_manager", status: "active" },
      ],
    };
    state.portalPlan = [throwing(stripeError({ message: "No such customer: 'cus_owner'", param: "customer" }))];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(portalRequest());
    expect(res.status).toBe(502);
    expect(state.portalCalls).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe("a property that has paid but not connected its PMS yet", () => {
  const PENDING = "hotel-pending";
  const pendingHotel = (id: string) => ({ id, is_active: false, setup_pending_at: "2026-09-10T14:08:00Z", setup_deferred_at: null });
  const own = () => ({
    hotels: [pendingHotel(PENDING)],
    hotel_memberships: [{ hotel_id: PENDING, user_id: USER, role: "hotel_admin", status: "active" }],
    hotel_subscriptions: [subscribed(PENDING, { stripe_customer_id: "cus_pending", status: "trialing" })],
  });

  it("opens the portal straight onto cancelling that subscription, and comes back to onboarding", async () => {
    state.tables = own();
    const res = await POST(portalRequest({ pending: true }));
    expect(res.status).toBe(200);
    expect(state.portalCalls).toHaveLength(1);
    expect(lastCall()).toEqual({
      customer: "cus_pending",
      return_url: "https://maya.example.com/onboarding",
      flow_data: {
        type: "subscription_cancel",
        subscription_cancel: { subscription: `sub_${PENDING}` },
        after_completion: { type: "redirect", redirect: { return_url: "https://maya.example.com/onboarding" } },
      },
    });
  });

  it("refuses another user's pending property", async () => {
    // Same shape, but the membership belongs to someone else. Nothing in the
    // request names a hotel, so there is nothing to point at theirs with.
    const t = own();
    t.hotel_memberships = [{ hotel_id: PENDING, user_id: "someone-else", role: "hotel_admin", status: "active" }];
    state.tables = t;
    const res = await POST(portalRequest({ pending: true }));
    expect(res.status).toBe(404);
    expect(state.portalCalls).toHaveLength(0);
  });

  it("refuses a member below General Manager", async () => {
    const t = own();
    t.hotel_memberships[0].role = "revenue_manager";
    state.tables = t;
    expect((await POST(portalRequest({ pending: true }))).status).toBe(404);
    expect(state.portalCalls).toHaveLength(0);
  });

  it("has nothing to offer once the property is connected, or the subscription has ended", async () => {
    const connected = own();
    connected.hotels = [{ ...pendingHotel(PENDING), is_active: true, setup_pending_at: null as unknown as string }];
    state.tables = connected;
    expect((await POST(portalRequest({ pending: true }))).status).toBe(404);

    const ended = own();
    ended.hotel_subscriptions[0].status = "canceled";
    state.tables = ended;
    expect((await POST(portalRequest({ pending: true }))).status).toBe(404);
    expect(state.portalCalls).toHaveLength(0);
  });

  it("offers nothing to cancel on a subscription already set to cancel", async () => {
    const t = own();
    (t.hotel_subscriptions[0] as Row).cancel_at_period_end = true;
    state.tables = t;
    expect((await POST(portalRequest({ pending: true }))).status).toBe(404);
    expect(state.portalCalls).toHaveLength(0);
  });

  it("finds the live subscription beside a canceled one, and prefers the property on screen", async () => {
    const OLD = "hotel-old";
    const NEW = "hotel-new";
    const t = {
      hotels: [
        { ...pendingHotel(OLD), created_at: "2026-09-01T00:00:00Z" },
        { ...pendingHotel(PENDING), created_at: "2026-09-02T00:00:00Z" },
        { ...pendingHotel(NEW), created_at: "2026-09-03T00:00:00Z" },
      ],
      hotel_memberships: [OLD, PENDING, NEW].map((id) => ({ hotel_id: id, user_id: USER, role: "hotel_admin", status: "active" })),
      hotel_subscriptions: [
        subscribed(OLD, { stripe_customer_id: "cus_pending", status: "canceled" }),
        subscribed(PENDING, { stripe_customer_id: "cus_pending", status: "trialing" }),
        subscribed(NEW, { stripe_customer_id: "cus_pending", status: "active" }),
      ],
    };
    state.tables = t;
    expect((await POST(portalRequest({ pending: true }))).status).toBe(200);
    expect(lastCall().flow_data).toMatchObject({ subscription_cancel: { subscription: `sub_${PENDING}` } });

    expect((await POST(portalRequest({ pending: true, hotelId: NEW }))).status).toBe(200);
    expect(lastCall().flow_data).toMatchObject({ subscription_cancel: { subscription: `sub_${NEW}` } });

    // Pointing at a property that is not theirs picks nothing of anyone else's.
    expect((await POST(portalRequest({ pending: true, hotelId: "hotel-a-stranger" }))).status).toBe(200);
    expect(lastCall().flow_data).toMatchObject({ subscription_cancel: { subscription: `sub_${PENDING}` } });
  });

  it("never falls back to the full portal when Stripe refuses the cancel flow", async () => {
    state.tables = own();
    state.portalPlan = [
      throwing(stripeError({ message: "The subscription_cancel feature is disabled.", param: "flow_data[type]" })),
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(portalRequest({ pending: true }));
    expect(res.status).toBe(502);
    expect(state.portalCalls).toHaveLength(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("features.subscription_cancel");
    errors.mockRestore();
  });
});
