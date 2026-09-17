/**
 * GET /api/rules/alerts — the rules that keep adjusting the same night, and
 * the nights waiting on the owner.
 *
 * The engine files a night once a rule's current version has 3 or more
 * counted fires on one of its room types, and keeps firing: this is what the
 * dashboard banner asks about. Anyone who can see the property sees the
 * alert; `can_manage` says whether they may answer it.
 */

import { dbErrorResponse } from "@/lib/api-guards";
import { hasHotelRank, requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { loadRuleAlerts } from "./shared";

export async function GET() {
  const ctx = await requireSupabaseHotel(await cookies());
  if (!ctx.ok) return ctx.response;

  try {
    const canManage = await hasHotelRank(ctx.supabase, ctx.hotelId, "revenue_manager");
    return NextResponse.json(await loadRuleAlerts(ctx.supabase, ctx.hotelId, canManage));
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
