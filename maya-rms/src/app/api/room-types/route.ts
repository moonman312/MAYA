import { ROOM_TYPES } from "@/lib/demo-data";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = createClient(await cookies());
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const hotelId = await resolveAccessibleHotelId(supabase);
      if (!hotelId) {
        return NextResponse.json([]);
      }

      const { data, error } = await supabase
        .from("room_types")
        .select("id, name")
        .eq("hotel_id", hotelId)
        .eq("is_active", true)
        .order("name", { ascending: true });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json(data ?? []);
    }

    return NextResponse.json(ROOM_TYPES.map((rt) => ({ id: rt.name, name: rt.name })));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load room types." },
      { status: 500 },
    );
  }
}
