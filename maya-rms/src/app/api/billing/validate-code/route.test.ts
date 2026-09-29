/**
 * The green line under the code box says what the code grants. On a restart
 * checkout grants no trial of any kind, so the line and the effect the panel
 * prices from must leave the free days out, and say so for a code that is
 * only free days.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ codes: [] as Record<string, unknown>[] }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
// Only the one read checkCode makes for a code with no redemption cap.
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        ilike: (_col: string, typed: string) => ({
          maybeSingle: async () => ({
            data: state.codes.find((c) => String(c.code).toUpperCase() === typed.toUpperCase()) ?? null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: async () => null }));

const { POST } = await import("./route");

const base = {
  percent_off: null,
  amount_off_cents: null,
  duration_months: null,
  max_redemptions: null,
  expires_at: null,
  is_active: true,
  stripe_coupon_id: null,
};

beforeEach(() => {
  state.codes = [
    { ...base, id: "code-1", code: "MHSFOUNDER", kind: "trial", trial_days: 30 },
    { ...base, id: "code-2", code: "WELCOME75", kind: "percent_off", trial_days: 7, percent_off: 75 },
  ];
});

async function check(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/billing/validate-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res.json();
}

describe("POST /api/billing/validate-code", () => {
  it("promises a trial code's free days on a first signup", async () => {
    expect(await check({ code: "MHSFOUNDER", interval: "month" })).toEqual({
      valid: true,
      grants: "30 days free, then your normal rate. We'll ask for a card now but won't charge it until the trial ends.",
      effect: { trialDays: 30 },
    });
  });

  it("says a trial code's free days don't apply to a restart", async () => {
    expect(await check({ code: "MHSFOUNDER", interval: "month", restart: true })).toEqual({
      valid: true,
      grants: "This code's 30 free days don't apply to a restart, so it doesn't change your price.",
      effect: {},
    });
  });

  it("keeps a code's discount on a restart, without its free days", async () => {
    expect(await check({ code: "WELCOME75", interval: "month", restart: true })).toEqual({
      valid: true,
      grants: "75% off, for as long as you stay.",
      effect: { percentOff: 75, discountDuration: "forever" },
    });
  });
});
