/**
 * MAYA staff roles and what each may read in the Command Center
 * (99_supabase_migration_staff_roles_v1.sql). Plain data, safe to import
 * from client components: the nav, the role picker.
 *
 * The database decides. staff_access() answers who is looking, and
 * staff_can_read(section) is the check inside every staff-readable policy
 * and function, so a hidden link is never the only thing in the way. This
 * copy of the map is for building pages and links; a test keeps it in step
 * with staff_role_sections() in the migration.
 *
 *   platform_admin  everything, at any sign-in, as before. God Mode.
 *   developer       read only, after a code from an authenticator app.
 *   sales           read only, after a code from an authenticator app.
 */

export const STAFF_ROLES = ["platform_admin", "developer", "sales"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** What the Users page's role picker offers. "none" takes every staff role away. */
export const STAFF_ROLE_CHOICES = ["none", "developer", "sales", "platform_admin"] as const;
export type StaffRoleChoice = (typeof STAFF_ROLE_CHOICES)[number];

export const STAFF_ROLE_LABELS: Record<StaffRoleChoice, string> = {
  none: "None",
  developer: "Developer",
  sales: "Sales",
  platform_admin: "Platform admin",
};

/**
 * Command Center pages, plus two parts of a page: hotel_team (a property's
 * team list on its page) and business_numbers (money: MRR on the hotel list,
 * and a property's occupancy, ADR and revenue).
 */
export const STAFF_SECTIONS = [
  "analytics",
  "business_numbers",
  "docs_questions",
  "home",
  "hotel_create",
  "hotel_team",
  "hotels",
  "pending_invites",
  "pilot_health",
  "pms_access",
  "signup_codes",
  "stalled_signups",
  "users",
] as const;
export type StaffSection = (typeof STAFF_SECTIONS)[number];

export const STAFF_ROLE_SECTIONS: Record<StaffRole, readonly StaffSection[]> = {
  platform_admin: STAFF_SECTIONS,
  developer: ["docs_questions", "home", "hotel_team", "hotels", "pilot_health", "pms_access", "users"],
  sales: ["analytics", "business_numbers", "docs_questions", "home", "hotels", "pilot_health", "stalled_signups"],
};

/**
 * Each Command Center path and the section it belongs to. The most specific
 * prefix wins, on whole path segments: /admin/hotels/new is hotel_create,
 * /admin/hotels/<id> is hotels, /admin itself is home.
 */
export const ADMIN_PATH_SECTIONS: ReadonlyArray<readonly [path: string, section: StaffSection]> = [
  ["/admin", "home"],
  ["/admin/analytics", "analytics"],
  ["/admin/docs-questions", "docs_questions"],
  ["/admin/hotels", "hotels"],
  ["/admin/hotels/new", "hotel_create"],
  ["/admin/pending-invites", "pending_invites"],
  ["/admin/pilot-health", "pilot_health"],
  ["/admin/pms-access", "pms_access"],
  ["/admin/signup-codes", "signup_codes"],
  ["/admin/stalled-signups", "stalled_signups"],
  ["/admin/users", "users"],
];

/** The section a Command Center path belongs to, or null for a path outside /admin. */
export function sectionForAdminPath(pathname: string): StaffSection | null {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  let best: readonly [string, StaffSection] | null = null;
  for (const entry of ADMIN_PATH_SECTIONS) {
    const [prefix] = entry;
    if ((path === prefix || path.startsWith(`${prefix}/`)) && (!best || prefix.length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

export function isStaffRoleChoice(value: unknown): value is StaffRoleChoice {
  return typeof value === "string" && (STAFF_ROLE_CHOICES as readonly string[]).includes(value);
}

export function isStaffSection(value: unknown): value is StaffSection {
  return typeof value === "string" && (STAFF_SECTIONS as readonly string[]).includes(value);
}

/**
 * A login's staff role from the app_roles it holds (platform_list_users'
 * platform_roles), the strongest first, as staff_role() reads it.
 */
export function staffRoleOf(appRoles: readonly string[] | null | undefined): StaffRoleChoice {
  for (const role of STAFF_ROLES) if (appRoles?.includes(role)) return role;
  return "none";
}

/** Whether a role that only reads needs a code from an authenticator app first. Platform admins do not. */
export function staffRoleNeedsMfa(role: StaffRole): boolean {
  return role !== "platform_admin";
}
