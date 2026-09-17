/**
 * Strategy ceilings only land on room types that have never sold above them.
 * The old read took the top 5,000 rates hotel-wide, which PostgREST cuts to
 * 1,000, so on a big book a type below the cut looked unsold and got pinned.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  projectStrategyOntoRoomTypes,
  resetMaxRatesLogOnce,
} from "../../../supabase/functions/_shared/onboarding/project-strategy";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "../engine/fake-supabase.test";

afterEach(() => vi.restoreAllMocks());

/** The projection as it was, for the equivalence check. */
async function legacyProject(supabase: SupabaseClient, hotelId: string) {
  const { data: settings } = await supabase.from("hotel_settings").select("strategy_floor, strategy_ceiling").eq("hotel_id", hotelId).maybeSingle();
  if (!settings) return;
  const floor = settings.strategy_floor != null ? Number(settings.strategy_floor) : null;
  const ceiling = settings.strategy_ceiling != null ? Number(settings.strategy_ceiling) : null;
  if (floor === null && ceiling === null) return;
  const { data: roomTypes } = await supabase.from("room_types").select("id").eq("hotel_id", hotelId).eq("is_active", true);
  if (!roomTypes?.length) return;
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
      if (!maxRateByRoomType.has(id)) maxRateByRoomType.set(id, Number(r.current_rate));
    }
  }
  for (const rt of roomTypes) {
    const patch: Record<string, number> = {};
    if (floor !== null && floor > 0) patch.floor_price = floor;
    if (ceiling !== null && ceiling > 0) {
      const observedMax = maxRateByRoomType.get(String(rt.id)) ?? 0;
      if (ceiling >= observedMax) patch.ceiling_price = ceiling;
    }
    if (Object.keys(patch).length > 0) await supabase.from("room_types").update(patch).eq("id", rt.id);
  }
}

function world(reservationsPerType: Record<string, number[]>, ceiling: number) {
  const room_types: FakeRow[] = Object.keys(reservationsPerType).map((id) => ({
    id, hotel_id: "h1", is_active: true, floor_price: 1, ceiling_price: 99999.99,
  }));
  room_types.push({ id: "rt-unsold", hotel_id: "h1", is_active: true, floor_price: 1, ceiling_price: 99999.99 });
  const reservations: FakeRow[] = [];
  for (const [id, rates] of Object.entries(reservationsPerType)) {
    rates.forEach((rate, i) => reservations.push({ id: `${id}-${i}`, hotel_id: "h1", room_type_id: id, current_rate: rate }));
  }
  reservations.push({ id: "null-rate", hotel_id: "h1", room_type_id: "rt-a", current_rate: null });
  reservations.push({ id: "other", hotel_id: "h2", room_type_id: "rt-a", current_rate: 99999 });
  return {
    hotel_settings: [{ hotel_id: "h1", strategy_floor: 60, strategy_ceiling: ceiling }],
    room_types,
    reservations,
  };
}

const ceilings = (rows: FakeRow[]) => Object.fromEntries(rows.map((r) => [r.id, [r.floor_price, r.ceiling_price]]));

describe("projectStrategyOntoRoomTypes", () => {
  it.each([
    ["migrated", {}],
    ["before the migration", { rpc: (fn: string) => new FakeRpcError(missingFunction(fn)) }],
  ])("patches exactly what the old projection did on a book under the cap (%s)", async (_l, opts) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetMaxRatesLogOnce();
    for (const ceiling of [150, 250, 400]) {
      const seed = world({ "rt-a": [120, 180, 90], "rt-b": [300, 240], "rt-c": [50] }, ceiling);
      const oldDb = fakeSupabase(seed, { maxRows: 1000 });
      await legacyProject(oldDb.client, "h1");
      const newDb = fakeSupabase(seed, { maxRows: 1000, ...opts });
      await projectStrategyOntoRoomTypes(newDb.client, "h1");
      expect(ceilings(newDb.tables.room_types)).toEqual(ceilings(oldDb.tables.room_types));
    }
  });

  it.each([
    ["migrated", {}],
    ["before the migration", { rpc: (fn: string) => new FakeRpcError(missingFunction(fn)) }],
  ])("uses each type's true maximum past the 1,000-row cap (%s)", async (_l, opts) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // rt-lux fills the top 1,500 rates; rt-suite's best (320) is below the cut.
    const seed = world({ "rt-lux": Array.from({ length: 1500 }, (_, i) => 500 + i), "rt-suite": [320, 310], "rt-std": [110] }, 300);
    const oldDb = fakeSupabase(seed, { maxRows: 1000 });
    await legacyProject(oldDb.client, "h1");
    // The old read pinned the suite at 300 though it sells at 320.
    expect(oldDb.tables.room_types.find((r) => r.id === "rt-suite")!.ceiling_price).toBe(300);

    const { client, tables } = fakeSupabase(seed, { maxRows: 1000, ...opts });
    await projectStrategyOntoRoomTypes(client, "h1");
    const got = ceilings(tables.room_types);
    expect(got["rt-suite"]).toEqual([60, 99999.99]);
    expect(got["rt-lux"]).toEqual([60, 99999.99]);
    expect(got["rt-std"]).toEqual([60, 300]);
    expect(got["rt-unsold"]).toEqual([60, 300]);
  });

  it("leaves every ceiling alone when the rates cannot be read, and still sets floors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seed = world({ "rt-a": [120] }, 300);
    const { client, tables } = fakeSupabase(seed, { rpc: () => new FakeRpcError({ code: "57014", message: "timeout" }) });
    await projectStrategyOntoRoomTypes(client, "h1");
    for (const rt of tables.room_types) expect([rt.floor_price, rt.ceiling_price]).toEqual([60, 99999.99]);
  });
});
