/**
 * "Send a test line" for #maya-signups: the database posts it through the
 * webhook in Vault (signup_feed_test), asked under the admin's own session.
 * Only a platform admin gets through, it is throttled, every try is in the
 * audit log, and the answer says plainly what is missing and where.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const state = vi.hoisted(() => ({
  isAdmin: true,
  throttled: false,
  answer: { data: { sent: true, state: "ready", request_id: 7 }, error: null } as { data: unknown; error: unknown },
  calls: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/admin/require-platform-admin", () => ({
  requirePlatformAdmin: async () => {
    const ssr = {
      rpc: async (fn: string, args?: unknown) => {
        state.calls.push({ fn, args });
        return fn === "signup_feed_test" ? state.answer : { data: null, error: null };
      },
    };
    return state.isAdmin
      ? { ok: true, user: { id: "admin-1", email: "ops@mhs.test" }, ssr, admin: ssr }
      : { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: async (name: string) =>
    state.throttled ? NextResponse.json({ error: `throttled:${name}` }, { status: 429 }) : null,
}));

const { POST } = await import("./route");

beforeEach(() => {
  state.isAdmin = true;
  state.throttled = false;
  state.answer = { data: { sent: true, state: "ready", request_id: 7 }, error: null };
  state.calls = [];
});

const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error ?? "";

describe("POST /api/admin/signups-feed/test", () => {
  it("asks the database for one test line, and records the try", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.calls.map((c) => c.fn)).toEqual(["signup_feed_test", "platform_log_event"]);
    expect(state.calls[1].args).toMatchObject({ p_event_type: "signups_feed.test_sent", p_detail: { sent: true } });
  });

  it("says where the webhook goes when Vault has none, or a plain http one", async () => {
    state.answer = { data: { sent: false, state: "missing" }, error: null };
    let res = await POST();
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatch(/no maya_signups_webhook in Vault yet/);
    state.answer = { data: { sent: false, state: "not_https" }, error: null };
    res = await POST();
    expect(await errorOf(res)).toMatch(/isn't an https:\/\/ address/);
    state.answer = { data: { sent: false, state: "post_failed", error: "schema \"net\" does not exist" }, error: null };
    res = await POST();
    expect(await errorOf(res)).toMatch(/Check that pg_net is enabled/);
  });

  it("names the migration before it has run", async () => {
    state.answer = { data: null, error: { code: "PGRST202", message: "Could not find the function public.signup_feed_test without parameters" } };
    const res = await POST();
    expect(await errorOf(res)).toContain("99_supabase_migration_signups_feed_v1.sql");
  });

  it("is a platform admin's, and throttled", async () => {
    state.isAdmin = false;
    expect((await POST()).status).toBe(403);
    expect(state.calls).toEqual([]);
    state.isAdmin = true;
    state.throttled = true;
    const res = await POST();
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe("throttled:signupsFeedTest");
    expect(state.calls).toEqual([]);
  });
});
