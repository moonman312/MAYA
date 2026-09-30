import "server-only";
import { redirect } from "next/navigation";
import { STAFF_CODE_PATH, type StaffSection } from "./staff-sections";
import { getStaffSession, staffCanSee, type StaffSession } from "./staff-session";

export type StaffPageSession = Extract<StaffSession, { ok: true }>;

/**
 * Where someone who may not see the Command Center goes instead: signed out
 * to sign in, a developer or sales login before its code to the code step,
 * anyone else to the app.
 */
export function staffSessionRedirect(session: Exclude<StaffSession, { ok: true }>): string {
  switch (session.reason) {
    case "signed_out":
      return "/login?next=/admin";
    case "mfa_required":
      return STAFF_CODE_PATH;
    default:
      return "/";
  }
}

/**
 * The first line of every Command Center page. The layout checks the person
 * is staff past the code, but a layout is not re-run on every navigation and
 * cannot see which page it wraps, so each page asks for its own section here,
 * on the server. A section the role does not have goes back to the Command
 * Center's first page. The session is React-cached, so the layout and the
 * page make one staff_access() call between them.
 *
 * This decides what a page shows. The database checks the section again on
 * every read (staff_can_read), and every write keeps requiring a platform
 * admin.
 */
export async function requireStaffPage(section: StaffSection): Promise<StaffPageSession> {
  const session = await getStaffSession();
  if (!session.ok) redirect(staffSessionRedirect(session));
  if (!staffCanSee(session, section)) redirect(section === "home" ? "/" : "/admin");
  return session;
}
