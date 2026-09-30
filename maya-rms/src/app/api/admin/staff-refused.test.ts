/**
 * Every Command Center route that changes something, or reads with the
 * service role, refuses a developer or sales login, whether or not it has
 * entered its code: the session is real and staff, but not a platform
 * admin, so requirePlatformAdmin answers 403 (God Mode's own route is
 * refused by the database) and the service role is never touched. Found by
 * globbing, so a new route is covered as soon as it exists.
 */
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  aal: "aal2" as "aal1" | "aal2",
  rpc: [] as string[],
  serviceRole: 0,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }) }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("next/cache", async (orig) => ({
  ...(await orig<typeof import("next/cache")>()),
  updateTag: () => {
    throw new Error("nothing is thrown away for staff");
  },
}));
vi.mock("@/utils/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => {
    state.serviceRole += 1;
    throw new Error("the service role must not be reached by staff");
  },
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "dev-1", email: "developer@example.com" } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }),
      getClaims: async () => ({ data: { claims: { sub: "dev-1", aal: state.aal } }, error: null }),
    },
    rpc: async (fn: string) => {
      state.rpc.push(fn);
      if (fn === "is_platform_admin") return { data: false, error: null };
      if (fn === "staff_role") return { data: "developer", error: null };
      if (fn === "god_mode_status") return { data: { admin: false, aal: state.aal, active: false }, error: null };
      // What the database says to a staff login about anything that changes something.
      return { data: null, error: { code: "42501", message: "Only MAYA staff can turn on God Mode." } };
    },
    from: () => {
      throw new Error("no table read expected");
    },
  }),
}));

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
/** Every route.ts under /api/admin, as "./hotels/[hotelId]/simulation/route.ts". */
const ROUTES: Record<string, () => Promise<Record<string, Handler>>> = Object.fromEntries(
  readdirSync(__dirname, { recursive: true, encoding: "utf8" })
    .filter((f) => basename(f) === "route.ts")
    .map((f) => [
      `./${f.split("\\").join("/")}`,
      () => import(/* @vite-ignore */ resolve(__dirname, f)) as Promise<Record<string, Handler>>,
    ]),
);

const PARAMS = {
  hotelId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
  pendingId: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444",
  codeId: "55555555-5555-4555-8555-555555555555",
  pmsType: "cloudbeds",
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function request(method: string): Request {
  return new Request("http://localhost/api/admin/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({ role: "platform_admin", isTest: true, simulationMode: false, email: "x@example.com" }),
  });
}

beforeEach(() => {
  state.rpc = [];
  state.serviceRole = 0;
  delete process.env.BILLING_CRON_SECRET;
});

describe("every /api/admin route, for a developer or sales login", () => {
  it("is found here", () => {
    expect(Object.keys(ROUTES).length).toBeGreaterThanOrEqual(20);
  });

  for (const aal of ["aal1", "aal2"] as const) {
    it(`refuses every change and every service-role read at ${aal}`, async () => {
      state.aal = aal;
      const answered: string[] = [];
      for (const [path, load] of Object.entries(ROUTES)) {
        const mod = await load();
        for (const method of METHODS) {
          const handler = mod[method];
          if (typeof handler !== "function") continue;
          const res = await handler(request(method), { params: Promise.resolve(PARAMS) });
          if (path === "./god-mode/route.ts" && method === "GET") {
            // Only whether God Mode is on for the caller: it never is.
            expect(await res.json()).toEqual({ admin: false });
            continue;
          }
          answered.push(`${method} ${path} ${res.status}`);
          expect([method, path, [401, 403].includes(res.status)]).toEqual([method, path, true]);
        }
      }
      expect(answered.length).toBeGreaterThanOrEqual(25);
      expect(state.serviceRole).toBe(0);
      expect(state.rpc).not.toContain("platform_set_staff_role");
      expect(state.rpc).not.toContain("platform_grant_role");
    });
  }
});

describe("the analytics page's Refresh, for a sales login", () => {
  it("is refused: writing today's numbers and throwing the kept ones away is a platform admin's", async () => {
    const { refreshAnalytics } = await import("@/app/admin/analytics/actions");
    expect(await refreshAnalytics()).toEqual({ ok: false, error: "Only a platform admin can refresh these numbers." });
    expect(state.serviceRole).toBe(0);
  });
});
