import { recordSupportChange, requireGodMode } from "@/lib/admin/god-mode";
import { inviteUserToHotel } from "@/lib/admin/memberships";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import type { HotelRole } from "@/lib/admin/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = {
  email: string;
  role: HotelRole;
};

/** Adding someone to a property's team is a hotel edit: God Mode, and recorded. */
export async function POST(req: Request, { params }: { params: Promise<{ hotelId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const god = await requireGodMode(ctx.ssr);
  if (!god.ok) return god.response;
  const { hotelId } = await params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.email || !body.role) {
    return NextResponse.json({ error: "email and role are required" }, { status: 400 });
  }

  try {
    const result = await inviteUserToHotel(ctx.admin, {
      email: body.email,
      hotelId,
      role: body.role,
      inviterEmail: ctx.user.email ?? null,
    });
    await recordSupportChange(ctx.admin, {
      sessionId: god.session.id,
      userId: ctx.user.id,
      hotelId,
      tableName: result.existingUser ? "hotel_memberships" : "pending_memberships",
      rowId: result.pendingId,
      op: "insert",
      after: { email: body.email.trim().toLowerCase(), role: body.role },
      summary: result.existingUser
        ? `Added ${body.email.trim().toLowerCase()} to the team as ${body.role.replace(/_/g, " ")}.`
        : `Invited ${body.email.trim().toLowerCase()} to the team as ${body.role.replace(/_/g, " ")}.`,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invite failed" },
      { status: 400 },
    );
  }
}
