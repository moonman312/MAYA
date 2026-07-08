import { resendInviteEmail, revokePendingInvite } from "@/lib/admin/memberships";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** POST body: { email } — resend invite */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pendingId: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  await params; // consume

  let body: { email: string };
  try {
    body = (await req.json()) as { email: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.email) return NextResponse.json({ error: "email required" }, { status: 400 });

  try {
    await resendInviteEmail(ctx.admin, body.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}

/** DELETE — revoke pending invite */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ pendingId: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const { pendingId } = await params;

  try {
    await revokePendingInvite(ctx.admin, pendingId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 400 },
    );
  }
}
