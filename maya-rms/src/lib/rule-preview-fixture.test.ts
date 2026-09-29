/**
 * A boutique hotel with history, for the rule preview and dry run tests: two
 * years of bookings and a part-filled window ahead, the five starter booking
 * speed rules, standard rules, a pickup count rule, a paused rule of each
 * kind with changes still on the price, and typed prices (a comp night
 * among them). settle() runs the engine over it the way the scheduled sync
 * does, with bookings arriving between runs, so rules have fired and ladder
 * rows are on when a test starts.
 */
import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { evaluateHotel as appEvaluateHotel } from "@/lib/engine/evaluate";
import { resetBookingSpeedLogOnce as appResetLog } from "@/lib/engine/booking-speed-provider";
import { evaluateHotel as edgeEvaluateHotel } from "../../supabase/functions/_shared/engine/evaluate";
import { resetBookingSpeedLogOnce as edgeResetLog } from "../../supabase/functions/_shared/engine/booking-speed-provider";
import { fakeSupabase, type FakeRow } from "@/lib/engine/fake-supabase.test";
import type { EvaluateFn } from "@/lib/rule-preview";

export const ENGINES: { name: string; evaluate: EvaluateFn; reset: () => void }[] = [
  { name: "app engine", evaluate: appEvaluateHotel, reset: appResetLog },
  { name: "edge engine", evaluate: edgeEvaluateHotel as unknown as EvaluateFn, reset: edgeResetLog },
];

export const H = "h1";
export const TZ = "America/New_York";
/** 10:00 at the hotel. */
export const T0 = "2026-10-01T14:00:00.000Z";
export const TODAY = "2026-10-01";
export const T5 = "2026-10-01T14:05:00.000Z";
export const T10 = "2026-10-01T14:10:00.000Z";
export const HORIZON = 45;

export type Tables = Record<string, FakeRow[]>;

