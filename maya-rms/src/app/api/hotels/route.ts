import {
  listAccessibleHotels,
  resolveAccessibleHotelId,
} from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json({ hotels: [], activeHotelId: null });
    }

    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const hotels = await listAccessibleHotels(supabase);
    const activeHotelId = await resolveAccessibleHotelId(supabase);

    return NextResponse.json({ hotels, activeHotelId });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load hotels." },
      { status: 500 },
    );
  }
}
