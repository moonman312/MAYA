import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Read-only Mews integration row for the active hotel (RLS applies).
 */
export async function GET() {
  const ctx = await requireSupabaseHotel(await cookies());
  if (!ctx.ok) return ctx.response;

  const { data, error } = await ctx.supabase
    .from("pms_connections")
    .select("id, status, last_sync_at, last_tested_at, updated_at")
    .eq("hotel_id", ctx.hotelId)
    .eq("pms_type", "mews")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({
      configured: false,
      status: null,
      lastSyncAt: null,
      lastTestedAt: null,
    });
  }

  return NextResponse.json({
    configured: true,
    status: data.status,
    lastSyncAt: data.last_sync_at,
    lastTestedAt: data.last_tested_at,
    updatedAt: data.updated_at,
  });
}
