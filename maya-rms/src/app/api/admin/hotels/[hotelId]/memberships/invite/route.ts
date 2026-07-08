import { inviteUserToHotel } from "@/lib/admin/memberships";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import type { HotelRole } from "@/lib/admin/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = {
  email: string;
  role: HotelRole;
};

export async function POST(req: Request, { params }: { params: Promise<{ hotelId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
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
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invite failed" },
      { status: 400 },
    );
  }
}
