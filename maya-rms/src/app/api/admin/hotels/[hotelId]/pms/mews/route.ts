import { deleteMewsCredentials, saveMewsCredentials, type MewsEnv } from "@/lib/admin/pms";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type PutBody = {
  env: MewsEnv;
  clientToken: string;
  accessToken: string;
  enterpriseId?: string;
  testFirst?: boolean;
};

export async function PUT(req: Request, { params }: { params: Promise<{ hotelId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const { hotelId } = await params;

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.clientToken || !body.accessToken || !body.env) {
    return NextResponse.json(
      { error: "env, clientToken, accessToken are required" },
      { status: 400 },
    );
  }

  try {
    await saveMewsCredentials(
      ctx.admin,
      {
        hotelId,
        env: body.env,
        clientToken: body.clientToken,
        accessToken: body.accessToken,
        enterpriseId: body.enterpriseId,
      },
      { markConnected: true },
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save" },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ hotelId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const { hotelId } = await params;

  try {
    await deleteMewsCredentials(ctx.admin, hotelId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to disconnect" },
      { status: 400 },
    );
  }
}
