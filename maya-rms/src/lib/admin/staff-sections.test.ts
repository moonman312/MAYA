/**
 * The app's copy of what each staff role may read, held to the database's
 * (staff_role_sections in 99_supabase_migration_staff_roles_v1.sql), and the
 * path and role helpers the Command Center builds its pages from.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PATH_SECTIONS,
  STAFF_ROLE_CHOICES,
  STAFF_ROLE_LABELS,
  STAFF_ROLE_SECTIONS,
  STAFF_ROLES,
  STAFF_SECTIONS,
  isStaffRole,
  isStaffRoleChoice,
  isStaffSection,
  sectionForAdminPath,
  staffRoleNeedsMfa,
  staffRoleOf,
} from "./staff-sections";

const MIGRATION = resolve(__dirname, "../../../../99_supabase_migration_staff_roles_v1.sql");

/** staff_role_sections()'s map, read off the migration. */
function sqlSections(): Record<string, string[]> {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("create or replace function public.staff_role_sections(");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/when '(\w+)' then array\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  }
  return out;
}

describe("the staff sections", () => {
  it("match the database's map, role for role and section for section", () => {
    const sql = sqlSections();
    expect(Object.keys(sql).sort()).toEqual([...STAFF_ROLES].sort());
    for (const role of STAFF_ROLES) expect([...STAFF_ROLE_SECTIONS[role]].sort(), role).toEqual([...sql[role]].sort());
    expect([...STAFF_SECTIONS].sort()).toEqual([...sql.platform_admin].sort());
  });

  it("keep money, analytics, stalled signups, invites and codes from the developer", () => {
    for (const s of ["business_numbers", "analytics", "stalled_signups", "pending_invites", "signup_codes", "hotel_create"] as const) {
      expect(STAFF_ROLE_SECTIONS.developer).not.toContain(s);
    }
  });

  it("keep staff management, PMS Access, team lists, invites and codes from sales", () => {
    for (const s of ["users", "pms_access", "hotel_team", "pending_invites", "signup_codes", "hotel_create"] as const) {
      expect(STAFF_ROLE_SECTIONS.sales).not.toContain(s);
    }
  });

  it("give every Command Center page a section", () => {
    const pages = ["/admin", "/admin/analytics", "/admin/docs-questions", "/admin/hotels", "/admin/hotels/new", "/admin/pending-invites",
      "/admin/pilot-health", "/admin/pms-access", "/admin/signup-codes", "/admin/stalled-signups", "/admin/users"];
    expect(ADMIN_PATH_SECTIONS.map(([p]) => p).sort()).toEqual(pages.sort());
    for (const [, section] of ADMIN_PATH_SECTIONS) expect(isStaffSection(section)).toBe(true);
  });
});

describe("sectionForAdminPath", () => {
  it("finds the most specific page, on whole path segments", () => {
    expect(sectionForAdminPath("/admin")).toBe("home");
    expect(sectionForAdminPath("/admin/")).toBe("home");
    expect(sectionForAdminPath("/admin/hotels")).toBe("hotels");
    expect(sectionForAdminPath("/admin/hotels/11111111-1111-4111-8111-111111111111")).toBe("hotels");
    expect(sectionForAdminPath("/admin/hotels/new")).toBe("hotel_create");
    expect(sectionForAdminPath("/admin/hotels/newest")).toBe("hotels");
    expect(sectionForAdminPath("/admin/analytics?from=2026-09-01")).toBe("analytics");
    expect(sectionForAdminPath("/admin/users#top")).toBe("users");
    expect(sectionForAdminPath("/admin/usersx")).toBe("home");
  });

  it("says null outside the Command Center", () => {
    expect(sectionForAdminPath("/")).toBeNull();
    expect(sectionForAdminPath("/administrator")).toBeNull();
    expect(sectionForAdminPath("/dashboard")).toBeNull();
  });
});

describe("the role helpers", () => {
  it("read a login's role from its app roles, the strongest first", () => {
    expect(staffRoleOf(null)).toBe("none");
    expect(staffRoleOf([])).toBe("none");
    expect(staffRoleOf(["platform_support"])).toBe("none");
    expect(staffRoleOf(["sales"])).toBe("sales");
    expect(staffRoleOf(["sales", "developer"])).toBe("developer");
    expect(staffRoleOf(["developer", "platform_admin"])).toBe("platform_admin");
  });

  it("offer None, Developer, Sales and Platform admin, and know them", () => {
    expect(STAFF_ROLE_CHOICES.map((c) => STAFF_ROLE_LABELS[c])).toEqual(["None", "Developer", "Sales", "Platform admin"]);
    expect(isStaffRoleChoice("none")).toBe(true);
    expect(isStaffRoleChoice("platform_support")).toBe(false);
    expect(isStaffRole("none")).toBe(false);
    expect(isStaffRole("sales")).toBe(true);
    expect(isStaffSection("nonsense")).toBe(false);
  });

  it("ask the two read-only roles for a code, never a platform admin", () => {
    expect(staffRoleNeedsMfa("developer")).toBe(true);
    expect(staffRoleNeedsMfa("sales")).toBe(true);
    expect(staffRoleNeedsMfa("platform_admin")).toBe(false);
  });
});
