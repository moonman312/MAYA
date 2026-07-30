/**
 * Auth tests for the card re-verification cron route.
 *
 * The route writes hotel_subscriptions with the service-role client, so the
 * shared secret is the entire authorization. These pin the three ways that can
 * go wrong: an unset secret making it permissive, a wrong secret getting
 * through, and a signed-in caller having any path in at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  swept: 0,
  result: { examined: 2, verified: 1, failed: 1, deferred: 0, moot: 0, errors: [] as string[] },
}));

vi.mock("@/lib/billing/reverify", () => ({
  sweepCardReverification: async () => {
    state.swept += 1;
    return state.result;
  },
}));

vi.mock("@/lib/billing/stripe", () => ({
  isStripeConfigured: () => true,
  stripeClient: () => ({}),
}));

vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({}),
}));

const { POST } = await import("./route");

const SECRET = "cron-secret-value";

function post(headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/billing/reverify", {
      method: "POST",
      headers,
      body: JSON.stringify({ scheduled_at: "2026-07-31T12:00:00Z" }),
    }),
  );
}

beforeEach(() => {
  process.env.BILLING_CRON_SECRET = SECRET;
  state.swept = 0;
});

describe("cron secret", () => {
  it("is down rather than permissive when the secret is unset", async () => {
    delete process.env.BILLING_CRON_SECRET;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ "x-billing-cron-secret": SECRET });
    expect(res.status).toBe(503);
    expect(state.swept).toBe(0);
    spy.mockRestore();
  });

  it("refuses a request with no secret at all", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(state.swept).toBe(0);
  });

  it("refuses a wrong secret", async () => {
    const res = await post({ "x-billing-cron-secret": "not-the-secret-value" });
    expect(res.status).toBe(401);
    expect(state.swept).toBe(0);
  });

  it("refuses a secret of the wrong length", async () => {
    // The constant-time compare needs equal lengths, so the length guard has to
    // reject rather than throw.
    const res = await post({ "x-billing-cron-secret": "short" });
    expect(res.status).toBe(401);
    expect(state.swept).toBe(0);
  });

  it("gives a signed-in caller no way in", async () => {
    // No cookie or bearer token is read anywhere in the route; a session is not
    // an alternative to the secret.
    const res = await post({
      cookie: "sb-access-token=a-real-looking-session",
      authorization: "Bearer a-real-looking-jwt",
    });
    expect(res.status).toBe(401);
    expect(state.swept).toBe(0);
  });

  it("runs the sweep and reports what it did for the right secret", async () => {
    const res = await post({ "x-billing-cron-secret": SECRET });
    expect(res.status).toBe(200);
    expect(state.swept).toBe(1);
    expect(await res.json()).toMatchObject({ ok: true, examined: 2, verified: 1, failed: 1 });
  });

  it("answers 200 with the errors listed rather than making cron replay the batch", async () => {
    state.result = { examined: 1, verified: 0, failed: 0, deferred: 1, moot: 0, errors: ["deadlock"] };
    const res = await post({ "x-billing-cron-secret": SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, errors: ["deadlock"] });
  });
});
