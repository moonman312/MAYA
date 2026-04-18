/**
 * POST /api/evaluate — trigger an evaluation run for a hotel.
 *
 * In v1 this is triggered manually or by cron. The nightly scheduler
 * (02:30 local) would hit this endpoint per hotel.
 */

import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { evaluateHotel } from "@/lib/engine";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is required for evaluation runs." },
        { status: 501 },
      );
    }

    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const hotelId = await resolveAccessibleHotelId(supabase);
    if (!hotelId) {
      return NextResponse.json(
        { error: "No accessible hotel." },
        { status: 400 },
      );
    }

    const result = await evaluateHotel(supabase, hotelId);

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Evaluation failed." },
      { status: 500 },
    );
  }
}
