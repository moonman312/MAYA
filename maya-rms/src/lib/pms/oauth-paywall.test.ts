/**
 * Connecting a PMS is the step that turns a signup into a working property, so
 * this endpoint is what payment actually gates. It used to require nothing but a
 * session — and /login hands those out to anyone — which meant one URL bought a
 * permanent property for free. These tests exist so that cannot come back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  step: "connect" as string,
  userId: "user-1" as string | null,
  stripeConfigured: true,
  gateRequired: true,
  pendingHotelId: "hotel-1" as string | null,
  signupCodeId: "code-1" as string | null,
  /** The caller's role on hotel-1, for the reconnect (hotel) target. */
  role: null as string | null,
  /**
   * The user id in the session cookie's user object, which the browser can
   * edit. Null leaves it matching the signed-in user.
   */
  cookieUserId: null as string | null,
  platformAdmin: false,
  /** The platform admin holds an open God Mode window, ending at this instant. */
  godModeUntil: null as string | null,
  signed: [] as unknown[][],
  supportChanges: [] as Record<string, unknown>[],
}));

const RANK: Record<string, number> = { viewer: 10, revenue_manager: 20, general_manager: 30, hotel_admin: 40 };

/** Other members of hotel-1. Any member may read every row of their hotel. */
const OTHER_MEMBERS: Record<string, string> = { "user-gm": "general_manager" };

vi.mock("@/utils/supabase/server", () => ({
  createClient: () => {
    const memberships = () => {
      let userId: unknown = null;
      const rows = () => {
        const role = userId === state.userId ? state.role : OTHER_MEMBERS[String(userId)];
        return role && state.userId ? [{ role }] : [];
      };
      const chain = {
        select: () => chain,
        limit: () => chain,
        eq: (col: string, value: unknown) => {
          if (col === "user_id") userId = value;
          return chain;
        },
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res),
      };
      return chain;
    };
    return {
      auth: {
        getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
        getSession: async () => ({
          data: { session: state.userId ? { user: { id: state.cookieUserId ?? state.userId } } : null },
        }),
      },
      from: memberships,
      // As the database answers, always for the user the access token proves
      // (auth.uid()): can_manage_hotel lets a Revenue Manager in,
      // can_manage_finances starts at General Manager.
      rpc: async (fn: string) => {
        const rank = state.userId ? (RANK[state.role ?? ""] ?? 0) : 0;
        if (fn === "is_platform_admin") return { data: state.platformAdmin, error: null };
        if (fn === "god_mode_active") return { data: state.platformAdmin && state.godModeUntil != null, error: null };
        if (fn === "god_mode_status") {
          const on = state.platformAdmin && state.godModeUntil != null;
          return {
            data: { admin: state.platformAdmin, aal: on ? "aal2" : "aal1", active: on, session_id: on ? "gm-1" : null, expires_at: state.godModeUntil },
            error: null,
          };
        }
        if (fn === "can_manage_hotel") return { data: rank >= RANK.revenue_manager, error: null };
        if (fn === "can_manage_finances") {
          return { data: state.platformAdmin || rank >= RANK.general_manager, error: null };
        }
        return { data: false, error: null };
      },
    };
  },
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "support_changes") state.supportChanges.push(row);
        return { error: null };
      },
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: state.signupCodeId ? { signup_code_id: state.signupCodeId } : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/billing/stripe", () => ({
  isStripeConfigured: () => state.stripeConfigured,
}));
vi.mock("@/lib/billing/pms-gates", () => ({
  pmsSignupCodeRequired: async () => state.gateRequired,
}));
vi.mock("@/lib/billing/pending-hotel", () => ({
  findPendingHotelForUser: async () => state.pendingHotelId,
}));
vi.mock("@/lib/onboarding/step", () => ({
  resolveOnboardingStep: async () => state.step,
}));
vi.mock("@/lib/onboarding/connect", () => ({ handleOnboardingConnect: async () => new Response() }));
vi.mock("@/lib/pms/oauth-state", () => ({
  signOnboardingState: () => "signed-onboarding-state",
  signState: (...args: unknown[]) => {
    state.signed.push(args);
    return "signed-hotel-state";
  },
  verifyState: () => null,
}));

const { buildAuthorizeRedirect } = await import("./oauth-flow");

beforeEach(() => {
  state.step = "connect";
  state.userId = "user-1";
  // The realistic default: gates on, and the subscription used a code.
  state.stripeConfigured = true;
  state.gateRequired = true;
  state.pendingHotelId = "hotel-1";
  state.signupCodeId = "code-1";
  state.role = null;
  state.cookieUserId = null;
  state.platformAdmin = false;
  state.godModeUntil = null;
  state.signed = [];
  state.supportChanges = [];
  process.env.CLOUDBEDS_CLIENT_ID = "test-client-id";
  process.env.MAYA_INVITE_REDIRECT_BASE = "https://app.example";
});

const authorize = () =>
  buildAuthorizeRedirect({} as never, "cloudbeds", { kind: "onboarding", userId: "user-1" } as never);

