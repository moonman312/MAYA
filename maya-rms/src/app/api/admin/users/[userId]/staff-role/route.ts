import { GOD_MODE_OFF_FOR_STAFF, requireGodMode } from "@/lib/admin/god-mode";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { isStaffRoleChoice } from "@/lib/admin/staff-sections";
import { setStaffRole } from "@/lib/admin/users";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * The Users page's role picker: leaves the person with exactly one staff role
 * (None, Developer, Sales or Platform admin). A platform admin's action, in
 * God Mode, like the platform-admin route beside it: a developer or sales
 * login is refused here and by the database. The call runs under the admin's
 * own session, so platform_set_staff_role checks God Mode again, writes the
 * audit line in the admin's name, and refuses to remove the last platform
 * admin with a sentence shown as it is.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const godMode = await requireGodMode(ctx.ssr, GOD_MODE_OFF_FOR_STAFF);
  if (!godMode.ok) return godMode.response;
  const { userId } = await params;

  const body = (await req.json().catch(() => null)) as { role?: unknown } | null;
  const role = body?.role;
  if (!isStaffRoleChoice(role)) {
    return NextResponse.json({ error: "Choose None, Developer, Sales or Platform admin." }, { status: 400 });
  }

  try {
    const result = await setStaffRole(ctx.ssr, userId, role);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 400 });
  }
}
