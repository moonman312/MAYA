import type { SupabaseClient } from "@supabase/supabase-js";
import { treatAsRoom } from "./room-type-names.ts";
import { roomTypeLabel } from "../pms/room-type-label.ts";
import type { LimitRemovals } from "./limit-removals.ts";

/**
 * Project hotel-level strategy answers onto the per-room-type guardrails the
 * pricing engine actually clamps against (room_types.floor_price/ceiling_price).
 *
 * Floor applies to every active room type that is a room. Ceiling only
 * applies where it exceeds the room type's observed max nightly rate — a
 * hotel-wide ceiling below a suite's real rates would pin its price down,
 * which is worse than no ceiling. Raw answers stay in
 * onboarding_states.questions so this can always re-run (it does: on answer
 * save AND when the import finishes).
 *
 * The questions ask about rooms ("the lowest rate you would take for a room
 * on a dead Tuesday"), so the answers land on rooms only. A type the owner
 * has unticked as a room (counts_as_room false), or one nobody has answered
 * for whose name is plainly not a bedroom (parking, boardroom, storage: the
 * names the import proposes as non-rooms), is left alone. Writing a $110
 * room floor onto a $15 parking bay priced the parking at $110 and, on a
 * live hotel, sent that to the PMS. Such a type keeps whatever floor and
 * ceiling it has. Before the counts_as_room migration the column is not
 * there; then the name alone decides, as billing does.
 *
 * The database keeps each room type's floor at or under its ceiling and
 * refuses the whole row when an update would break that, so an answer that
 * clashes with a room type's saved number is not written to that room type.
 * Each one is returned, for the answers route to tell the owner which room
 * type kept what, and why.
 */
export async function projectStrategyOntoRoomTypes(
  supabase: SupabaseClient,
  hotelId: string,
  opts: {
    /**
     * The limits the owner removed on the review (limit-removals.ts). Passed
     * by the import, which leaves each one removed. Saving an answer passes
     * none: that is the owner setting the limit again.
     */
    removals?: LimitRemovals;
  } = {},
): Promise<GuardrailNotSaved[]> {
  const notSaved: GuardrailNotSaved[] = [];
  const { data: settings } = await supabase
    .from("hotel_settings")
    .select("strategy_floor, strategy_ceiling")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (!settings) return notSaved;

  const floor = settings.strategy_floor != null ? Number(settings.strategy_floor) : null;
  const ceiling = settings.strategy_ceiling != null ? Number(settings.strategy_ceiling) : null;
  if (floor === null && ceiling === null) return notSaved;

  const roomTypes = (await loadActiveRoomTypes(supabase, hotelId)).filter(treatAsRoom);
  if (!roomTypes.length) return notSaved;

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
    const removed = opts.removals?.get(String(rt.id));
    if (floor !== null && floor > 0 && !removed?.floor) patch.floor_price = floor;
    if (ceiling !== null && ceiling > 0 && !removed?.ceiling) {
      const observedMax = maxRateByRoomType.get(String(rt.id));
      if (observedMax !== undefined && ceiling >= observedMax) patch.ceiling_price = ceiling;
    }
    if (Object.keys(patch).length === 0) continue;

    const base = {
      roomTypeId: String(rt.id),
      roomTypeName: roomTypeLabel(rt),
      floor,
      ceiling,
      savedFloor: Number(rt.floor_price),
      savedCeiling: Number(rt.ceiling_price),
    };
    // floor must stay <= ceiling (DB check constraint), measured against
    // whichever of the two this row keeps.
    if ((patch.floor_price ?? base.savedFloor) > (patch.ceiling_price ?? base.savedCeiling)) {
      notSaved.push(
        patch.ceiling_price === undefined
          ? { ...base, fields: ["floor"], reason: "above_ceiling" }
          : patch.floor_price === undefined
            ? { ...base, fields: ["ceiling"], reason: "below_floor" }
            : { ...base, fields: ["floor", "ceiling"], reason: "answers_clash" },
      );
      continue;
    }

    const { data: written, error } = await supabase.from("room_types").update(patch).eq("id", rt.id).select("id");
    if (error || !written?.length) {
      const fields: GuardrailNotSaved["fields"] = [];
      if (patch.floor_price !== undefined) fields.push("floor");
      if (patch.ceiling_price !== undefined) fields.push("ceiling");
      notSaved.push({ ...base, fields, reason: "save_failed" });
    }
  }
  return notSaved;
}

/**
 * A room type an answer did not land on.
 *  above_ceiling  the floor answer is above the ceiling the room type already has
 *  below_floor    the ceiling answer is below the floor it already has
 *  answers_clash  the floor answer is above the ceiling answer
 *  save_failed    the write itself failed, or reached no row
 */
