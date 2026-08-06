/**
 * POST /api/evaluate — trigger an evaluation run for a hotel.
 *
 * In v1 this is triggered manually or by cron. The nightly scheduler
 * (02:30 local) would hit this endpoint per hotel.
 */

import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { evaluateHotel } from "@/lib/engine";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

// A real run is minutes of sequential Supabase reads across the whole horizon.
// Cap it explicitly rather than inherit whatever the platform default is.
export const maxDuration = 300;

// One run per hotel at a time. Module scope only reaches this instance, but
// the double-fire this catches — a second click, a retrying client — lands on
// the same warm instance in practice; anything past that is the rate limit's
// problem.
const inFlight = new Set<string>();

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

    // The engine runs entirely under this request's cookie-scoped client, so
    // every write it makes (published_price, evaluation_audit, pickup_event)
    // is subject to RLS' can_manage_hotel check regardless of what runs here.
    // Without this gate, a staff/viewer member's reads all succeed while
    // every write is silently rejected — the run reports success with
    // non-zero counters despite having written nothing.
    const { data: canManage } = await supabase.rpc("can_manage_hotel", {
      target_hotel_id: hotelId,
    });
    if (!canManage) {
      return NextResponse.json(
        { error: "You need manager access on this property to run pricing." },
        { status: 403 },
      );
    }

    // Keyed on the hotel, like the sync routes: the cost is the hotel's run,
    // whichever manager asks for it.
    const throttled = await enforceRateLimit(
      "evaluate",
      hotelId,
      "An evaluation just ran. Prices are re-checked automatically — give it a few minutes.",
    );
    if (throttled) return throttled;

    if (inFlight.has(hotelId)) {
      return NextResponse.json(
        { error: "An evaluation is already running for this property." },
        { status: 409 },
      );
    }
    inFlight.add(hotelId);
    try {
      const result = await evaluateHotel(supabase, hotelId);
      return NextResponse.json(result);
    } finally {
      inFlight.delete(hotelId);
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Evaluation failed." },
      { status: 500 },
    );
  }
}
