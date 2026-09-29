/**
 * Strategy ceilings only land on room types that have never sold above them.
 * The old read took the top 5,000 rates hotel-wide, which PostgREST cuts to
 * 1,000, so on a big book a type below the cut looked unsold and got pinned.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  describeGuardrailNotSaved,
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

/**
 * room_types keeps ceiling_price >= floor_price and refuses the whole row
 * otherwise. The fake refuses it the same way, so an answer that clashes with
 * a room type's own number fails as it does in Postgres.
 */
function withFloorCeilingCheck(seed: Record<string, FakeRow[]>, failIds: string[] = []) {
  const db: { tables?: Record<string, FakeRow[]> } = {};
  const made = fakeSupabase(seed, {
    fault: (call) => {
      if (call.table !== "room_types" || call.op !== "update") return null;
      const id = call.filters.find((f) => f.col === "id")?.value;
      if (failIds.includes(String(id))) return { message: "connection reset" };
      const row = db.tables!.room_types.find((r) => r.id === id)!;
      const next = { ...row, ...(call.payload as FakeRow) };
      return Number(next.floor_price) > Number(next.ceiling_price)
        ? { code: "23514", message: 'new row for relation "room_types" violates check constraint "room_types_check"' }
        : null;
    },
  });
  db.tables = made.tables;
  return made;
}

function hotel(settings: { strategy_floor: number | null; strategy_ceiling: number | null }, types: FakeRow[]) {
  return {
    hotel_settings: [{ hotel_id: "h1", ...settings }],
    room_types: types.map((t) => ({ hotel_id: "h1", is_active: true, floor_price: 1, ceiling_price: 99999.99, ...t })),
    reservations: [] as FakeRow[],
  };
}

describe("an answer a room type can't take", () => {
  it("saves the floor everywhere it fits and names the room type whose ceiling is under it", async () => {
    const { client, tables } = withFloorCeilingCheck(
      hotel({ strategy_floor: 200, strategy_ceiling: null }, [
        { id: "rt-std", name: "Standard" },
        { id: "rt-king", name: "Deluxe King", ceiling_price: 150 },
      ]),
    );
    const notSaved = await projectStrategyOntoRoomTypes(client, "h1");
    expect(ceilings(tables.room_types)).toEqual({ "rt-std": [200, 99999.99], "rt-king": [1, 150] });
    expect(notSaved).toEqual([
      expect.objectContaining({
        roomTypeId: "rt-king",
        roomTypeName: "Deluxe King",
        fields: ["floor"],
        reason: "above_ceiling",
        floor: 200,
        savedCeiling: 150,
      }),
    ]);
  });

  it("names the room type whose floor is above the ceiling answer", async () => {
    const { client, tables } = withFloorCeilingCheck(
      hotel({ strategy_floor: null, strategy_ceiling: 300 }, [
        { id: "rt-std", name: "Standard" },
        { id: "rt-suite", name: "Suite", display_name: "Garden Suite", floor_price: 350 },
      ]),
    );
    const notSaved = await projectStrategyOntoRoomTypes(client, "h1");
    expect(ceilings(tables.room_types)).toEqual({ "rt-std": [1, 300], "rt-suite": [350, 99999.99] });
    expect(notSaved).toEqual([
      expect.objectContaining({
        roomTypeName: "Garden Suite",
        fields: ["ceiling"],
        reason: "below_floor",
        ceiling: 300,
        savedFloor: 350,
      }),
    ]);
  });

  it("writes neither answer when the floor on file is above the ceiling on file", async () => {
    const { client, tables } = withFloorCeilingCheck(
      hotel({ strategy_floor: 200, strategy_ceiling: 150 }, [{ id: "rt-std", name: "Standard" }]),
    );
    const notSaved = await projectStrategyOntoRoomTypes(client, "h1");
    expect(ceilings(tables.room_types)).toEqual({ "rt-std": [1, 99999.99] });
    expect(notSaved).toEqual([expect.objectContaining({ fields: ["floor", "ceiling"], reason: "answers_clash" })]);
  });

  it("reports a save that did not go through", async () => {
    const { client } = withFloorCeilingCheck(
      hotel({ strategy_floor: 80, strategy_ceiling: null }, [
        { id: "rt-std", name: "Standard" },
        { id: "rt-king", name: "Deluxe King" },
      ]),
      ["rt-king"],
    );
    const notSaved = await projectStrategyOntoRoomTypes(client, "h1");
    expect(notSaved).toEqual([
      expect.objectContaining({ roomTypeName: "Deluxe King", fields: ["floor"], reason: "save_failed" }),
    ]);
  });

  it("reports nothing when every room type takes the answers", async () => {
    const { client } = withFloorCeilingCheck(
      hotel({ strategy_floor: 80, strategy_ceiling: 400 }, [{ id: "rt-std", name: "Standard", ceiling_price: 300 }]),
    );
    expect(await projectStrategyOntoRoomTypes(client, "h1")).toEqual([]);
  });

  it("says which room type, which answer and what it clashed with, in plain words", () => {
    const money = (n: number) => `$${n}`;
    const base = {
      roomTypeId: "rt",
      roomTypeName: "Deluxe King",
      floor: 200,
      ceiling: 150,
      savedFloor: 250,
      savedCeiling: 120,
    };
    expect(describeGuardrailNotSaved({ ...base, fields: ["floor"], reason: "above_ceiling" }, money)).toBe(
      "Your floor of $200 wasn't saved for Deluxe King: its ceiling is $120, and a floor can't be above the ceiling.",
    );
    expect(describeGuardrailNotSaved({ ...base, fields: ["ceiling"], reason: "below_floor" }, money)).toBe(
      "Your ceiling of $150 wasn't saved for Deluxe King: its floor is $250, and a ceiling can't be below the floor.",
    );
    expect(describeGuardrailNotSaved({ ...base, fields: ["floor", "ceiling"], reason: "answers_clash" }, money)).toBe(
      "Your floor of $200 and ceiling of $150 weren't saved for Deluxe King, because the floor is above the ceiling.",
    );
    expect(describeGuardrailNotSaved({ ...base, fields: ["floor"], reason: "save_failed" }, money)).toBe(
      "Your floor wasn't saved for Deluxe King. Try again in a moment.",
    );
  });
});
