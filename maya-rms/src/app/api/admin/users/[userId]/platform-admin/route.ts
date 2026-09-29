import { GOD_MODE_OFF_FOR_STAFF, requireGodMode } from "@/lib/admin/god-mode";
import { grantAppRole, revokeAppRole } from "@/lib/admin/users";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Making someone MAYA staff, or taking it away. A new staff account can enrol
 * its own authenticator and open God Mode, so this is a God Mode action: an
 * admin signed in with only a password cannot hand out the role. The call
 * runs under the admin's own session, so the database checks God Mode too
 * (platform_grant_role in 99_supabase_migration_god_mode_v1.sql) and the
 * audit line names who did it.
 */
export async function PUT(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const godMode = await requireGodMode(ctx.ssr, GOD_MODE_OFF_FOR_STAFF);
  if (!godMode.ok) return godMode.response;
  const { userId } = await params;

  try {
    await grantAppRole(ctx.ssr, userId, "platform_admin");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const godMode = await requireGodMode(ctx.ssr, GOD_MODE_OFF_FOR_STAFF);
  if (!godMode.ok) return godMode.response;
  const { userId } = await params;

  try {
    await revokeAppRole(ctx.ssr, userId, "platform_admin");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}
