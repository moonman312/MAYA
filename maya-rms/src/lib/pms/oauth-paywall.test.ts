/**
 * Connecting a PMS is the step that turns a signup into a working property, so
 * this endpoint is what payment actually gates. It used to require nothing but a
 * session — and /login hands those out to anyone — which meant one URL bought a
 * permanent property for free. These tests exist so that cannot come back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ step: "connect" as string, userId: "user-1" as string | null }));

vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
    rpc: async () => ({ data: false, error: null }),
  }),
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
