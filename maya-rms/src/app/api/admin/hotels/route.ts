import { createHotel, type CreateHotelInput } from "@/lib/admin/hotels";
import { inviteUserToHotel } from "@/lib/admin/memberships";
import { saveMewsCredentials, testMewsConnection, type MewsEnv } from "@/lib/admin/pms";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import type { HotelRole } from "@/lib/admin/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type PostBody = {
  hotel: CreateHotelInput;
  pms?: {
    env: MewsEnv;
    clientToken: string;
    accessToken: string;
    enterpriseId?: string;
    testFirst?: boolean;
  };
  invite?: {
    email: string;
    role: HotelRole;
  };
};

export async function POST(req: Request) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body?.hotel?.name) {
    return NextResponse.json({ error: "hotel.name is required" }, { status: 400 });
  }

  try {
    const { hotelId } = await createHotel(ctx.admin, body.hotel);

    let pmsConnected = false;
    if (body.pms?.clientToken && body.pms?.accessToken) {
      if (body.pms.testFirst) {
        await testMewsConnection({
          hotelId,
          env: body.pms.env,
          clientToken: body.pms.clientToken,
          accessToken: body.pms.accessToken,
          enterpriseId: body.pms.enterpriseId,
        });
        pmsConnected = true;
      }
      await saveMewsCredentials(
        ctx.admin,
        {
          hotelId,
          env: body.pms.env,
          clientToken: body.pms.clientToken,
          accessToken: body.pms.accessToken,
          enterpriseId: body.pms.enterpriseId,
        },
        { markConnected: pmsConnected },
      );
    }

    let inviteResult: Awaited<ReturnType<typeof inviteUserToHotel>> | null = null;
    if (body.invite?.email) {
      inviteResult = await inviteUserToHotel(ctx.admin, {
        email: body.invite.email,
        hotelId,
        role: body.invite.role,
      });
    }

    return NextResponse.json({
      ok: true,
      hotelId,
      pmsConnected,
      invite: inviteResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create hotel";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