describe("onboarding PMS connect is behind the paywall", () => {
  it.each(["subscribe", "choose", "done"])(
    "refuses with 402 when the flow says the step is %s, not connect",
    async (step) => {
      state.step = step;
      const res = await authorize();
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string; billingUrl: string };
      // Told where to go, not just refused — a bare 402 is a dead end.
      expect(body.billingUrl).toBe("/onboarding");
      expect(body.error).toMatch(/payment/i);
    },
  );

  it("allows it once payment is done", async () => {
    state.step = "connect";
    const res = await authorize();
    // A redirect to the PMS, not an error.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("state=signed-onboarding-state");
  });

  it("still refuses an anonymous caller before it even asks about payment", async () => {
    state.userId = null;
    expect((await authorize()).status).toBe(401);
  });
});

describe("the per-PMS access-code gate at connect time", () => {
  // Checkout only demands a code for the PMS the buyer DECLARED. Without this
  // check, declaring an open PMS and then connecting a gated one walks past
  // the gate having paid but never shown a code.
  it("refuses a gated PMS when the subscription never used a code", async () => {
    state.gateRequired = true;
    state.signupCodeId = null;
    const res = await authorize();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/access code/i);
  });

  it("allows a gated PMS when the subscription carries a code", async () => {
    state.gateRequired = true;
    state.signupCodeId = "code-1";
    expect((await authorize()).status).toBe(302);
  });

  it("allows an open PMS with no code at all", async () => {
    state.gateRequired = false;
    state.signupCodeId = null;
    expect((await authorize()).status).toBe(302);
  });

  it("skips the gate entirely when Stripe is not configured", async () => {
    // The no-billing deployment escape hatch: there is no subscription to
    // carry a code, so the gate would block everyone.
    state.stripeConfigured = false;
    state.gateRequired = true;
    state.signupCodeId = null;
    expect((await authorize()).status).toBe(302);
  });

  it("refuses when there is no pending hotel to check against", async () => {
    // Stripe configured + step 'connect' should mean a paid pending hotel
    // exists; not finding one is an anomaly and anomalies don't get in.
    state.gateRequired = true;
    state.pendingHotelId = null;
    state.signupCodeId = null;
    expect((await authorize()).status).toBe(403);
  });

  it("never applies to an existing hotel's admin reconnect", async () => {
    // The hotel target is for properties that already exist — their gate was
    // passed (or waived by an admin) long ago.
    state.gateRequired = true;
    state.signupCodeId = null;
    const res = await buildAuthorizeRedirect({} as never, "cloudbeds", {
      kind: "hotel",
      hotelId: "hotel-1",
    } as never);
    // 403 would be the gate; this one fails later on manage rights instead,
    // proving the gate never ran for this target.
    expect(res.status).toBe(403);
    expect(await res.text()).not.toMatch(/access code/i);
  });

  it("lets a General Manager through to the PMS whatever the gate says", async () => {
    state.gateRequired = true;
    state.signupCodeId = null;
    state.role = "general_manager";
    const res = await reconnect();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("state=signed-hotel-state");
  });
});

const reconnect = () =>
  buildAuthorizeRedirect({} as never, "cloudbeds", { kind: "hotel", hotelId: "hotel-1" } as never);

describe("the reconnect link asks for the rank the Reconnect button does", () => {
  // The button is drawn for General Manager and up. The link used to take
  // can_manage_hotel, which a Revenue Manager passes, so the link reconnected
  // for someone who was never shown the button.
  it.each(["revenue_manager", "viewer"])("refuses a %s in plain words, never reaching the PMS", async (role) => {
    state.role = role;
    const res = await reconnect();
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    const text = await res.text();
    expect(text).toContain("Reconnecting needs General Manager access or higher on this property.");
    expect(text).not.toContain("—");
  });

  it("goes by who the sign-in proves, not the user id in the session cookie", async () => {
    // A Viewer who put the General Manager's id into their own cookie.
    state.role = "viewer";
    state.cookieUserId = "user-gm";
    const res = await reconnect();
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses someone with no role on the property", async () => {
    state.role = null;
    expect((await reconnect()).status).toBe(403);
  });

  it.each(["general_manager", "hotel_admin"])("sends a %s on to the PMS", async (role) => {
    state.role = role;
    const res = await reconnect();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("state=signed-hotel-state");
  });

  it("sends a platform admin on to the PMS", async () => {
    state.platformAdmin = true;
    expect((await reconnect()).status).toBe(302);
  });

  it("signs a God Mode reconnect to run out with the window, and records it as support's", async () => {
    state.platformAdmin = true;
    state.godModeUntil = "2026-09-29T12:30:00.000Z";
    expect((await reconnect()).status).toBe(302);
    expect(state.signed).toEqual([["hotel-1", "cloudbeds", undefined, { godModeUntilMs: Date.parse("2026-09-29T12:30:00.000Z") }]]);
    expect(state.supportChanges).toEqual([
      expect.objectContaining({ session_id: "gm-1", hotel_id: "hotel-1", table_name: "pms_connections" }),
    ]);
  });

  it("signs a member's reconnect as before, with no window", async () => {
    state.role = "general_manager";
    expect((await reconnect()).status).toBe(302);
    expect(state.signed).toEqual([["hotel-1", "cloudbeds", undefined, { godModeUntilMs: undefined }]]);
    expect(state.supportChanges).toEqual([]);
  });

  it("still answers a signed-out caller with 401", async () => {
    state.userId = null;
    expect((await reconnect()).status).toBe(401);
  });
});
