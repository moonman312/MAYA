import { isUuid } from "@/lib/api-guards";
import { ROOM_TYPES } from "@/lib/demo-data";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { roleLabel } from "@/lib/roles";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { classifyRoomType } from "./classify";
import { nearestPublishedRates } from "./seed-rates";
import { NEEDS_MIGRATION, isPreMigration, scheduleReprice } from "./reprice";

// PATCH schedules a full re-price behind the response; same cap as /api/evaluate.
export const maxDuration = 300;

type RoomTypeRow = {
  id: string;
  name: string;
  total_rooms: number;
  floor_price: number;
  ceiling_price: number;
  /** null = never classified (pre-migration, or a row the sync never touched). */
  counts_as_room: boolean | null;
};

/** A type counts unless someone (or the import heuristic) said it doesn't. */
export function isCountingRoom(rt: { counts_as_room?: boolean | null }): boolean {
  return rt.counts_as_room !== false;
}

/**
 * The hotel's active room types with their "counts as a room" flag.
 *
 * Before the classification migration lands the column is not there, and
 * PostgREST answers 42703. Code can ship ahead of the migration, so that is
 * handled rather than surfaced: re-read without the column, treat every type
 * as a room (the pre-migration behaviour), and say so in the logs.
 */
async function loadRoomTypes(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<{ rows: RoomTypeRow[]; error: { message: string } | null }> {
  const base = supabase.from("room_types").select("id, name, total_rooms, floor_price, ceiling_price, counts_as_room");
  const { data, error } = await base.eq("hotel_id", hotelId).eq("is_active", true).order("name", { ascending: true });
  if (!error) return { rows: (data ?? []) as RoomTypeRow[], error: null };
  if (!isPreMigration(error)) return { rows: [], error };

  console.warn(
    JSON.stringify({
      fn: "room-types",
      step: "pre-migration",
      hotelId,
      message: "room_types.counts_as_room is missing — run the room classification migration. Treating every active type as a room.",
    }),
  );
  const fallback = await supabase
    .from("room_types")
    .select("id, name, total_rooms, floor_price, ceiling_price")
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (fallback.error) return { rows: [], error: fallback.error };
  return {
    rows: (fallback.data ?? []).map((r) => ({ ...r, counts_as_room: null })) as RoomTypeRow[],
    error: null,
  };
}

/**
 * A sane made-up starting price when nothing has been published yet.
 *
 * The guardrail midpoint only means something when the owner actually set
 * guardrails. MAYA's "no limit" default is floor 1 / ceiling 99999.99, whose
 * midpoint is $50,000 — so wide ranges fall back to the floor instead of
 * opening the simulator on an absurd number.
 */
export function fallbackSeed(floor: number, ceiling: number): number {
  if (ceiling > 0 && floor > 0 && ceiling <= floor * 10) {
    return Math.round((floor + ceiling) / 2);
  }
  return Math.max(1, Math.round(floor));
}

export async function GET(req: Request) {
  try {
    // Only the Rate Simulator asks for a seed rate; the rules form calls this
    // on every dashboard mount and shouldn't pay for the extra read.
    const withRate = new URL(req.url).searchParams.get("withRate") === "1";

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
        return NextResponse.json(withRate ? { timezone: "UTC", roomTypes: [] } : []);
      }

      // total_rooms and the guardrails come along for the Rate Simulator, which
      // has to clamp exactly the way the engine does or its preview is a lie.
      // Both are the property's own numbers shown back to its own members, and
      // the onboarding review screen already puts them on screen.
      const { rows: allRows, error } = await loadRoomTypes(supabase, hotelId);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // The plain list carries every active type — the rules form needs the
      // non-rooms too, badged, so they can still be priced on purpose. The
      // simulator seed is rooms only unless it asks for everything.
      if (!withRate) return NextResponse.json(allRows);
      const all = new URL(req.url).searchParams.get("all") === "1";
      const rows = all ? allRows : allRows.filter(isCountingRoom);

      // The seeded shape is an object, not an array: the simulator needs the
      // hotel's timezone too, because days-to-arrival is measured from the
      // hotel's calendar date and not the viewer's. Only ?withRate=1 returns
      // this, so the rules form's plain call keeps the array it expects.
      const [seed, hotelRow] = await Promise.all([
        nearestPublishedRates(supabase, hotelId, rows.map((rt) => String(rt.id))),
        supabase.from("hotels").select("timezone").eq("id", hotelId).maybeSingle(),
      ]);
      return NextResponse.json({
        timezone: hotelRow.data?.timezone ?? "UTC",
        roomTypes: rows.map((rt) => ({
          ...rt,
          seed_rate:
            seed.get(String(rt.id)) ??
            fallbackSeed(Number(rt.floor_price), Number(rt.ceiling_price)),
        })),
      });
    }

    const demoRows = ROOM_TYPES.map((rt) => ({
      id: rt.name,
      name: rt.name,
      total_rooms: rt.total_rooms,
      floor_price: Math.round(rt.base_rate * 0.6),
      ceiling_price: Math.round(rt.base_rate * 2),
      counts_as_room: true,
      ...(withRate ? { seed_rate: rt.base_rate } : {}),
    }));
    return NextResponse.json(
      withRate ? { timezone: "UTC", roomTypes: demoRows } : demoRows,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load room types." },
      { status: 500 },
    );
  }
}

