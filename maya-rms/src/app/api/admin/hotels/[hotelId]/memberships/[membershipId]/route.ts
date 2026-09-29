import { recordSupportChange, requireGodMode } from "@/lib/admin/god-mode";
import { removeMembership, setMembershipRole } from "@/lib/admin/memberships";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import type { HotelRole } from "@/lib/admin/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** PATCH body: { userId, role }. A team edit: God Mode, and recorded. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ hotelId: string; membershipId: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const god = await requireGodMode(ctx.ssr);
  if (!god.ok) return god.response;
  const { hotelId, membershipId } = await params;

  let body: { userId: string; role: HotelRole };
  try {
    body = (await req.json()) as { userId: string; role: HotelRole };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.userId || !body.role) {
    return NextResponse.json({ error: "userId and role are required" }, { status: 400 });
  }

  try {
    await setMembershipRole(ctx.admin, {
      hotelId,
      userId: body.userId,
      role: body.role,
    });
    await recordSupportChange(ctx.admin, {
      sessionId: god.session.id,
      userId: ctx.user.id,
      hotelId,
      tableName: "hotel_memberships",
      rowId: membershipId,
      op: "update",
      after: { user_id: body.userId, role: body.role },
      summary: `Changed a team member's role to ${body.role.replace(/_/g, " ")}.`,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}

/** DELETE body: { userId }. A team edit: God Mode, and recorded. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ hotelId: string; membershipId: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const god = await requireGodMode(ctx.ssr);
  if (!god.ok) return god.response;
  const { hotelId, membershipId } = await params;

  let body: { userId: string };
  try {
    body = (await req.json()) as { userId: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  try {
    await removeMembership(ctx.admin, { hotelId, userId: body.userId });
    await recordSupportChange(ctx.admin, {
      sessionId: god.session.id,
      userId: ctx.user.id,
      hotelId,
      tableName: "hotel_memberships",
      rowId: membershipId,
      op: "delete",
      before: { user_id: body.userId },
      summary: "Removed a team member.",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}
