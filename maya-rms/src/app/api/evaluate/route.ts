/**
 * POST /api/evaluate — price every night of the property again.
 *
 * The scheduled sync is the one writer of a hotel's prices. This asks it for
 * a new daily pass (request_full_reprice, from
 * 99_supabase_migration_pricing_cadence_v1.sql): the next tick prices every
 * night of the window, nearest nights first, and this nudges that tick to run
 * now. It used to run the engine here, under the caller's session, over 365
 * nights: minutes of reads inside a route, and a second writer racing the
 * scheduled one.
 *
 * Before the migration there is nothing to ask for: every tick prices the
 * whole window anyway, so the nudge alone does it.
 */

import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { isMissingFunctionError } from "@/lib/engine/snapshots";
import { nudgeHotelSync } from "@/lib/pms/sync-nudge";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { recordIfSupport } from "@/lib/admin/god-mode";
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
        { error: "You don't have access to this property." },
        { status: 400 },
      );
    }

    // Only a manager may ask for the hotel's prices to be worked out again.
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
      "An evaluation just ran. Prices are re-checked automatically, so give it a few minutes.",
    );
    if (throttled) return throttled;

    // Under the caller's session: the function checks can_manage_hotel itself.
    const { error: requestError } = await supabase.rpc("request_full_reprice", { p_hotel_id: hotelId });
    if (requestError && !isMissingFunctionError(requestError)) throw requestError;
    const requested = !requestError;

    const pushed = isAdminConfigured() ? await nudgeHotelSync(createAdminClient(), hotelId) : "next_cycle";
    if (requested && isAdminConfigured()) {
      await recordIfSupport(supabase, createAdminClient(), {
        userId: user.id,
        hotelId,
        tableName: "hotel_pricing_state",
        rowId: hotelId,
        op: "update",
        summary: "Asked for every night's price to be worked out again.",
      });
    }
    return NextResponse.json({ ok: true, hotel_id: hotelId, requested, pushed });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Evaluation failed." },
      { status: 500 },
    );
  }
}
