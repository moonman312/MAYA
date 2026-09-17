import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase, type FakeRow } from "@/lib/engine/fake-supabase.test";
import { nearestPublishedRates } from "./seed-rates";

/** The seed as it was: one read of the next 1,000 published cells. */
async function legacySeed(supabase: SupabaseClient, hotelId: string, today: string) {
  const seed = new Map<string, number>();
  const [{ data: manualRows }, { data }] = await Promise.all([
    supabase.from("manual_price").select("room_type_id, price").eq("hotel_id", hotelId).eq("stay_date", today).is("cleared_at", null),
    supabase.from("published_price").select("room_type_id, stay_date, price, base_price").eq("hotel_id", hotelId).gte("stay_date", today).order("stay_date", { ascending: true }).limit(1000),
  ]);
  for (const row of manualRows ?? []) {
    const price = row.price != null ? Number(row.price) : null;
    if (price != null && price > 0) seed.set(String(row.room_type_id), price);
  }
  for (const row of data ?? []) {
    const id = String(row.room_type_id);
    if (seed.has(id)) continue;
    const base = row.base_price != null ? Number(row.base_price) : null;
    const price = row.price != null ? Number(row.price) : null;
    const pick = base != null && base > 0 ? base : price;
    if (pick != null && pick > 0) seed.set(id, pick);
  }
  return seed;
}

const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("nearestPublishedRates", () => {
  it("picks what the old seed picked on a small calendar, unusable nights included", async () => {
    const published: FakeRow[] = [
      { hotel_id: "h1", room_type_id: "a", stay_date: day(-1), price: 999, base_price: 999 },
      { hotel_id: "h1", room_type_id: "a", stay_date: day(0), price: 0, base_price: null },
      { hotel_id: "h1", room_type_id: "a", stay_date: day(1), price: 180, base_price: 150 },
      { hotel_id: "h1", room_type_id: "b", stay_date: day(2), price: 210, base_price: 0 },
      { hotel_id: "h1", room_type_id: "c", stay_date: day(0), price: 300, base_price: 250 },
      { hotel_id: "h2", room_type_id: "d", stay_date: day(0), price: 1, base_price: 1 },
    ];
    const manual: FakeRow[] = [{ hotel_id: "h1", room_type_id: "c", stay_date: today, price: 275, cleared_at: null }];
    const { client } = fakeSupabase({ published_price: published, manual_price: manual });
    const got = await nearestPublishedRates(client, "h1", ["a", "b", "c", "e"]);
    expect(got).toEqual(await legacySeed(client, "h1", today));
    expect(Object.fromEntries(got)).toEqual({ a: 150, b: 210, c: 275 });
  });

  it("seeds every room type on a calendar past the 1,000-cell cap", async () => {
    const types = Array.from({ length: 40 }, (_, i) => `rt${i}`);
    const published: FakeRow[] = [];
    for (let d = 0; d < 70; d++) {
      for (const [i, t] of types.entries()) {
        // The later half of the types has nothing published for eight weeks.
        if (i >= 20 && d < 56) continue;
        published.push({ hotel_id: "h1", room_type_id: t, stay_date: day(d), price: 100 + i, base_price: 90 + i });
      }
    }
    const { client } = fakeSupabase({ published_price: published, manual_price: [] }, { maxRows: 1000 });
    const got = await nearestPublishedRates(client, "h1", types);
    expect(got.size).toBe(40);
    expect(got.get("rt39")).toBe(129);
    expect((await legacySeed(client, "h1", today)).size).toBe(20);
  });
});
