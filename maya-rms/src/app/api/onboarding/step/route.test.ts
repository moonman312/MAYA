/**
 * The step endpoint exists to be polled, so the interesting case is the
 * throttle: past the budget it answers 429 before resolveOnboardingStep runs,
 * because each resolution is auth round trips and queries — the exact cost the
 * ceiling is there to cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "user-1" as string | null,
  limiter: { allowed: true, hits: 1, resets_at: "2026-07-31T01:00:00Z" },
}));
const resolveOnboardingStep = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: state.userId ? { id: state.userId } : null },
      }),
    },
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({
    rpc: () => ({ maybeSingle: async () => ({ data: state.limiter, error: null }) }),
  }),
}));
vi.mock("@/lib/onboarding/step", () => ({ resolveOnboardingStep }));

const { GET } = await import("./route");

beforeEach(() => {
  state.userId = "user-1";
  state.limiter = { allowed: true, hits: 1, resets_at: "2026-07-31T01:00:00Z" };
  resolveOnboardingStep.mockReset();
  resolveOnboardingStep.mockResolvedValue("connect");
});

describe("GET /api/onboarding/step", () => {
  it("401 when signed out", async () => {
    state.userId = null;
    expect((await GET()).status).toBe(401);
  });

  it("answers with the caller's step", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ step: "connect" });
  });

  it("429 past the budget, before any step resolution work", async () => {
    state.limiter = { allowed: false, hits: 200, resets_at: "2026-07-31T01:00:00Z" };
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(resolveOnboardingStep).not.toHaveBeenCalled();
  });
});
