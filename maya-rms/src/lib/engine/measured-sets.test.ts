/**
 * A rule measures only its signal room types and changes only its affected
 * ones. The two cases the owner asked for, end to end through evaluateHotel:
 * one room type selling slower than usual while the rest of the hotel is
 * fine, and the entry-level rooms' pace pricing the penthouse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { resetBookingSpeedLogOnce } from "./booking-speed-provider";
import { evaluateHotel } from "./evaluate";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeRow } from "./fake-supabase.test";

const EVAL_TS = "2026-09-16T12:00:00Z";
const D0 = "2026-09-16";
const HORIZON = 8;
const STD = "a0000000-0000-4000-8000-0000000000a1";
const DLX = "a0000000-0000-4000-8000-0000000000a2";
const PH = "a0000000-0000-4000-8000-0000000000a3";
const BASE: Record<string, number> = { [STD]: 100, [DLX]: 200, [PH]: 500 };

type Pace = "normal" | "none" | "surge";

/**
 * Four hundred days of steady bookings: Standard 10 a night, Deluxe 60,
 * Penthouse 2, spread over a month of lead time. From today on, Standard's
 * future nights either book as usual, not at all, or with 15 extra bookings
 * made today.
 */
function seed(standard: Pace, rules: FakeRow[]): Record<string, FakeRow[]> {
  const reservations: FakeRow[] = [];
  let id = 0;
  const add = (stay: string, rt: string, lead: number) => {
    const booked = addDays(stay, -lead);
    if (booked > D0) return;
    reservations.push({
      id: `f0000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      hotel_id: "h1",
      stay_date: stay,
      room_type_id: rt,
      booking_date: booked,
      booking_window_days: lead,
      current_rate: BASE[rt],
      base_rate: BASE[rt],
      created_at: `${booked}T10:00:00Z`,
    });
  };
  for (let off = -400; off < HORIZON + 10; off++) {
    const stay = addDays(D0, off);
    const future = off >= 0;
    if (!(future && standard === "none")) for (let i = 0; i < 10; i++) add(stay, STD, i * 3);
    if (future && standard === "surge") for (let i = 0; i < 15; i++) add(stay, STD, off);
    for (let i = 0; i < 60; i++) add(stay, DLX, Math.floor(i / 2));
    for (const lead of [5, 20]) add(stay, PH, lead);
  }
  const roomType = (rid: string, name: string, total_rooms: number) => ({
    id: rid, hotel_id: "h1", name, is_active: true, total_rooms, floor_price: 10, ceiling_price: 5000, counts_as_room: true,
  });
  return {
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: [roomType(STD, "Standard", 20), roomType(DLX, "Deluxe", 80), roomType(PH, "Penthouse", 2)],
    reservations,
    base_rate_calendar: Array.from({ length: HORIZON }, (_, i) =>
      [STD, DLX, PH].map((rt) => ({ hotel_id: "h1", stay_date: addDays(D0, i), room_type_id: rt, price: BASE[rt] })),
    ).flat(),
    pricing_rules: rules,
  };
}

function bsRule(
  id: string,
  signals: string[],
  affected: string[],
  cond: { op: "at_least" | "at_most"; level: string },
  direction: "increase" | "decrease",
): FakeRow {
  return {
    id,
    hotel_id: "h1",
    name: id,
    is_active: true,
    version: 1,
    priority: 100,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: direction,
    action_value: 20,
    is_pickup_rule: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    rule_condition: [{ booking_speed_operator: cond.op, booking_speed_level: cond.level, booking_speed_window_days: 30 }],
    rule_signal_room_type: signals.map((room_type_id) => ({ room_type_id })),
    rule_affected_room_type: affected.map((room_type_id) => ({ room_type_id })),
  };
}

const price = (tables: Record<string, FakeRow[]>, rt: string, stay: string) =>
  Number(tables.published_price.find((p) => p.room_type_id === rt && p.stay_date === stay)?.price);

type Observation = { measuredRoomTypeIds?: string[]; recentBookings: number; windowDays: number; daysOut: number; classification: { rank: number } };
const observationsOn = (tables: Record<string, FakeRow[]>, rt: string, stay: string) =>
  ((tables.evaluation_audit.find((a) => a.room_type_id === rt && a.stay_date === stay)?.details as FakeRow | undefined)
    ?.booking_speed_observations ?? []) as Observation[];

beforeEach(() => {
  resetBookingSpeedLogOnce();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  ["migrated", {}],
  ["pre-migration", { rpc: (fn: string) => new FakeRpcError(missingFunction(fn)) }],
] as const)("rules over measured room types (%s)", (_label, opts) => {
  it("a rule watching the entry-level rooms fires on their pace and changes only the penthouse", async () => {
    const watchStandard = bsRule("r-std-ph", [STD], [PH], { op: "at_least", level: "faster" }, "increase");
    const { client, tables } = fakeSupabase(seed("surge", [watchStandard]), opts);
    const result = await evaluateHotel(client, "h1", EVAL_TS, HORIZON);

    expect(result.ladder_activations).toBe(HORIZON);
    expect(new Set(tables.ladder_rule_state.map((s) => s.room_type_id))).toEqual(new Set([PH]));
    for (let i = 0; i < HORIZON; i++) {
      const stay = addDays(D0, i);
      expect(price(tables, PH, stay)).toBe(600);
      expect(price(tables, STD, stay)).toBe(100);
      expect(price(tables, DLX, stay)).toBe(200);
      // The evidence is the Standard rooms' own bookings, recorded on the cell it changed.
      const [obs] = observationsOn(tables, PH, stay);
      expect(obs.measuredRoomTypeIds).toEqual([STD]);
      const inWindow = tables.reservations.filter(
        (r) =>
          r.room_type_id === STD &&
          r.stay_date === stay &&
          Number(r.booking_window_days) >= obs.daysOut &&
          Number(r.booking_window_days) < obs.daysOut + obs.windowDays,
      ).length;
      expect(obs.recentBookings).toBe(inWindow);
      expect(obs.classification.rank).toBeGreaterThanOrEqual(1);
      expect(observationsOn(tables, STD, stay)).toEqual([]);
    }

    // The same rule watching the penthouse itself sees nothing unusual.
    const own = fakeSupabase(seed("surge", [bsRule("r-ph-ph", [PH], [PH], { op: "at_least", level: "faster" }, "increase")]), opts);
    expect((await evaluateHotel(own.client, "h1", EVAL_TS, HORIZON)).ladder_activations).toBe(0);
  }, 60_000);

  it("a rule watching one room type fires when it sells slower than usual, even with the hotel normal", async () => {
    const slow = { op: "at_most", level: "slower" } as const;
    const { client, tables } = fakeSupabase(seed("none", [bsRule("r-std", [STD], [STD], slow, "decrease")]), opts);
    const result = await evaluateHotel(client, "h1", EVAL_TS, HORIZON);
    expect(result.ladder_activations).toBe(HORIZON);
    for (let i = 0; i < HORIZON; i++) {
      const stay = addDays(D0, i);
      expect(price(tables, STD, stay)).toBe(80);
      expect(price(tables, DLX, stay)).toBe(200);
      const [obs] = observationsOn(tables, STD, stay);
      expect(obs.measuredRoomTypeIds).toEqual([STD]);
      expect(obs.recentBookings).toBe(0);
      expect(obs.classification.rank).toBeLessThanOrEqual(-1);
    }

    // Measuring the whole hotel, the same rule stays quiet: Deluxe is normal.
    const hotelWide = fakeSupabase(seed("none", [bsRule("r-all", [STD, DLX, PH], [STD], slow, "decrease")]), opts);
    expect((await evaluateHotel(hotelWide.client, "h1", EVAL_TS, HORIZON)).ladder_activations).toBe(0);
    const [wide] = observationsOn(hotelWide.tables, STD, D0);
    expect(wide).not.toHaveProperty("measuredRoomTypeIds");
    expect(wide.classification.rank).toBe(0);
  }, 60_000);
});
