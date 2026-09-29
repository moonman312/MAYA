/**
 * A sign-in that takes longer than the 15 minutes a signed state lasts comes
 * back with a state that no longer verifies. It is still ours, so it must not
 * be read as a Marketplace grant: for ThinkReservations that ended on a
 * Marketplace error and a link to the staff console, and for Cloudbeds it
 * would park a second property. The person is told what happened and sent
 * back to MAYA, and the code is never spent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  verification: { ok: false, error: "State expired", expired: true } as Record<string, unknown>,
  marketplace: 0,
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("nothing should be written for a timed-out link");
  },
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: () => null }));
vi.mock("@/lib/pms/marketplace-connect", () => ({
  handleMarketplaceConnect: async () => {
    state.marketplace++;
    return { kind: "error", message: "think does not support marketplace-initiated connections." };
  },
}));
vi.mock("@/lib/onboarding/connect", () => ({ handleOnboardingConnect: async () => new Response() }));
vi.mock("@/lib/pms/oauth-state", () => ({
  signOnboardingState: () => "s",
  signState: () => "s",
  verifyState: () => state.verification,
}));

const { handleOAuthCallback } = await import("./oauth-flow");

type Cookies = Parameters<typeof handleOAuthCallback>[0];

const fetchSpy = vi.fn(async () =>
  new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 }),
);

beforeEach(() => {
  state.verification = { ok: false, error: "State expired", expired: true };
  state.marketplace = 0;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  process.env.THINK_CLIENT_ID = "id";
  process.env.THINK_CLIENT_SECRET = "secret";
  process.env.CLOUDBEDS_CLIENT_ID = "id";
  process.env.CLOUDBEDS_CLIENT_SECRET = "secret";
});

const callback = (pms: "think" | "cloudbeds") =>
  handleOAuthCallback({} as Cookies, pms, new URLSearchParams({ code: "abc", state: "signed-but-old" }));

describe("a sign-in link that ran out", () => {
  it.each(["think", "cloudbeds"] as const)("says so on %s and points back to MAYA, not the staff console", async (pms) => {
    const res = await callback(pms);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("That sign-in link ran out after 15 minutes. Start again from MAYA.");
    expect(text).toContain('href="/"');
    expect(text).not.toContain("/admin");
    expect(text).not.toContain("Command Center");
    expect(text).not.toContain("marketplace");
    expect(text).not.toContain("—");
  });

  it.each(["think", "cloudbeds"] as const)("never spends the code or goes down the Marketplace path on %s", async (pms) => {
    await callback(pms);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.marketplace).toBe(0);
  });

  it("still treats a state that does not verify at all as a Marketplace grant", async () => {
    state.verification = { ok: false, error: "Signature mismatch" };
    await callback("cloudbeds");
    expect(state.marketplace).toBe(1);
  });
});
