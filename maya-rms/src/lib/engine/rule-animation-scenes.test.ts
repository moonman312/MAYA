/**
 * The rules animation (components/rule-behavior-animations.tsx) played
 * through the engine: each scene's story, ticked and unticked, as whole
 * evaluateHotel runs on the app's engine and on the edge functions' copy,
 * against the in-memory fake, and the price after each step is the price
 * the scene shows. A booking reaches the reservations table at its
 * created_at, and a cancellation deletes its row, the way the syncs do.
 * Every booking is one room.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, daysBetween } from "@/lib/observations/calendar";
import { OCCUPANCY_SCENE, SPEED_SCENE, STRONGER_SCENE, sceneSteps } from "@/components/rule-behavior-animations";
import { evaluateHotel as edgeEvaluateHotel } from "../../../supabase/functions/_shared/engine/evaluate";
import { resetBookingSpeedLogOnce as edgeResetLog } from "../../../supabase/functions/_shared/engine/booking-speed-provider";
import { resetBookingSpeedLogOnce as appResetLog } from "./booking-speed-provider";
import { evaluateHotel as appEvaluateHotel } from "./evaluate";
import { fakeSupabase, type FakeRow } from "./fake-supabase.test";

const D0 = "2026-09-16";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T00 = Date.parse(`${D0}T00:00:00.000Z`);
const STD = "a0000000-0000-4000-8000-0000000000a1";
const NIGHT = addDays(D0, 40);
const LAST = addDays(D0, 41);
const iso = (ms: number) => new Date(ms).toISOString();
/** Day `day` of the story at hh:mm UTC (the hotel's time zone). */
const at = (day: number, h: number, m = 0) => T00 + day * DAY + h * HOUR + m * MIN;

const ENGINES = [
  { name: "app engine", evaluateHotel: appEvaluateHotel },
  { name: "edge engine", evaluateHotel: edgeEvaluateHotel },
];
type Engine = (typeof ENGINES)[number];
const BOXES = [
  { box: "ticked", undo: true },
  { box: "unticked", undo: false },
];

function rule(id: string, condition: FakeRow, over: Partial<FakeRow> = {}): FakeRow {
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
    action_direction: "increase",
    action_value: 10,
    is_pickup_rule: true,
    undo_on_cancellation: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    rule_condition: [condition],
    rule_signal_room_type: [{ room_type_id: STD }],
    rule_affected_room_type: [{ room_type_id: STD }],
    ...over,
  };
}

let resId = 0;
/** One booking of one room, first seen at `firstSeen`. */
function booking(stay: string, bookedOn: string, firstSeen: number | string): FakeRow {
  resId++;
  return {
    id: `f0000000-0000-4000-8000-${String(resId).padStart(12, "0")}`,
    hotel_id: "h1",
    external_reservation_id: `${700000000 + resId}`,
    stay_date: stay,
    room_type_id: STD,
    booking_date: bookedOn,
    booking_window_days: daysBetween(bookedOn, stay),
    current_rate: 100,
    base_rate: 100,
    created_at: typeof firstSeen === "number" ? iso(firstSeen) : firstSeen,
  };
}

const dayOf = (ms: number) => iso(ms).slice(0, 10);
/** `n` bookings for NIGHT first seen at `ms`. */
const burst = (n: number, ms: number) => Array.from({ length: n }, () => booking(NIGHT, dayOf(ms), ms));

/**
 * Every night but NIGHT from 400 days back gets one booking at each lead
 * time from 1 to 60 days whose remainder by 7 is under 5: any 7 lead days
 * in a row hold exactly 5, so over any week a night like NIGHT usually
 * gets 5 bookings, the scene's "usual about 5".
 */
function fiveAWeek(): FakeRow[] {
  const out: FakeRow[] = [];
  for (let stay = addDays(D0, -400); stay <= LAST; stay = addDays(stay, 1)) {
    if (stay === NIGHT) continue;
    for (let lead = 1; lead <= 60; lead++) {
      if (lead % 7 >= 5) continue;
      const on = addDays(stay, -lead);
      out.push(booking(stay, on, `${on}T09:00:00.000Z`));
    }
  }
  return out;
}

