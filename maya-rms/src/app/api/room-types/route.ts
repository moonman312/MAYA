import { ROOM_TYPES } from "@/lib/demo-data";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * A rate per room type worth showing someone as a starting point.
 *
 * The nearest upcoming night MAYA has published, preferring the base it
 * remembered over the price it produced — the base is the property's own rate,
 * while the price already has rules baked into it, and seeding a rule preview
 * with a rules-adjusted number compounds the adjustment.
 *
 * Never throws: a property with nothing published yet just gets no seed, and
 * the caller falls back.
 */
async function nearestPublishedRates(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const seed = new Map<string, number>();
  try {
    const { data } = await supabase
      .from("published_price")
      .select("room_type_id, stay_date, price, base_price")
      .eq("hotel_id", hotelId)
      .gte("stay_date", today)
      .order("stay_date", { ascending: true })
      .limit(1000);

    for (const row of data ?? []) {
      const id = String(row.room_type_id);
      if (seed.has(id)) continue; // rows are date-ascending, so the first is nearest
      const base = row.base_price != null ? Number(row.base_price) : null;
      const price = row.price != null ? Number(row.price) : null;
      const pick = base != null && base > 0 ? base : price;
      if (pick != null && pick > 0) seed.set(id, pick);
    }
  } catch {
    // A missing table or a permissions change must not take out the room-type
    // list, which the rules form depends on.
  }
  return seed;
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
      const { data, error } = await supabase
        .from("room_types")
        .select("id, name, total_rooms, floor_price, ceiling_price")
        .eq("hotel_id", hotelId)
        .eq("is_active", true)
        .order("name", { ascending: true });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const rows = data ?? [];
      if (!withRate) return NextResponse.json(rows);

      // The seeded shape is an object, not an array: the simulator needs the
      // hotel's timezone too, because days-to-arrival is measured from the
      // hotel's calendar date and not the viewer's. Only ?withRate=1 returns
      // this, so the rules form's plain call keeps the array it expects.
      const [seed, hotelRow] = await Promise.all([
        nearestPublishedRates(supabase, hotelId),
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
