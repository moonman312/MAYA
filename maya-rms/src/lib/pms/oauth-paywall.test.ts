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
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
    rpc: async () => ({ data: false, error: null }),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
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
  signState: () => "signed-hotel-state",
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
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/access code/i);
  });
});
