/**
 * The Users page's role picker. Only a platform admin can set a staff role
 * (a developer or sales login gets the plain 403 of requirePlatformAdmin),
 * only in God Mode, and only to None, Developer, Sales or Platform admin. The
 * call runs under the admin's own session, so the database checks God Mode
 * again, writes the audit line and refuses to remove the last platform
 * admin; that refusal comes back as it is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const LAST_ADMIN = "MAYA needs at least one platform admin. Make someone else a platform admin first.";

const state = vi.hoisted(() => ({
  caller: "admin" as "admin" | "developer" | "sales",
  status: { admin: true, aal: "aal2", active: true, session_id: "gm-1" } as Record<string, unknown>,
  setResult: { data: { user_id: "user-2", role: "developer", previous: ["sales"], changed: true }, error: null } as {
    data: unknown;
    error: { message: string } | null;
  },
  ssrRpc: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));

const ssr = {
  rpc: async (fn: string, args?: unknown) => {
    state.ssrRpc.push({ fn, args });
    if (fn === "god_mode_status") return { data: state.status, error: null };
    if (fn === "platform_set_staff_role") return state.setResult;
    return { data: null, error: null };
  },
};

vi.mock("@/lib/admin/require-platform-admin", () => ({
  requirePlatformAdmin: async () =>
    state.caller === "admin"
      ? { ok: true, user: { id: "admin-1" }, ssr, admin: {} }
      : { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) },
}));

const { PUT } = await import("./route");
const { GOD_MODE_OFF_FOR_STAFF } = await import("@/lib/admin/god-mode");

const params = { params: Promise.resolve({ userId: "user-2" }) };
const put = (body: unknown) =>
  PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), params);

beforeEach(() => {
  state.caller = "admin";
  state.status = { admin: true, aal: "aal2", active: true, session_id: "gm-1" };
  state.setResult = { data: { user_id: "user-2", role: "developer", previous: ["sales"], changed: true }, error: null };
  state.ssrRpc = [];
});

describe("PUT /api/admin/users/[userId]/staff-role", () => {
  it("sets the role under the admin's own session in God Mode, and says what changed", async () => {
    const res = await put({ role: "developer" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "developer", previous: ["sales"], changed: true });
    expect(state.ssrRpc).toEqual([
      { fn: "god_mode_status", args: undefined },
      { fn: "platform_set_staff_role", args: { p_user_id: "user-2", p_role: "developer" } },
    ]);
  });

  it("refuses a developer or sales login, and calls nothing", async () => {
    for (const caller of ["developer", "sales"] as const) {
      state.caller = caller;
      const res = await put({ role: "platform_admin" });
      expect(res.status).toBe(403);
    }
    expect(state.ssrRpc).toEqual([]);
  });

  it("refuses an admin outside God Mode, and sets nothing", async () => {
    state.status = { admin: true, aal: "aal1", active: false, session_id: null };
    const res = await put({ role: "sales" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: GOD_MODE_OFF_FOR_STAFF });
    expect(state.ssrRpc.map((c) => c.fn)).toEqual(["god_mode_status"]);
  });

  it("takes only None, Developer, Sales or Platform admin", async () => {
    for (const role of ["platform_support", "owner", "", null, 3]) {
      const res = await put({ role });
      expect(res.status).toBe(400);
    }
    expect(state.ssrRpc.map((c) => c.fn)).not.toContain("platform_set_staff_role");
  });

  it("passes on the database's refusal to remove the last platform admin, word for word", async () => {
    state.setResult = { data: null, error: { message: LAST_ADMIN } };
    const res = await put({ role: "none" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: LAST_ADMIN });
  });
});
