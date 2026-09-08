import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { setSignupCodeActive } from "@/lib/admin/signup-codes";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * PATCH — turn a code on or off.
 *
 * There is no DELETE on purpose: redemptions cascade off a deleted code and the
 * subscriptions that used it lose their attribution, so "off" is the only way to
 * stop a code without throwing away what it did.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ codeId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;
  const { codeId } = await params;

  let body: { is_active?: unknown };
  try {
    body = (await req.json()) as { is_active?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.is_active !== "boolean") {
    return NextResponse.json({ error: "is_active must be true or false." }, { status: 400 });
  }

  try {
    const updated = await setSignupCodeActive(ctx.ssr, codeId, body.is_active);
    if (!updated) return NextResponse.json({ error: "No code with that id." }, { status: 404 });
    return NextResponse.json({ ok: true, code: updated.code, is_active: body.is_active });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update the code" },
      { status: 400 },
    );
  }
}
