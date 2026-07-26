import { testMewsConnection, type MewsEnv } from "@/lib/admin/pms";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = {
  env: MewsEnv;
  clientToken: string;
  accessToken: string;
  enterpriseId?: string;
};

/**
 * Ephemeral Mews test used by the create-hotel wizard (no hotel_id yet).
 * Platform-admin-only. Never touches Vault or pms_connections.
 */
export async function POST(req: Request) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.env || !body.clientToken || !body.accessToken) {
    return NextResponse.json(
      { error: "env, clientToken, accessToken required" },
      { status: 400 },
    );
  }

  try {
    const result = await testMewsConnection({
      hotelId: "wizard",
      env: body.env,
      clientToken: body.clientToken,
      accessToken: body.accessToken,
      enterpriseId: body.enterpriseId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Test failed" },
      { status: 502 },
    );
  }
}
