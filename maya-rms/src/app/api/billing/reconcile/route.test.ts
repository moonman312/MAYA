/**
 * The nightly Stripe check's cron route: the shared secret is the whole
 * authorization (lib/billing/cron-guard.ts), and a run hands back its counts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ swept: 0 }));

vi.mock("@/lib/billing/reconcile", () => ({
  sweepStripeReconcile: async () => {
    state.swept += 1;
    return { examined: 3, matched: 3, corrected: 0, recovered: 0, failed: 0, partial: false, differences: [], errors: [] };
  },
}));
vi.mock("@/lib/billing/stripe", () => ({ isStripeConfigured: () => true, stripeClient: () => ({}) }));
vi.mock("@/utils/supabase/admin", () => ({ isAdminConfigured: () => true, createAdminClient: () => ({}) }));

const { POST } = await import("./route");

const SECRET = "billing-cron-secret-value";
const post = (headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/billing/reconcile", { method: "POST", headers, body: "{}" }));

beforeEach(() => {
  process.env.BILLING_CRON_SECRET = SECRET;
  state.swept = 0;
});

describe("POST /api/billing/reconcile", () => {
  it("runs the check for the right secret and answers with its counts", async () => {
    const res = await post({ "x-billing-cron-secret": SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, examined: 3, matched: 3 });
    expect(state.swept).toBe(1);
  });

  it("refuses anyone else, and is down without its secret", async () => {
    expect((await post()).status).toBe(401);
    expect((await post({ "x-billing-cron-secret": "nope" })).status).toBe(401);
    delete process.env.BILLING_CRON_SECRET;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post({ "x-billing-cron-secret": SECRET })).status).toBe(503);
    spy.mockRestore();
    expect(state.swept).toBe(0);
  });
});
