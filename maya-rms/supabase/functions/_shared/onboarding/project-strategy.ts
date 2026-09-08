import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Project hotel-level strategy answers onto the per-room-type guardrails the
 * pricing engine actually clamps against (room_types.floor_price/ceiling_price).
 *
 * Floor applies to every active room type. Ceiling only applies where it
 * exceeds the room type's observed max nightly rate — a hotel-wide ceiling
 * below a suite's real rates would pin its price down, which is worse than
 * no ceiling. Raw answers stay in onboarding_states.questions so this can
 * always re-run (it does: on answer save AND when the import finishes).
 */
export async function projectStrategyOntoRoomTypes(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<void> {
  const { data: settings } = await supabase
    .from("hotel_settings")
    .select("strategy_floor, strategy_ceiling")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (!settings) return;

  const floor = settings.strategy_floor != null ? Number(settings.strategy_floor) : null;
  const ceiling = settings.strategy_ceiling != null ? Number(settings.strategy_ceiling) : null;
  if (floor === null && ceiling === null) return;

  const { data: roomTypes } = await supabase
    .from("room_types")
    .select("id")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (!roomTypes?.length) return;

  // Observed max nightly rate per room type, one aggregate pass.
  const maxRateByRoomType = new Map<string, number>();
  if (ceiling !== null) {
    const { data: rates } = await supabase
      .from("reservations")
      .select("room_type_id, current_rate")
      .eq("hotel_id", hotelId)
      .not("room_type_id", "is", null)
      .not("current_rate", "is", null)
      .order("current_rate", { ascending: false })
      .limit(5000);
    for (const r of rates ?? []) {
      const id = String(r.room_type_id);
      const rate = Number(r.current_rate);
      if (!maxRateByRoomType.has(id)) maxRateByRoomType.set(id, rate);
    }
  }

  for (const rt of roomTypes) {
    const patch: Record<string, number> = {};
    if (floor !== null && floor > 0) patch.floor_price = floor;
    if (ceiling !== null && ceiling > 0) {
      const observedMax = maxRateByRoomType.get(String(rt.id)) ?? 0;
      if (ceiling >= observedMax) patch.ceiling_price = ceiling;
    }
    if (Object.keys(patch).length > 0) {
      // floor must stay <= ceiling (DB check constraint)
      await supabase.from("room_types").update(patch).eq("id", rt.id);
    }
  }
}
