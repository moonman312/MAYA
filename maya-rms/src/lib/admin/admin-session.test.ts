/**
 * The Command Center's per-request check: the session from getClaims (no
 * Auth round trip with signing keys), the role from the database, and never
 * getUser.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  claimsError: null as { message: string } | null,
  isAdmin: true as unknown,
  rpcError: null as { message: string } | null,
  calls: [] as string[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getClaims: async () => (fake.calls.push("getClaims"), { data: fake.claims ? { claims: fake.claims } : null, error: fake.claimsError }),
      getUser: async () => {
        fake.calls.push("getUser");
        throw new Error("getUser is an Auth round trip");
      },
    },
    rpc: async (name: string, args: unknown) => (fake.calls.push(`${name}:${JSON.stringify(args)}`), { data: fake.isAdmin, error: fake.rpcError }),
  }),
}));

const { getAdminSession } = await import("./admin-session");

beforeEach(() => {
  fake.claims = { sub: "u1", email: "jake@example.com" };
  fake.claimsError = null;
  fake.isAdmin = true;
  fake.rpcError = null;
  fake.calls = [];
});

describe("getAdminSession", () => {
  it("lets a platform admin in, with the role checked by the database", async () => {
    expect(await getAdminSession()).toEqual({ ok: true, userId: "u1", email: "jake@example.com" });
    expect(fake.calls).toEqual(["getClaims", 'is_platform_admin:{"p_user_id":"u1"}']);
  });

  it("says signed out without asking the database when there is no valid session", async () => {
    fake.claims = null;
    fake.claimsError = { message: "Invalid JWT signature" };
    expect(await getAdminSession()).toEqual({ ok: false, reason: "signed_out" });
    expect(fake.calls).toEqual(["getClaims"]);
  });

  it("turns away anyone the database doesn't call a platform admin, and a failed check", async () => {
    fake.isAdmin = false;
    expect(await getAdminSession()).toEqual({ ok: false, reason: "not_admin" });
    fake.isAdmin = null;
    fake.rpcError = { message: "boom" };
    expect(await getAdminSession()).toEqual({ ok: false, reason: "not_admin" });
  });
});
