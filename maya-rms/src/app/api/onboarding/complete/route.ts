import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Finish the review step: stamp completion and record the active room count
 * for payment-tier verification (tiers are room-count based; actual billing
 * comes later).
 *
 * Row security turns a lower role's write into an update of no rows, with no
 * error, so the role is checked first and the write is read back: the review
 * only moves on once this says the stamp is there.
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
    return NextResponse.json({ error: "You don't have access to this property." }, { status: 400 });
  }
  const { data: canManage } = await supabase.rpc("can_manage_hotel", { target_hotel_id: hotelId });
  if (!canManage) {
    return NextResponse.json({ error: "Only a Revenue Manager or above can finish the review." }, { status: 403 });
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
  const { data: saved, error } = await supabase
    .from("onboarding_states")
    .update({
      review_completed_at: now,
      payment_tier_rooms: totalRooms,
      payment_tier_flagged_at: now,
      updated_at: now,
    })
    .eq("hotel_id", hotelId)
    .select("hotel_id");
  // The review screen puts this answer under Finish, so the database's own
  // words stay in the log.
  if (error) {
    console.error(JSON.stringify({ fn: "onboarding/complete", hotelId, error: error.message }));
    return NextResponse.json({ error: "Couldn't finish the review. Try again." }, { status: 500 });
  }
  if (!saved?.length) {
    return NextResponse.json(
      { error: "Your review couldn't be marked as finished. Reload the page and try again." },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, totalRooms });
}