/**
 * A hotel whose bookings reach MAYA at their created_at. `runAt` puts every
 * booking first seen by then on the books and runs the engine at that
 * instant, pricing through LAST; `cancel` deletes rows, as a cancellation
 * does. `snapshotDays` writes 6-hourly snapshots over that many days before
 * D0 for a pickup count to open on.
 */
function timeline(
  engine: Engine,
  o: { rules: FakeRow[]; rows: FakeRow[]; rooms: number; basePrice: number; snapshotDays?: number },
) {
  const nights: string[] = [];
  for (let d = D0; d <= LAST; d = addDays(d, 1)) nights.push(d);
  const seeded: FakeRow[] = [];
  for (let h = (o.snapshotDays ?? 0) * 24; h > 0; h -= 6) {
    const ts = T00 - h * HOUR;
    for (const stay of nights) {
      const n = o.rows.filter((r) => r.stay_date === stay && Date.parse(String(r.created_at)) <= ts).length;
      seeded.push({ hotel_id: "h1", snapshot_ts: iso(ts), stay_date: stay, room_type_id: STD, sellable_units: o.rooms, booked_units: n, booked_revenue: n * 100 });
    }
  }
  const fake = fakeSupabase({
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: [
      { id: STD, hotel_id: "h1", name: "Standard", is_active: true, total_rooms: o.rooms, floor_price: 10, ceiling_price: 99999, counts_as_room: true },
    ],
    reservations: [],
    base_rate_calendar: nights.map((stay) => ({ hotel_id: "h1", stay_date: stay, room_type_id: STD, price: o.basePrice })),
    pricing_rules: o.rules,
    stay_date_snapshot: seeded,
    manual_price: [],
    pickup_event: [],
  });
  const waiting = [...o.rows].sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)));
  const runAt = async (ms: number) => {
    while (waiting.length > 0 && Date.parse(String(waiting[waiting.length - 1].created_at)) <= ms) {
      fake.tables.reservations.push(waiting.pop()!);
    }
    vi.setSystemTime(new Date(ms));
    const now = iso(ms);
    await engine.evaluateHotel(fake.client, "h1", now, daysBetween(now.slice(0, 10), LAST) + 1);
  };
  /** Runs at 12:05 on each day from `from` through `to`. */
  const daily = async (from: number, to: number) => {
    for (let d = from; d <= to; d++) await runAt(at(d, 12, 5));
  };
  const cancel = (rows: FakeRow[]) => {
    const gone = new Set(rows.map((r) => r.id));
    fake.tables.reservations = fake.tables.reservations.filter((r) => !gone.has(r.id));
  };
  const fires = () =>
    fake.tables.pickup_event
      .filter((e) => e.stay_date === NIGHT)
      .sort((a, b) => String(a.applied_at).localeCompare(String(b.applied_at)));
  const price = () =>
    Math.round(Number(fake.tables.published_price.find((p) => p.stay_date === NIGHT && p.room_type_id === STD)?.price) * 100) / 100;
  return { ...fake, runAt, daily, cancel, fires, price };
}

