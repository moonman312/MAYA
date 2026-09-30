/**
 * Who is looking at the Command Center: the session from getClaims (pages)
 * or getUser (read-only routes), the role, aal and sections from the
 * database's staff_access(), and a developer or sales login sent to the code
 * step until its token is aal2. Anything unexpected means less access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  user: null as { id: string; email?: string } | null,
  access: null as unknown,
  accessError: null as { code?: string; message: string } | null,
  isAdmin: false as unknown,
  staffRole: null as unknown,
  staffRoleError: null as { code?: string; message: string } | null,
  claimsThrows: false,
  calls: [] as string[],
}));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/utils/supabase/shared", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getClaims: async () => {
        fake.calls.push("getClaims");
        if (fake.claimsThrows) throw new Error("JWT has expired");
        return { data: fake.claims ? { claims: fake.claims } : null, error: fake.claims ? null : { message: "no session" } };
      },
      getUser: async () => (fake.calls.push("getUser"), { data: { user: fake.user } }),
    },
    rpc: async (name: string) => {
      fake.calls.push(name);
      if (name === "staff_access") return { data: fake.access, error: fake.accessError };
      if (name === "is_platform_admin") return { data: fake.isAdmin, error: null };
      if (name === "staff_role") return { data: fake.staffRole, error: fake.staffRoleError };
      return { data: null, error: { message: `unexpected ${name}` } };
    },
  }),
}));

const { getStaffSession, loadStaffRole, parseStaffAccess, requireStaffSection, staffCanSee, STAFF_MFA_REQUIRED } = await import(
  "./staff-session"
);
const { STAFF_SECTIONS } = await import("./staff-sections");

const DEV_SECTIONS = ["docs_questions", "home", "hotel_team", "hotels", "pilot_health", "pms_access", "users"];

beforeEach(() => {
  fake.claims = { sub: "u1", email: "dev@example.com" };
  fake.user = { id: "u1", email: "dev@example.com" };
  fake.access = null;
  fake.accessError = null;
  fake.isAdmin = false;
  fake.staffRole = null;
  fake.staffRoleError = null;
  fake.claimsThrows = false;
  fake.calls = [];
});

describe("getStaffSession", () => {
  it("lets a platform admin in at any sign-in, with every section", async () => {
    fake.access = { role: "platform_admin", aal: "aal1", mfa_required: false, sections: [...STAFF_SECTIONS] };
    expect(await getStaffSession()).toEqual({
      ok: true,
      userId: "u1",
      email: "dev@example.com",
      role: "platform_admin",
      aal: "aal1",
      sections: [...STAFF_SECTIONS],
      isPlatformAdmin: true,
    });
    expect(fake.calls).toEqual(["getClaims", "staff_access"]);
  });

  it("sends a developer to the code step before aal2, and in with their sections after", async () => {
    fake.access = { role: "developer", aal: "aal1", mfa_required: true, sections: [] };
    expect(await getStaffSession()).toEqual({ ok: false, reason: "mfa_required", userId: "u1", email: "dev@example.com", role: "developer" });
    fake.access = { role: "developer", aal: "aal2", mfa_required: false, sections: DEV_SECTIONS };
    const session = await getStaffSession();
    expect(session).toMatchObject({ ok: true, role: "developer", aal: "aal2", sections: DEV_SECTIONS, isPlatformAdmin: false });
    expect(staffCanSee(session, "users")).toBe(true);
    expect(staffCanSee(session, "analytics")).toBe(false);
  });

  it("turns away a login with no staff role, and says signed out without a session", async () => {
    fake.access = { role: null, aal: "aal2", mfa_required: false, sections: [] };
    expect(await getStaffSession()).toEqual({ ok: false, reason: "not_staff", userId: "u1", email: "dev@example.com" });
    fake.claims = null;
    fake.calls = [];
    expect(await getStaffSession()).toEqual({ ok: false, reason: "signed_out" });
    expect(fake.calls).toEqual(["getClaims"]);
  });

  it("says signed out when the token is broken, and never asks the Auth server", async () => {
    fake.claimsThrows = true;
    expect(await getStaffSession()).toEqual({ ok: false, reason: "signed_out" });
    expect(fake.calls).toEqual(["getClaims"]);
  });

  it("reads a failed check as no access", async () => {
    fake.accessError = { code: "42501", message: "boom" };
    expect(await getStaffSession()).toMatchObject({ ok: false, reason: "not_staff" });
  });

  it("keeps a platform admin in on a database the migration has not reached, and nobody else", async () => {
    fake.accessError = { code: "PGRST202", message: "Could not find the function public.staff_access" };
    fake.isAdmin = true;
    expect(await getStaffSession()).toMatchObject({ ok: true, role: "platform_admin", sections: [...STAFF_SECTIONS] });
    fake.isAdmin = false;
    expect(await getStaffSession()).toMatchObject({ ok: false, reason: "not_staff" });
  });
});

describe("parseStaffAccess", () => {
  it("never takes more than the role allows, nor sections before the code", () => {
    expect(parseStaffAccess({ role: "sales", aal: "aal2", mfa_required: false, sections: ["analytics", "users", "nonsense"] })).toEqual({
      role: "sales",
      aal: "aal2",
      mfaRequired: false,
      sections: ["analytics"],
    });
    expect(parseStaffAccess({ role: "sales", aal: "aal1", mfa_required: false, sections: ["analytics"] })).toEqual({
      role: "sales",
      aal: "aal1",
      mfaRequired: true,
      sections: [],
    });
    expect(parseStaffAccess({ role: "owner", aal: "aal2", sections: ["users"] })).toEqual({ role: null, aal: "aal2", mfaRequired: false, sections: [] });
    expect(parseStaffAccess(null)).toEqual({ role: null, aal: "aal1", mfaRequired: false, sections: [] });
  });
});

describe("requireStaffSection", () => {
  it("hands a staff member past the code their own session client for a section they may read", async () => {
    fake.access = { role: "developer", aal: "aal2", mfa_required: false, sections: DEV_SECTIONS };
    const ctx = await requireStaffSection({} as never, "pms_access");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx).toMatchObject({ role: "developer", isPlatformAdmin: false });
      expect("admin" in ctx).toBe(false);
    }
    expect(fake.calls).toEqual(["getUser", "staff_access"]);
  });

  it("answers 403 for a section the role does not have, and asks for the code before aal2", async () => {
    fake.access = { role: "developer", aal: "aal2", mfa_required: false, sections: DEV_SECTIONS };
    const denied = await requireStaffSection({} as never, "analytics");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);

    fake.access = { role: "sales", aal: "aal1", mfa_required: true, sections: [] };
    const mfa = await requireStaffSection({} as never, "analytics");
    expect(mfa.ok).toBe(false);
    if (!mfa.ok) {
      expect(mfa.response.status).toBe(403);
      expect(await mfa.response.json()).toEqual({ error: STAFF_MFA_REQUIRED, mfa_required: true });
    }
  });

  it("answers 401 signed out and 403 for someone who is not staff", async () => {
    fake.user = null;
    const out = await requireStaffSection({} as never, "hotels");
    expect(!out.ok && out.response.status).toBe(401);
    fake.user = { id: "u2" };
    fake.access = { role: null, aal: "aal2", mfa_required: false, sections: [] };
    const stranger = await requireStaffSection({} as never, "hotels");
    expect(!stranger.ok && stranger.response.status).toBe(403);
  });
});

describe("loadStaffRole", () => {
  const ssr = async () => (await import("@/utils/supabase/server")).createClient({} as never);

  it("is the database's answer: a staff role, or null for anything else", async () => {
    for (const role of ["platform_admin", "developer", "sales"]) {
      fake.staffRole = role;
      expect(await loadStaffRole(await ssr(), "u1")).toBe(role);
    }
    for (const other of [null, "platform_support", "owner", 7]) {
      fake.staffRole = other;
      expect(await loadStaffRole(await ssr(), "u1")).toBeNull();
    }
  });

  it("falls back to is_platform_admin on a database the migration has not reached, and to nothing on any other error", async () => {
    fake.staffRoleError = { code: "PGRST202", message: "Could not find the function public.staff_role" };
    fake.isAdmin = true;
    expect(await loadStaffRole(await ssr(), "u1")).toBe("platform_admin");
    fake.isAdmin = false;
    expect(await loadStaffRole(await ssr(), "u1")).toBeNull();
    fake.staffRoleError = { code: "42501", message: "boom" };
    fake.isAdmin = true;
    expect(await loadStaffRole(await ssr(), "u1")).toBeNull();
  });
});
