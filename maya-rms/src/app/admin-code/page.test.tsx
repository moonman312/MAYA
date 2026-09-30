/**
 * The code step's page: only a developer or sales login that has not entered
 * its code sees it. Past the code, or a platform admin, goes on to the
 * Command Center; signed out goes to sign in; anyone else to the app.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ session: null as unknown }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/admin/staff-session", () => ({ getStaffSession: async () => state.session }));
vi.mock("@/components/admin/staff-code-step", () => ({ StaffCodeStep: () => <i data-c="code-step" /> }));
vi.mock("@/components/brand/logo", () => ({ MayaMark: () => null }));

const { default: AdminCodePage } = await import("./page");

async function open(): Promise<string> {
  try {
    return renderToStaticMarkup(await AdminCodePage());
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

beforeEach(() => {
  state.session = null;
});

describe("/admin-code", () => {
  it("asks a developer or sales login for its code, and offers a way out", async () => {
    state.session = { ok: false, reason: "mfa_required", userId: "u1", email: "sales@example.com", role: "sales" };
    const html = await open();
    expect(html).toContain('data-c="code-step"');
    expect(html).toContain("sales@example.com");
    expect(html).toContain("Sales");
    expect(html).toContain('action="/auth/logout"');
  });

  it("sends everyone else where they belong", async () => {
    state.session = { ok: true, userId: "u1", email: "", role: "developer", aal: "aal2", sections: ["home"], isPlatformAdmin: false };
    expect(await open()).toBe("REDIRECT /admin");
    state.session = { ok: true, userId: "u1", email: "", role: "platform_admin", aal: "aal1", sections: ["home"], isPlatformAdmin: true };
    expect(await open()).toBe("REDIRECT /admin");
    state.session = { ok: false, reason: "signed_out" };
    expect(await open()).toBe("REDIRECT /login?next=/admin");
    state.session = { ok: false, reason: "not_staff", userId: "u1", email: "" };
    expect(await open()).toBe("REDIRECT /");
  });
});
