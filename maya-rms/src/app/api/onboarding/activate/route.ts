import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * The "go live" switch: turns simulation mode off so the starter rules start
 * actually publishing prices. RLS restricts hotel_settings writes to
 * hotel_admin/manager, so membership is the authorization.
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

  const { error, data } = await supabase
    .from("hotel_settings")
    .update({ simulation_mode: false, updated_at: new Date().toISOString() })
    .eq("hotel_id", hotelId)
    .select("hotel_id");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.length) {
    // RLS silently filters non-managers into a 0-row update; say so honestly.
    return NextResponse.json(
      { error: "You need admin access on this property to go live." },
      { status: 403 },
    );
  }

  return NextResponse.json({ ok: true });
}
