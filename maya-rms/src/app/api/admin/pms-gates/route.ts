import { listPmsSignupGates } from "@/lib/billing/pms-gates";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/pms-gates — every PMS's access-code requirement.
 *
 * Platform-admin only, same bar as the rest of Command Center. Written directly
 * with the service-role client rather than through a SECURITY DEFINER RPC: this
 * route itself is the authorization boundary (matches api/admin/signup-codes),
 * and the table has no policy for anyone else to fall back on if that check
 * were ever skipped.
 */
export async function GET() {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;

  try {
    return NextResponse.json({ gates: await listPmsSignupGates(ctx.admin) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load PMS signup gates.";
    console.error(JSON.stringify({ fn: "pmsGatesList", error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
