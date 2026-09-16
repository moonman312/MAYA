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
    auth: { getSession: async () => ({ data: { session: { user: { id: USER } } } }) },
  };
}

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
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
    const res = await POST();
    expect(res.status).toBe(200);
    expect(state.portalCalls).toHaveLength(1);
    expect(lastCall().flow_data).toBeUndefined();
    expect(lastCall()).toMatchObject({ customer: "cus_owner", return_url: "https://maya.example.com/account/billing" });
  });

  it("answers 404 when nothing was ever set up through checkout", async () => {
    const res = await POST();
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
    const res = await POST();
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
    await POST();
    expect(lastCall().flow_data).toMatchObject({ type: "payment_method_update" });
  });

  it("opens the full portal when the caller can manage every property on the customer", async () => {
    const g = group();
    g.hotel_memberships[1].role = "hotel_admin";
    state.tables = g;
    await POST();
    expect(lastCall().flow_data).toBeUndefined();
  });

  it("narrows when it cannot tell — no service role to read the siblings with", async () => {
    state.tables = group();
    state.adminConfigured = false;
    await POST();
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
    const res = await POST();

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
    const res = await POST();
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
    const res = await POST();
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
    const res = await POST();
    expect(res.status).toBe(502);
    expect(state.portalCalls).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