beforeEach(() => {
  resId = 0;
  appResetLog();
  edgeResetLog();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(ENGINES)("$name: the rules animation's scenes", (engine) => {
  it.each(BOXES)("$box: a rule adjusts, and cancellations can undo it", async ({ undo }) => {
    const steps = sceneSteps(SPEED_SCENE, undo);
    // One booking a day from day -3 to day 1: 5 in the week to day 1.
    const early = [-3, -2, -1, 0, 1].map((d) => booking(NIGHT, dayOf(at(d, 10)), at(d, 10)));
    const four = burst(4, at(3, 10));
    // 9 new bookings between day 6 and day 10.
    const later = [6, 6, 7, 7, 8, 8, 9, 9, 10].map((d) => booking(NIGHT, dayOf(at(d, 10)), at(d, 10)));
    const w = timeline(engine, {
      rules: [
        rule(
          "Faster",
          { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 7 },
          { undo_on_cancellation: undo },
        ),
      ],
      rows: [...fiveAWeek(), ...early, ...four, ...later],
      rooms: 200,
      basePrice: SPEED_SCENE.basePrice,
    });

    await w.daily(0, 1);
    expect(w.price()).toBe(steps[0].price);
    await w.daily(2, 3);
    expect(w.price()).toBe(steps[1].price);
    // What it counted and what is usual, as the scene shows them.
    expect(Number(w.fires()[0].window_bookings_at_fire)).toBe(steps[1].speed!.booked);
    expect(Math.round(Number(w.fires()[0].window_expected_at_fire))).toBe(steps[1].speed!.usual);

    await w.daily(4, 4);
    w.cancel(four.slice(0, 3));
    await w.daily(5, 5);
    expect(w.price()).toBe(steps[2].price);
    expect(w.fires()[0].retired_reason ?? null).toBe(undo ? "bookings_cancelled" : null);

    // Its week, from the raise (made on day 3 at 12:05), is over on day 10 at 12:05.
    await w.daily(6, 10);
    expect(w.price()).toBe(steps[3].price);
    expect(w.fires().map((e) => e.retired_reason ?? null)).toEqual(undo ? ["bookings_cancelled", null] : [null, null]);
    expect(w.fires().map((e) => String(e.applied_at))).toEqual([iso(at(3, 12, 5)), iso(at(10, 12, 5))]);
    expect(Number(w.fires()[1].window_bookings_at_fire)).toBe(steps[3].speed!.booked);
  }, 240_000);

  it.each(BOXES)("$box: an occupancy rule has no wait", async ({ undo }) => {
    const steps = sceneSteps(OCCUPANCY_SCENE, undo);
    const settled = Array.from({ length: 12 }, (_, i) => {
      const on = addDays(NIGHT, -(60 + i));
      return booking(NIGHT, on, `${on}T09:00:00.000Z`);
    });
    const three = burst(3, at(2, 10));
    const two = burst(2, at(4, 10));
    const w = timeline(engine, {
      rules: [
        rule("Busy", { occupancy_operator: "gt", occupancy_threshold: OCCUPANCY_SCENE.occupancyThreshold! / 100 }, {
          is_pickup_rule: false,
          undo_on_cancellation: undo,
        }),
      ],
      rows: [...settled, ...three, ...two],
      rooms: OCCUPANCY_SCENE.rooms!,
      basePrice: OCCUPANCY_SCENE.basePrice,
    });
    await w.daily(1, 1);
    expect(w.price()).toBe(steps[0].price);
    await w.daily(2, 2);
    expect(w.price()).toBe(steps[1].price);
    w.cancel(three.slice(0, 2));
    await w.daily(3, 3);
    expect(w.price()).toBe(steps[2].price);
    await w.daily(4, 4);
    expect(w.price()).toBe(steps[3].price);
  }, 120_000);

  it.each(BOXES)("$box: a stronger rule's change covers weaker ones", async ({ undo }) => {
    const steps = sceneSteps(STRONGER_SCENE, undo);
    const pickup = (id: string, threshold: number, value: number) =>
      rule(id, { pickup_operator: "gt", pickup_threshold: threshold, pickup_window_days: 7, pickup_metric: "room_nights" }, {
        action_value: value,
        undo_on_cancellation: undo,
      });
    const w = timeline(engine, {
      // "5 or more" and "10 or more" bookings in a week.
      rules: [pickup("Weaker", 4, 10), pickup("Stronger", 9, 20)],
      rows: [...burst(10, at(1, 10)), ...burst(3, at(2, 10)), ...burst(2, at(3, 10))],
      rooms: 40,
      basePrice: STRONGER_SCENE.basePrice,
      snapshotDays: 8,
    });
    await w.daily(0, 1);
    expect(w.price()).toBe(steps[0].price);
    await w.daily(2, 2);
    expect(w.price()).toBe(steps[1].price);
    await w.daily(3, 3);
    expect(w.price()).toBe(steps[2].price);
    // The weaker rule counted from the stronger raise: 10 booked there, 15 at its own.
    expect(w.fires().map((e) => [e.rule_id, e.signal_booked_units_start, e.signal_booked_units_end])).toEqual([
      ["Stronger", 0, 10],
      ["Weaker", 10, 15],
    ]);
  }, 120_000);
});
