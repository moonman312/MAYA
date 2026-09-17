import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A rate per room type worth showing someone as a starting point.
 *
 * A manual price someone typed for tonight wins outright — that is the
 * number the property has decided on. Otherwise the nearest upcoming night
 * MAYA has published, preferring the base it remembered over the price it
 * produced — the base is the property's own rate, while the price already has
 * rules baked into it, and seeding a rule preview with a rules-adjusted number
 * compounds the adjustment.
 *
 * The nearest night is read per room type. One read of the next 1,000
 * published cells used to serve every type, and a property with enough types
 * used them all up on the first few nights, so types past the cut got no seed.
 *
 * Never throws: a property with nothing published yet just gets no seed, and
 * the caller falls back.
 */
export async function nearestPublishedRates(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeIds: string[],
): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const seed = new Map<string, number>();
  try {
    const [{ data: manualRows }, nearest] = await Promise.all([
      supabase
        .from("manual_price")
        .select("room_type_id, price")
        .eq("hotel_id", hotelId)
        .eq("stay_date", today)
        .is("cleared_at", null),
      Promise.all(
        roomTypeIds.map((id) =>
          supabase
            .from("published_price")
            .select("room_type_id, stay_date, price, base_price")
            .eq("hotel_id", hotelId)
            .eq("room_type_id", id)
            .gte("stay_date", today)
            // Only a night with a usable number: the one the seed would pick.
            .or("base_price.gt.0,price.gt.0")
            .order("stay_date", { ascending: true })
            .limit(1),
        ),
      ),
    ]);

    for (const row of manualRows ?? []) {
      const price = row.price != null ? Number(row.price) : null;
      if (price != null && price > 0) seed.set(String(row.room_type_id), price);
    }

    for (const { data } of nearest) {
      for (const row of data ?? []) {
        const id = String(row.room_type_id);
        if (seed.has(id)) continue;
        const base = row.base_price != null ? Number(row.base_price) : null;
        const price = row.price != null ? Number(row.price) : null;
        const pick = base != null && base > 0 ? base : price;
        if (pick != null && pick > 0) seed.set(id, pick);
      }
    }
  } catch {
    // A missing table or a permissions change must not take out the room-type
    // list, which the rules form depends on.
  }
  return seed;
}
