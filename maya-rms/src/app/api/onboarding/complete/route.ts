import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Finish the review step: stamp completion and record the active room count
 * for payment-tier verification (tiers are room-count based; actual billing
 * comes later).
 */
export async function POST() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({ error: "No hotel" }, { status: 400 });
  }

  const { data: roomTypes } = await supabase
    .from("room_types")
    .select("total_rooms")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  const totalRooms = (roomTypes ?? []).reduce(
    (sum, rt) => sum + (Number(rt.total_rooms) || 0),
    0,
  );

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("onboarding_states")
    .update({
      review_completed_at: now,
      payment_tier_rooms: totalRooms,
      payment_tier_flagged_at: now,
      updated_at: now,
    })
    .eq("hotel_id", hotelId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, totalRooms });
}
