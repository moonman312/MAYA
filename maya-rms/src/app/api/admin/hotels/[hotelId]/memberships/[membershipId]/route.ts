import { removeMembership, setMembershipRole } from "@/lib/admin/memberships";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import type { HotelRole } from "@/lib/admin/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** PATCH body: { userId, role } */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ hotelId: string; membershipId: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const { hotelId } = await params;

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
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}

/** DELETE body: { userId } */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ hotelId: string; membershipId: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const { hotelId } = await params;

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
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}
