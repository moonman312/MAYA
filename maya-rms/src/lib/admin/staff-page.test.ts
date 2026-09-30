/**
 * The first line of every Command Center page: signed out goes to sign in, a
 * developer or sales login before its code goes to the code step, anyone who
 * is not staff goes to the app, and a page outside the role's sections goes
 * back to the Command Center's first page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAFF_ROLE_SECTIONS, STAFF_SECTIONS, type StaffRole, type StaffSection } from "./staff-sections";
import type { StaffSession } from "./staff-session";

const state = vi.hoisted(() => ({ session: null as unknown }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("./staff-session", async () => ({
  getStaffSession: async () => state.session,
  staffCanSee: (session: StaffSession, section: StaffSection) => session.ok && session.sections.includes(section),
}));

const { requireStaffPage, staffSessionRedirect } = await import("./staff-page");

function staff(role: StaffRole): StaffSession {
  return {
    ok: true,
    userId: "u1",
    email: "staff@example.com",
    role,
    aal: role === "platform_admin" ? "aal1" : "aal2",
    sections: [...STAFF_ROLE_SECTIONS[role]],
    isPlatformAdmin: role === "platform_admin",
  };
}

async function outcome(section: StaffSection): Promise<string> {
  try {
    await requireStaffPage(section);
    return "in";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

beforeEach(() => {
  state.session = null;
});

describe("requireStaffPage", () => {
  it("sends someone signed out to sign in, with the Command Center to come back to", async () => {
    state.session = { ok: false, reason: "signed_out" };
    expect(await outcome("home")).toBe("REDIRECT /login?next=/admin");
  });

  it("sends a developer or sales login to the code step before aal2, whatever the page", async () => {
    for (const role of ["developer", "sales"] as const) {
      state.session = { ok: false, reason: "mfa_required", userId: "u1", email: "x@example.com", role };
      for (const section of STAFF_SECTIONS) expect(await outcome(section)).toBe("REDIRECT /admin-code");
    }
  });

  it("sends a login with no staff role to the app", async () => {
    state.session = { ok: false, reason: "not_staff", userId: "u1", email: "x@example.com" };
    expect(await outcome("hotels")).toBe("REDIRECT /");
  });

  it("lets each role into exactly its sections, and sends it home from the rest", async () => {
    for (const role of ["platform_admin", "developer", "sales"] as const) {
      state.session = staff(role);
      for (const section of STAFF_SECTIONS) {
        const allowed = STAFF_ROLE_SECTIONS[role].includes(section);
        expect([role, section, await outcome(section)]).toEqual([role, section, allowed ? "in" : "REDIRECT /admin"]);
      }
    }
  });

  it("hands back the session for the page to use", async () => {
    state.session = staff("sales");
    await expect(requireStaffPage("analytics")).resolves.toMatchObject({ role: "sales", isPlatformAdmin: false });
  });

  it("never loops on the first page: no home section goes to the app", async () => {
    state.session = { ...staff("sales"), sections: ["analytics"] };
    expect(await outcome("home")).toBe("REDIRECT /");
  });
});

describe("staffSessionRedirect", () => {
  it("names where each kind of refusal goes", () => {
    expect(staffSessionRedirect({ ok: false, reason: "signed_out" })).toBe("/login?next=/admin");
    expect(staffSessionRedirect({ ok: false, reason: "mfa_required", userId: "u", email: "", role: "sales" })).toBe("/admin-code");
    expect(staffSessionRedirect({ ok: false, reason: "not_staff", userId: "u", email: "" })).toBe("/");
  });
});
