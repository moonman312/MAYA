/**
 * PATCH /api/admin/hotels/[hotelId]/test-flag — mark a property as test data.
 *
 * Flagged hotels drop out of analytics: a Stripe test-mode checkout writes a
 * real subscription row, so nothing else distinguishes a walkthrough from a
 * customer. Historical snapshot rows are re-stamped too, so flagging today
 * also corrects last week's chart.
 */

import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ hotelId: string }> }) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) return ctx.response;

  const { hotelId } = await params;
  const body = (await request.json().catch(() => null)) as { isTest?: boolean } | null;
  if (typeof body?.isTest !== "boolean") {
    return NextResponse.json({ error: "isTest must be true or false" }, { status: 400 });
  }

  const { error } = await ctx.admin.from("hotels").update({ is_test: body.isTest }).eq("id", hotelId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { error: histErr } = await ctx.admin
    .from("hotel_metrics_daily")
    .update({ is_test: body.isTest })
    .eq("hotel_id", hotelId);
  if (histErr) {
    // The flag itself landed; the charts just keep counting history until the
    // next snapshot corrects it. Worth logging, not worth failing.
    console.error(JSON.stringify({ fn: "testFlag", step: "history", error: histErr.message }));
  }
  return NextResponse.json({ ok: true, isTest: body.isTest });
}
