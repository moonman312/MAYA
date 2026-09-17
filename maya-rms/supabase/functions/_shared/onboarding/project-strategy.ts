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

  // Observed max nightly rate per room type. undefined = unknown (a failed
  // read): that type's ceiling is left alone rather than guessed. A type with
  // no rated bookings at all has a known max of 0.
  let maxRateByRoomType = new Map<string, number | undefined>();
  if (ceiling !== null) {
    maxRateByRoomType = await loadMaxRates(
      supabase,
      hotelId,
      roomTypes.map((rt) => String(rt.id)),
    );
  }

  for (const rt of roomTypes) {
    const patch: Record<string, number> = {};
    if (floor !== null && floor > 0) patch.floor_price = floor;
    if (ceiling !== null && ceiling > 0) {
      const observedMax = maxRateByRoomType.get(String(rt.id));
      if (observedMax !== undefined && ceiling >= observedMax) patch.ceiling_price = ceiling;
    }
    if (Object.keys(patch).length > 0) {
      // floor must stay <= ceiling (DB check constraint)
      await supabase.from("room_types").update(patch).eq("id", rt.id);
    }
  }
}

let loggedMaxRatesMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetMaxRatesLogOnce(): void {
  loggedMaxRatesMissing = false;
}

function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");
}

/**
 * The highest current_rate per room type, every type accounted for.
 *
 * It used to be the top 5,000 rates hotel-wide in one read, which PostgREST
 * silently cuts to 1,000. On a large property every type whose best rate
 * fell below the cut read as "never sold above 0", so a hotel-wide ceiling
 * below that suite's real rates was applied and pinned it down.
 */
async function loadMaxRates(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeIds: string[],
): Promise<Map<string, number | undefined>> {
  const out = new Map<string, number | undefined>();
  const { data, error } = await supabase.rpc("room_type_max_rates", { p_hotel_id: hotelId });
  if (!error) {
    for (const id of roomTypeIds) out.set(id, 0);
    for (const r of (data ?? []) as { room_type_id: unknown; max_rate: unknown }[]) {
      if (r.room_type_id != null && out.has(String(r.room_type_id))) {
        out.set(String(r.room_type_id), Number(r.max_rate));
      }
    }
    return out;
  }
  if (!isMissingFunction(error)) {
    console.error(JSON.stringify({ fn: "projectStrategyOntoRoomTypes", step: "max_rates", hotelId, error: error.message }));
    return out;
  }
  if (!loggedMaxRatesMissing) {
    loggedMaxRatesMissing = true;
    console.error(
      JSON.stringify({
        fn: "projectStrategyOntoRoomTypes",
        step: "max_rates",
        hotelId,
        schema: "pre-migration",
        message: "room_type_max_rates does not exist yet; reading the top rate one room type at a time. Run 99_supabase_migration_large_property_scale_v1.sql.",
        migration: "99_supabase_migration_large_property_scale_v1.sql",
      }),
    );
  }
  for (const id of roomTypeIds) {
    const { data: top, error: topErr } = await supabase
      .from("reservations")
      .select("current_rate")
      .eq("hotel_id", hotelId)
      .eq("room_type_id", id)
      .not("current_rate", "is", null)
      .order("current_rate", { ascending: false })
      .limit(1);
    if (topErr) continue;
    out.set(id, top && top.length > 0 ? Number(top[0].current_rate) : 0);
  }
  return out;
}
