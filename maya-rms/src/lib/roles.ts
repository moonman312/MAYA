/**
 * Hotel roles: the hierarchy, in one place.
 *
 * Ranks mirror public.hotel_role_rank() in the database — the database is
 * the enforcement boundary (RLS plus the membership rank triggers), and this
 * module exists so the UI can offer the same choices the database would
 * accept, rather than presenting options that fail on save.
 *
 * Two capability tiers sit on top of the ranks:
 *   canManagePricing   Revenue Manager and up — rules, rates, floor and
 *                      ceiling guardrails, reverts, challenges.
 *   canManageFinances  General Manager and up — taking pricing live, the PMS
 *                      connection, billing, and who holds which role.
 */

export type HotelRole =
  | "hotel_admin"
  | "general_manager"
  | "revenue_manager"
  | "viewer";

export type HotelRoleInfo = {
  key: HotelRole;
  label: string;
  rank: number;
  /** One line an owner can act on, shown beside the role in pickers. */
  description: string;
};

/** Highest first — the order roles should appear in any picker. */
export const HOTEL_ROLES: HotelRoleInfo[] = [
  {
    key: "hotel_admin",
    label: "Hotel Admin",
    rank: 40,
    description: "Everything, including deleting the property.",
  },
  {
    key: "general_manager",
    label: "General Manager",
    rank: 30,
    description:
      "Everything except deleting the property: pricing, taking it live, the property system, billing, and team roles.",
  },
  {
    key: "revenue_manager",
    label: "Revenue Manager",
    rank: 20,
    description:
      "Day-to-day pricing: rules, rates, floor and ceiling guardrails, and reverting changes. Cannot take pricing live or change the team.",
  },
  // Staff used to sit here at rank 10 with the identical description below.
  // Merged into Viewer — see 99_supabase_migration_merge_staff_role_v1.sql —
  // because two roles granting the same thing is a distinction with no
  // difference, and the picker was making someone choose between them.
  { key: "viewer", label: "Viewer", rank: 0, description: "Can look, cannot change anything." },
];

const BY_KEY = new Map(HOTEL_ROLES.map((r) => [r.key, r]));

export function isHotelRole(value: string): value is HotelRole {
  return BY_KEY.has(value as HotelRole);
}

export function roleLabel(role: string): string {
  return BY_KEY.get(role as HotelRole)?.label ?? role;
}

export function roleRank(role: string): number {
  return BY_KEY.get(role as HotelRole)?.rank ?? -1;
}

/**
 * The roles someone may hand out: their own level and below. Matches the
 * database trigger, so the picker never offers a choice that would be
 * rejected on save. Platform admins get the full list.
 */
export function rolesAssignableBy(
  actorRole: string | null,
  opts: { isPlatformAdmin?: boolean } = {},
): HotelRoleInfo[] {
  if (opts.isPlatformAdmin) return HOTEL_ROLES;
  const actorRank = roleRank(actorRole ?? "");
  if (actorRank < roleRank("general_manager")) return [];
  return HOTEL_ROLES.filter((r) => r.rank <= actorRank);
}

/** Revenue Manager and up: may change pricing. */
export function canManagePricing(role: string | null): boolean {
  return roleRank(role ?? "") >= roleRank("revenue_manager");
}

/** General Manager and up: may change commercial state and the team. */
export function canManageFinances(role: string | null): boolean {
  return roleRank(role ?? "") >= roleRank("general_manager");
}
