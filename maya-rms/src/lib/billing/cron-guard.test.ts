import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stripe: true,
  admin: true,
  problems: [] as { key: string; title: string; detail: string; quietForMs?: number }[],
}));

vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => state.stripe }));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => state.admin,
  createAdminClient: () => ({}),
}));
vi.mock("./problems", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./problems")>()),
  recordBillingProblem: async (_admin: unknown, p: { key: string; title: string; detail: string }, o: { quietForMs?: number } = {}) => {
    state.problems.push({ ...p, quietForMs: o.quietForMs });
    return { recorded: true };
  },
}));

const { guardBillingCron } = await import("./cron-guard");

const SECRET = "billing-cron-secret-value";
const req = (secret?: string) =>
  new Request("http://localhost/api/billing/reconcile", {
    method: "POST",
    headers: secret ? { "x-billing-cron-secret": secret } : {},
  });

beforeEach(() => {
  process.env.BILLING_CRON_SECRET = SECRET;
  state.stripe = true;
  state.admin = true;
  state.problems = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("guardBillingCron", () => {
  it("lets the right secret through", async () => {
    expect(await guardBillingCron(req(SECRET), "testRoute")).toBeNull();
    expect(state.problems).toEqual([]);
  });

  it("refuses a missing or wrong secret without telling anyone: that is a stranger, not a fault", async () => {
    expect((await guardBillingCron(req(), "testRoute"))?.status).toBe(401);
    expect((await guardBillingCron(req("nope"), "testRoute"))?.status).toBe(401);
    expect(state.problems).toEqual([]);
  });

  it("is down without BILLING_CRON_SECRET, and hands that to a person", async () => {
    delete process.env.BILLING_CRON_SECRET;
    const res = await guardBillingCron(req(SECRET), "testRoute");
    expect(res?.status).toBe(503);
    expect(state.problems).toEqual([
      expect.objectContaining({ key: "billing-cron-secret-missing", quietForMs: 6 * 3600_000 }),
    ]);
    expect(state.problems[0].detail).toContain("testRoute");
  });

  it("is down without a Stripe key, and says so", async () => {
    state.stripe = false;
    expect((await guardBillingCron(req(SECRET), "testRoute"))?.status).toBe(503);
    expect(state.problems.map((p) => p.key)).toEqual(["billing-cron-not-configured"]);
  });

  it("cannot write a problem without the service role, and is still down", async () => {
    delete process.env.BILLING_CRON_SECRET;
    state.admin = false;
    expect((await guardBillingCron(req(SECRET), "testRoute"))?.status).toBe(503);
    expect(state.problems).toEqual([]);
  });
});