type PatchBody = { hotelId?: unknown; roomTypeId?: unknown; countsAsRoom?: unknown };

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * PATCH /api/room-types — flip one type's "counts as a room".
 *
 * Reads and the classification write go through the service-role client
 * after the can_manage_hotel gate (see classify.ts), and every flip is
 * logged with the actor: unticking a type lowers occupancy, RevPAR and the
 * bill, so who did it and from where has to be answerable later.
 */
export async function PATCH(req: Request) {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json({ error: "Supabase is required to classify room types." }, { status: 501 });
    }
    let body: PatchBody = {};
    try {
      const text = await req.text();
      body = text ? (JSON.parse(text) as PatchBody) : {};
    } catch {
      body = {};
    }

    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { hotelId, roomTypeId, countsAsRoom } = body;
    if (typeof hotelId !== "string" || !isUuid(hotelId)) return bad("Pick a property first.");
    if (typeof roomTypeId !== "string" || !isUuid(roomTypeId)) return bad("Pick a room type.");
    if (typeof countsAsRoom !== "boolean") return bad("countsAsRoom must be true or false.");

    const { data: canManage } = await supabase.rpc("can_manage_hotel", { target_hotel_id: hotelId });
    if (!canManage) {
      return NextResponse.json(
        { error: `This needs ${roleLabel("revenue_manager")} access or higher on this property.` },
        { status: 403 },
      );
    }

    // Each flip also re-prices the horizon, which is the manual-price budget's
    // reason for being; no bucket of its own yet.
    const throttled = await enforceRateLimit(
      "manualPrice",
      user.id,
      "That's a lot of room-type changes at once. Give it a minute and try again.",
    );
    if (throttled) return throttled;

    if (!isAdminConfigured()) {
      return NextResponse.json(
        { error: "Classifying room types needs SUPABASE_SERVICE_ROLE_KEY set on the server." },
        { status: 503 },
      );
    }
    const admin = createAdminClient();

    const outcome = await classifyRoomType(admin, {
      hotelId,
      roomTypeId,
      countsAsRoom,
      actorUserId: user.id,
      via: "settings",
    });
    switch (outcome.kind) {
      case "pre_migration":
        console.warn(JSON.stringify({ fn: "room-types", step: "pre-migration", hotelId, message: "PATCH refused: room_types.counts_as_room is missing." }));
        return NextResponse.json({ error: NEEDS_MIGRATION }, { status: 503 });
      case "not_found":
        return bad("That room type isn't on this property.");
      case "error":
        throw new Error(outcome.message);
      case "changed":
        scheduleReprice(admin, hotelId, "room-types");
        break;
      case "confirmed":
      case "unchanged":
        // Same denominator as before: nothing to re-price.
        break;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(
      JSON.stringify({
        fn: "room-types",
        step: "patch",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: "Something went wrong on our side. Try again in a moment." },
      { status: 500 },
    );
  }
}
