import { setPmsSignupCodeRequired } from "@/lib/billing/pms-gates";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { getRegistry } from "@/lib/pms/registry";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/pms-gates/:pmsType — flip one PMS's access-code requirement.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pmsType: string }> },
) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;

  const { pmsType } = await params;
  // Only a PMS the registry actually knows about can be gated — otherwise a
  // typo'd path segment quietly creates a row for a PMS that doesn't exist and
  // never shows up anywhere to be corrected.
  if (!getRegistry(pmsType as never)) {
    return NextResponse.json({ error: `Unknown PMS type: ${pmsType}` }, { status: 400 });
  }

  let required: unknown;
  try {
    required = ((await request.json()) as { requiresSignupCode?: unknown }).requiresSignupCode;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof required !== "boolean") {
    return NextResponse.json({ error: "requiresSignupCode must be true or false." }, { status: 400 });
  }

  try {
    await setPmsSignupCodeRequired(ctx.admin, pmsType, required, ctx.user.id);
    return NextResponse.json({ ok: true, pmsType, requiresSignupCode: required });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not update that gate.";
    console.error(JSON.stringify({ fn: "pmsGatesPatch", pmsType, error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
