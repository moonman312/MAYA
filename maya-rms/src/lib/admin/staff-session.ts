import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { isMissingFunction } from "./product-analytics";
import {
  STAFF_ROLE_SECTIONS,
  isStaffRole,
  isStaffSection,
  type StaffRole,
  type StaffSection,
} from "./staff-sections";

/**
 * Who is looking at the Command Center, and what they may read
 * (99_supabase_migration_staff_roles_v1.sql). One staff_access() call: the
 * database reads the caller from the token PostgREST verifies, so the role,
 * the token's aal and the sections are its answer, never the cookie's.
 *
 *   ok             staff who may read `sections` now. A platform admin at any
 *                  sign-in (as before); a developer or sales login at aal2.
 *   mfa_required   a developer or sales login whose token is not aal2 yet:
 *                  send them to the code step (enrol an authenticator the
 *                  first time), never to a Command Center page.
 *   not_staff      signed in, no staff role.
 *   signed_out     no valid session.
 *
 * The sections are for building pages. The database checks them again on
 * every read, so this is never the only thing in the way.
 */
export type StaffSession =
  | {
      ok: true;
      userId: string;
      email: string;
      role: StaffRole;
      aal: "aal1" | "aal2";
      sections: StaffSection[];
      isPlatformAdmin: boolean;
    }
  | { ok: false; reason: "signed_out" }
  | { ok: false; reason: "not_staff"; userId: string; email: string }
  | { ok: false; reason: "mfa_required"; userId: string; email: string; role: Exclude<StaffRole, "platform_admin"> };

export type StaffAccess = {
  role: StaffRole | null;
  aal: "aal1" | "aal2";
  mfaRequired: boolean;
  sections: StaffSection[];
};

const NOBODY: StaffAccess = { role: null, aal: "aal1", mfaRequired: false, sections: [] };

/**
 * The caller's staff access, from staff_access(). Any failure reads as no
 * access. On a database the migration has not reached yet, falls back to
 * is_platform_admin: a platform admin keeps every section, nobody else gets
 * any.
 */
export async function loadStaffAccess(ssr: SupabaseClient, userId: string): Promise<StaffAccess> {
  const { data, error } = await ssr.rpc("staff_access");
  if (error) {
    if (!isMissingFunction(error)) return NOBODY;
    const { data: isAdmin, error: adminError } = await ssr.rpc("is_platform_admin", { p_user_id: userId });
    return !adminError && isAdmin === true
      ? { role: "platform_admin", aal: "aal1", mfaRequired: false, sections: [...STAFF_ROLE_SECTIONS.platform_admin] }
      : NOBODY;
  }
  return parseStaffAccess(data);
}

/**
 * The caller's staff role, the strongest they hold, or null: staff_role(),
 * which reads the caller from the verified token. On a database the
 * migration has not reached yet, is_platform_admin answers. For the app's
 * own pages (the dashboard's Command Center link, and where a login with no
 * property goes), never for what a Command Center page shows: that is
 * getStaffSession's sections.
 */
export async function loadStaffRole(ssr: SupabaseClient, userId: string): Promise<StaffRole | null> {
  const { data, error } = await ssr.rpc("staff_role");
  if (!error) return isStaffRole(data) ? data : null;
  if (!isMissingFunction(error)) return null;
  const { data: isAdmin, error: adminError } = await ssr.rpc("is_platform_admin", { p_user_id: userId });
  return !adminError && isAdmin === true ? "platform_admin" : null;
}

/** staff_access()'s jsonb, read defensively: anything unexpected means less access, never more. */
export function parseStaffAccess(data: unknown): StaffAccess {
  if (!data || typeof data !== "object") return NOBODY;
  const raw = data as Record<string, unknown>;
  const role = isStaffRole(raw.role) ? raw.role : null;
  const aal = raw.aal === "aal2" ? "aal2" : "aal1";
  const allowed = role ? new Set<StaffSection>(STAFF_ROLE_SECTIONS[role]) : new Set<StaffSection>();
  const sections = Array.isArray(raw.sections) ? raw.sections.filter(isStaffSection).filter((s) => allowed.has(s)) : [];
  // A role that must enter a code is asked for it whatever the flag says, until the token is aal2.
  const mfaRequired = role !== null && role !== "platform_admin" && (raw.mfa_required === true || aal !== "aal2");
  return { role, aal, mfaRequired, sections: mfaRequired ? [] : sections };
}

function sessionFrom(userId: string, email: string, access: StaffAccess): StaffSession {
  if (!access.role) return { ok: false, reason: "not_staff", userId, email };
  if (access.mfaRequired && access.role !== "platform_admin") {
    return { ok: false, reason: "mfa_required", userId, email, role: access.role };
  }
  return {
    ok: true,
    userId,
    email,
    role: access.role,
    aal: access.aal,
    sections: access.sections,
    isPlatformAdmin: access.role === "platform_admin",
  };
}

/**
 * For Command Center pages and the admin layout: worked out once per request
 * (React's cache). The session is read with getClaims, which checks the
 * access token's signature against the project's published keys instead of
 * asking the Auth server every time, so there is no Auth round trip with
 * signing keys; what the person may read is still the database's answer.
 */
export const getStaffSession = cache(async (): Promise<StaffSession> => {
  const supabase = createClient(await cookies());
  const { data, error } = await supabase.auth.getClaims().catch((e: unknown) => ({ data: null, error: e }));
  const claims = data?.claims;
  const userId = typeof claims?.sub === "string" ? claims.sub : null;
  if (error || !userId) return { ok: false, reason: "signed_out" };
  const email = typeof claims?.email === "string" ? claims.email : "";
  return sessionFrom(userId, email, await loadStaffAccess(supabase, userId));
});

/** Whether this session may read the section. False for anything but an ok session. */
export function staffCanSee(session: StaffSession, section: StaffSection): boolean {
  return session.ok && session.sections.includes(section);
}

/** What a route says to a developer or sales login before the code. */
export const STAFF_MFA_REQUIRED = "Enter the code from your authenticator app first.";

export type RequireStaffSectionResult =
  | { ok: true; user: User; ssr: SupabaseClient; role: StaffRole; sections: StaffSection[]; isPlatformAdmin: boolean }
  | { ok: false; response: NextResponse };

/**
 * For a Command Center API route that only reads: signed in (asked of the
 * Auth server, as requirePlatformAdmin does), staff, past the code, and
 * allowed this section. Hands back the caller's own session client, so the
 * database checks the section again on the read. There is no service-role
 * client here on purpose: a route that writes, or writes on an admin's
 * behalf, keeps requirePlatformAdmin (and God Mode where it has it).
 */
export async function requireStaffSection(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  section: StaffSection,
): Promise<RequireStaffSectionResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, response: NextResponse.json({ error: "Supabase is not configured." }, { status: 503 }) };
  }
  const ssr = createClient(cookieStore);
  const {
    data: { user },
  } = await ssr.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const session = sessionFrom(user.id, user.email ?? "", await loadStaffAccess(ssr, user.id));
  if (!session.ok) {
    return session.reason === "mfa_required"
      ? { ok: false, response: NextResponse.json({ error: STAFF_MFA_REQUIRED, mfa_required: true }, { status: 403 }) }
      : { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (!session.sections.includes(section)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, user, ssr, role: session.role, sections: session.sections, isPlatformAdmin: session.isPlatformAdmin };
}
