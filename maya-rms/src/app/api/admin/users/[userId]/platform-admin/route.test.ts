/**
 * Making someone MAYA staff is a God Mode action: an admin signed in with a
 * password only, or at aal2 with no window, is refused and nothing is
 * called; in God Mode the grant runs under the admin's own session, so the
 * database checks God Mode again and the audit line names them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: { admin: true, aal: "aal1", active: false, session_id: null } as Record<string, unknown>,
  ssrRpc: [] as Array<{ fn: string; args: unknown }>,
  adminRpc: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("server-only", () => ({}));

const ssr = {
  rpc: async (fn: string, args?: unknown) => {
    state.ssrRpc.push({ fn, args });
    if (fn === "god_mode_status") return { data: state.status, error: null };
    return { data: null, error: null };
  },
};
const admin = {
  rpc: async (fn: string, args?: unknown) => {
    state.adminRpc.push({ fn, args });
    return { data: null, error: null };
  },
};

vi.mock("@/lib/admin/require-platform-admin", () => ({
  requirePlatformAdmin: async () => ({ ok: true, user: { id: "admin-1" }, ssr, admin }),
}));

const { PUT, DELETE } = await import("./route");
const { GOD_MODE_OFF_FOR_STAFF } = await import("@/lib/admin/god-mode");

const params = { params: Promise.resolve({ userId: "user-2" }) };

beforeEach(() => {
  state.status = { admin: true, aal: "aal1", active: false, session_id: null };
  state.ssrRpc = [];
  state.adminRpc = [];
});

describe("PUT and DELETE /api/admin/users/[userId]/platform-admin", () => {
  it("refuses an admin signed in with only a password, and grants nothing", async () => {
    const res = await PUT(new Request("http://localhost/x", { method: "PUT" }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: GOD_MODE_OFF_FOR_STAFF });
    expect(state.ssrRpc.map((c) => c.fn)).toEqual(["god_mode_status"]);
    expect(state.adminRpc).toEqual([]);
  });

  it("refuses an admin at aal2 with no window open, for granting and for taking away", async () => {
    state.status = { admin: true, aal: "aal2", active: false, session_id: null };
    expect((await PUT(new Request("http://localhost/x", { method: "PUT" }), params)).status).toBe(403);
    expect((await DELETE(new Request("http://localhost/x", { method: "DELETE" }), params)).status).toBe(403);
    expect(state.ssrRpc.map((c) => c.fn)).toEqual(["god_mode_status", "god_mode_status"]);
    expect(state.adminRpc).toEqual([]);
  });

  it("in God Mode grants and revokes under the admin's own session, never the service role", async () => {
    state.status = { admin: true, aal: "aal2", active: true, session_id: "gm-1" };
    expect((await PUT(new Request("http://localhost/x", { method: "PUT" }), params)).status).toBe(200);
    expect((await DELETE(new Request("http://localhost/x", { method: "DELETE" }), params)).status).toBe(200);
    expect(state.ssrRpc).toEqual([
      { fn: "god_mode_status", args: undefined },
      { fn: "platform_grant_role", args: { p_user_id: "user-2", p_role: "platform_admin" } },
      { fn: "god_mode_status", args: undefined },
      { fn: "platform_revoke_role", args: { p_user_id: "user-2", p_role: "platform_admin" } },
    ]);
    expect(state.adminRpc).toEqual([]);
  });
});