export const uuid = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dow(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const ROOMS = [
  { name: "King", n: 10, rate: 189 },
  { name: "Queen", n: 8, rate: 169 },
  { name: "Suite", n: 3, rate: 289 },
  { name: "Family", n: 2, rate: 239 },
];
export const RT = ROOMS.map((_, i) => uuid("a0000000", i + 1));
export const [KING, QUEEN, SUITE, FAMILY] = RT;

/** A rule in the engine's read shape (pricing_rules with its condition and room type lists). */
export function ruleRow(
  id: string,
  o: Record<string, unknown> & { cond: FakeRow; signals?: string[]; affected?: string[] },
): FakeRow {
  const { cond, signals = RT, affected = RT, ...rest } = o;
  return {
    id,
    hotel_id: H,
    name: id,
    is_active: true,
    version: 1,
    priority: 100,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 10,
    is_pickup_rule: Boolean(cond.pickup_operator || cond.booking_speed_operator),
    undo_on_cancellation: true,
    skip_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    rule_condition: [cond],
    rule_signal_room_type: signals.map((room_type_id) => ({ room_type_id })),
    rule_affected_room_type: affected.map((room_type_id) => ({ room_type_id })),
    ...rest,
  };
}

/** Rule ids, named for what they are. */
export const R = {
  bsMuchSlower: uuid("c1000000", 1),
  bsSlower: uuid("c1000000", 2),
  bsFaster: uuid("c1000000", 3),
  bsMuchFaster: uuid("c1000000", 4),
  bsSurging: uuid("c1000000", 5),
  busy: uuid("b1000000", 1),
  lastMinuteQuiet: uuid("b1000000", 2),
  farOut: uuid("b1000000", 3),
  pickup: uuid("c1000000", 6),
  pausedLadder: uuid("b1000000", 4),
  pausedBs: uuid("c1000000", 7),
};

let resSeq = 0;

/** A fresh hotel: rooms, rates, bookings, rules and typed prices. */
export function seedHotel(seedNo = 7): Tables {
  resSeq = 0;
  const r = rng(seedNo);
  const roomTypes = ROOMS.map((s, i) => ({
    id: RT[i],
    hotel_id: H,
    external_room_type_id: `ext-${i + 1}`,
    name: s.name,
    is_active: true,
    total_rooms: s.n,
    floor_price: Math.round(s.rate * 0.6),
    ceiling_price: Math.round(s.rate * 2.2),
    counts_as_room: true,
  }));
  const reservations: FakeRow[] = [];
  for (let off = -2 * 366; off <= HORIZON + 5; off++) {
    const stay = addDays(TODAY, off);
    const wd = dow(stay);
    const season = 0.6 + 0.2 * Math.sin((2 * Math.PI * (off + 60)) / 365);
    const weekend = wd === 5 || wd === 6 ? 0.15 : 0;
    for (let i = 0; i < ROOMS.length; i++) {
      const cap = ROOMS[i].n;
      let fill = Math.min(0.97, Math.max(0.1, season + weekend + (r() - 0.5) * 0.2));
      if (off >= 0) fill *= Math.exp(-off / 40);
      const n = Math.floor(cap * fill + r());
      for (let k = 0; k < Math.min(n, cap); k++) {
        const lead = Math.floor(-Math.log(1 - r()) * 30);
        let bookedOn = addDays(stay, -lead);
        if (bookedOn > TODAY) bookedOn = TODAY;
        resSeq++;
        reservations.push({
          id: uuid("f0000000", resSeq),
          hotel_id: H,
          external_reservation_id: `${100000 + resSeq}:1`,
          stay_date: stay,
          room_type_id: RT[i],
          booking_date: bookedOn,
          booking_window_days: Math.max(0, Math.round((Date.parse(stay) - Date.parse(bookedOn)) / 86_400_000)),
          current_rate: Math.round(ROOMS[i].rate * (0.85 + r() * 0.3)),
          base_rate: ROOMS[i].rate,
          created_at: bookedOn < TODAY ? `${bookedOn}T1${k % 10}:00:00.000Z` : `${TODAY}T0${k % 10}:00:00.000Z`,
        });
      }
    }
  }
  const rules: FakeRow[] = [
    ruleRow(R.bsMuchSlower, { priority: 110, action_direction: "decrease", action_value: 15, cond: { booking_speed_operator: "at_most", booking_speed_level: "much_slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 7 } }),
    ruleRow(R.bsSlower, { priority: 105, action_direction: "decrease", action_value: 7, cond: { booking_speed_operator: "is", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 7 } }),
    ruleRow(R.bsFaster, { priority: 115, action_value: 10, cond: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 30, booking_speed_cooldown_days: 3 } }),
    ruleRow(R.bsMuchFaster, { priority: 125, action_value: 25, cond: { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 2 } }),
    ruleRow(R.bsSurging, { priority: 130, action_value: 25, cond: { booking_speed_operator: "at_least", booking_speed_level: "surging", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 } }),
    ruleRow(R.busy, { action_value: 15, cond: { occupancy_operator: "gt", occupancy_threshold: 0.6 } }),
    ruleRow(R.lastMinuteQuiet, { action_direction: "decrease", action_type: "fixed", action_value: 12, cond: { occupancy_operator: "lt", occupancy_threshold: 0.3, dta_operator: "lt", dta_threshold_days: 14 } }),
    ruleRow(R.farOut, { action_value: 5, cond: { dta_operator: "gt", dta_threshold_days: 30 } }),
    ruleRow(R.pickup, { priority: 120, action_value: 8, cond: { pickup_operator: "gt", pickup_threshold: 2, pickup_window_days: 3, pickup_metric: "room_nights" } }),
    // Paused before the test instant (see settle), with changes still on the price.
    ruleRow(R.pausedLadder, { action_type: "fixed", action_value: 9, cond: { occupancy_operator: "gt", occupancy_threshold: 0.4 }, affected: [KING, QUEEN] }),
    ruleRow(R.pausedBs, { priority: 112, action_value: 6, cond: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 3 } }),
  ];
  const calendar: FakeRow[] = [];
  for (let off = 0; off <= HORIZON + 5; off++) {
    const stay = addDays(TODAY, off);
    const wd = dow(stay);
    for (let i = 0; i < ROOMS.length; i++) {
      calendar.push({ hotel_id: H, stay_date: stay, room_type_id: RT[i], price: ROOMS[i].rate + (wd === 5 || wd === 6 ? 30 : 0) });
    }
  }
  const manual: FakeRow[] = [
    // A typed price on a busy night, and a comp night.
    { hotel_id: H, stay_date: addDays(TODAY, 2), room_type_id: KING, price: 205, set_by: null, set_at: "2026-09-30T15:00:00.000Z", cleared_at: null, source: "maya" },
    { hotel_id: H, stay_date: addDays(TODAY, 3), room_type_id: QUEEN, price: 0, set_by: null, set_at: "2026-09-30T15:00:00.000Z", cleared_at: null, source: "maya" },
  ];
  return {
    hotels: [{ id: H, timezone: TZ }],
    room_types: roomTypes,
    pricing_rules: rules,
    reservations,
    base_rate_calendar: calendar,
    published_price: [],
    ladder_rule_state: [],
    manual_price: manual,
    hotel_closed_periods: [],
    assumption_challenges: [],
    room_type_out_of_service: [],
  };
}

/** New bookings arriving at `at` on the nights ahead, a cancellation or two. */
export function churn(tables: Tables, at: string, seedNo: number, adds: number, nights?: string[]): void {
  const r = rng(seedNo);
  const res = tables.reservations;
  let cancelled = 0;
  for (let i = res.length - 1; i >= 0 && cancelled < 2; i--) {
    if (String(res[i].stay_date) >= TODAY && r() < 0.004) {
      res.splice(i, 1);
      cancelled++;
    }
  }
  for (let k = 0; k < adds; k++) {
    resSeq++;
    const stay = nights ? nights[k % nights.length] : addDays(TODAY, Math.floor(r() * 30));
    res.push({
      id: uuid("f0000000", resSeq),
      hotel_id: H,
      external_reservation_id: `${100000 + resSeq}:1`,
      stay_date: stay,
      room_type_id: RT[Math.floor(r() * RT.length)],
      booking_date: at.slice(0, 10),
      booking_window_days: Math.max(0, Math.round((Date.parse(stay) - Date.parse(at.slice(0, 10))) / 86_400_000)),
      current_rate: 200,
      base_rate: 200,
      created_at: at,
    });
  }
}

/**
 * The fake, as a migrated database with no stretch without a run, and
 * PostgREST's cap of 1,000 rows a read, so a read that isn't paged comes
 * back short here as it would in production.
 */
export function fake(tables: Tables) {
  return fakeSupabase(tables, { rpc: (fn) => (fn === "engine_run_gaps" ? [] : undefined), maxRows: 1000 });
}

/**
 * Two scheduled runs with bookings arriving between them, then the two
 * paused rules switched off: the state a test starts from, at T10 (with the
 * bookings of T10 already in).
 */
export async function settle(evaluate: EvaluateFn, seedNo = 7): Promise<Tables> {
  const db = fake(seedHotel(seedNo));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await evaluate(db.client as any, H, T0, HORIZON);
  churn(db.tables, T5, 11, 8);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await evaluate(db.client as any, H, T5, HORIZON);
  for (const rule of db.tables.pricing_rules) {
    if (rule.id === R.pausedLadder || rule.id === R.pausedBs) rule.is_active = false;
  }
  churn(db.tables, T10, 12, 8);
  return clone(db.tables);
}

/** A deep copy whose fake-numbered ids can't collide with a new fake's own. */
export function clone(tables: Tables): Tables {
  const out = structuredClone(tables) as Tables;
  for (const rows of Object.values(out)) {
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === "string" && /^\d+$/.test(v) && (k === "id" || k.endsWith("_id"))) row[k] = `x${v}`;
      }
    }
  }
  return out;
}

/** Published prices, `stay_date|room_type_id` to price. */
export function published(tables: Tables): Map<string, number> {
  return new Map((tables.published_price ?? []).map((p) => [`${String(p.stay_date).slice(0, 10)}|${p.room_type_id}`, Number(p.price)]));
}

/** The nights whose prices differ between two sets, to the cent. */
export function nightsDiffering(a: Map<string, number>, b: Map<string, number>): string[] {
  const out = new Set<string>();
  const cents = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100));
  for (const k of new Set([...a.keys(), ...b.keys()])) if (cents(a.get(k)) !== cents(b.get(k))) out.add(k.slice(0, 10));
  return [...out].sort();
}

describe("the rule preview fixture", () => {
  it("seeds a hotel with history and a window part-filled", () => {
    const t = seedHotel();
    expect(t.room_types).toHaveLength(4);
    expect(t.reservations.length).toBeGreaterThan(5000);
    expect(t.pricing_rules.map((r) => r.id)).toContain(R.pausedBs);
  });
});