export type GuardrailNotSaved = {
  roomTypeId: string;
  roomTypeName: string;
  fields: Array<"floor" | "ceiling">;
  reason: "above_ceiling" | "below_floor" | "answers_clash" | "save_failed";
  /** The answers as saved on the hotel. */
  floor: number | null;
  ceiling: number | null;
  /** What the room type had before, and still has. */
  savedFloor: number;
  savedCeiling: number;
};

/** One sentence for the owner: which room type, which answer, and why. */
export function describeGuardrailNotSaved(n: GuardrailNotSaved, money: (amount: number) => string): string {
  const name = n.roomTypeName;
  switch (n.reason) {
    case "above_ceiling":
      return `Your floor of ${money(n.floor ?? 0)} wasn't saved for ${name}: its ceiling is ${money(n.savedCeiling)}, and a floor can't be above the ceiling.`;
    case "below_floor":
      return `Your ceiling of ${money(n.ceiling ?? 0)} wasn't saved for ${name}: its floor is ${money(n.savedFloor)}, and a ceiling can't be below the floor.`;
    case "answers_clash":
      return `Your floor of ${money(n.floor ?? 0)} and ceiling of ${money(n.ceiling ?? 0)} weren't saved for ${name}, because the floor is above the ceiling.`;
    case "save_failed":
      return n.fields.length > 1
        ? `Your floor and ceiling weren't saved for ${name}. Try again in a moment.`
        : `Your ${n.fields[0] ?? "answer"} wasn't saved for ${name}. Try again in a moment.`;
  }
}

type ActiveRoomType = {
  id: string;
  name: string | null;
  display_name: string | null;
  floor_price: unknown;
  ceiling_price: unknown;
  counts_as_room: boolean | null;
};

let loggedCountsAsRoomMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetCountsAsRoomLogOnce(): void {
  loggedCountsAsRoomMissing = false;
}

/**
 * The hotel's active room types with their "counts as a room" flag. Before
 * 99_supabase_migration_room_type_counts_as_room_v1.sql the column is not
 * there and the select fails naming it; then the rows are read again without
 * it, flagged null, and the name decides (treatAsRoom). A failed read is an
 * empty list: nothing is written, as before.
 */
async function loadActiveRoomTypes(supabase: SupabaseClient, hotelId: string): Promise<ActiveRoomType[]> {
  const read = (columns: string) =>
    supabase.from("room_types").select(columns).eq("hotel_id", hotelId).eq("is_active", true);
  const first = await read("id, name, display_name, floor_price, ceiling_price, counts_as_room");
  if (!first.error) return ((first.data ?? []) as unknown as Record<string, unknown>[]).map(withFlag);
  if (!isMissingColumn(first.error)) return [];
  if (!loggedCountsAsRoomMissing) {
    loggedCountsAsRoomMissing = true;
    console.warn(
      JSON.stringify({
        fn: "projectStrategyOntoRoomTypes",
        step: "room_types",
        hotelId,
        schema: "pre-migration",
        message:
          "room_types.counts_as_room does not exist yet; a type's name alone decides whether the floor and ceiling answers land on it. Run 99_supabase_migration_room_type_counts_as_room_v1.sql.",
        migration: "99_supabase_migration_room_type_counts_as_room_v1.sql",
      }),
    );
  }
  const again = await read("id, name, display_name, floor_price, ceiling_price");
  if (again.error) return [];
  return ((again.data ?? []) as unknown as Record<string, unknown>[]).map(withFlag);
}

function withFlag(r: Record<string, unknown>): ActiveRoomType {
  return {
    id: String(r.id),
    name: r.name == null ? null : String(r.name),
    display_name: r.display_name == null ? null : String(r.display_name),
    floor_price: r.floor_price,
    ceiling_price: r.ceiling_price,
    counts_as_room: typeof r.counts_as_room === "boolean" ? r.counts_as_room : null,
  };
}

let loggedMaxRatesMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetMaxRatesLogOnce(): void {
  loggedMaxRatesMissing = false;
}

/**
 * `column x does not exist`: 42703 from a select or filter, PGRST204 from a
 * write payload. Kept local (the engine has the same test in snapshots.ts)
 * so the import worker's bundle does not carry the engine for one check.
 */
function isMissingColumn(error: { code?: string; message?: string }): boolean {
  const message = error.message ?? "";
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /column .* does not exist/i.test(message) ||
    /could not find the .* column/i.test(message)
  );
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
