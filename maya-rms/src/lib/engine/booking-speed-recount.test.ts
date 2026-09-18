/**
 * A rule never re-counts bookings it already acted on (Jake, 2026-09-18).
 *
 * After a Booking Speed rule fires on a night and room type, its next
 * decision there counts only bookings made from the hotel day after that
 * fire, against how the nights it is compared with did over the same days of
 * their booking curves. The fire that starts the count is the rule version's
 * latest one there that counts toward the owner alert (open, or taken off for
 * cancellations). A typed price is a reset point: the fires it took off start
 * nothing, and after its wait the rule judges its whole window again.
 *
 * The first case is the audit's reproduction (groups-audit.json, risks): one
 * 20-room wedding reservation, booked 40 days out on a quiet night, under the
 * five starter rules. The engine used to stack 12 raises on it, about 5x the
 * price, and file the owner alert twice. Now each starter rule acts on it
 * once: the one-day spike rule the day it lands, the week rule the day after,
 * and the month rule once the week rule's wait stops holding the night.
 *
 * Every case runs whole evaluateHotel runs, on the app's engine and on the
 * edge functions' copy, against the in-memory fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, daysBetween } from "@/lib/observations/calendar";
import { computeStarterRules } from "../../../supabase/functions/_shared/onboarding/generate-rules";
import { evaluateHotel as edgeEvaluateHotel } from "../../../supabase/functions/_shared/engine/evaluate";
import { resetBookingSpeedLogOnce as edgeResetLog } from "../../../supabase/functions/_shared/engine/booking-speed-provider";
import { resetBookingSpeedLogOnce as appResetLog } from "./booking-speed-provider";
import { evaluateHotel as appEvaluateHotel } from "./evaluate";
import { fakeSupabase, type FakeRow } from "./fake-supabase.test";

const D0 = "2026-09-16";
const T0 = Date.parse(`${D0}T12:00:00.000Z`);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const STD = "a0000000-0000-4000-8000-0000000000a1";
const SUITE = "a0000000-0000-4000-8000-0000000000a2";
const iso = (ms: number) => new Date(ms).toISOString();

const ENGINES = [
  { name: "app engine", evaluateHotel: appEvaluateHotel, resetLog: appResetLog },
  { name: "edge engine", evaluateHotel: edgeEvaluateHotel, resetLog: edgeResetLog },
];

function roomType(id: string, over: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    hotel_id: "h1",
    name: id === STD ? "Standard" : "Suite",
    is_active: true,
    total_rooms: 40,
    floor_price: 10,
    // No ceiling to speak of: the audit's case, where nothing else stops it.
    ceiling_price: 99999,
    counts_as_room: true,
    ...over,
  };
}

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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    rule_condition: [condition],
    rule_signal_room_type: [{ room_type_id: STD }],
    rule_affected_room_type: [{ room_type_id: STD }],
    ...over,
  };
}

/** The five starter rules, as onboarding writes them, on the one room type. */
function starterRules(): FakeRow[] {
  return computeStarterRules({ daysOfHistory: 400 }).map((spec) =>
    rule(spec.name, spec.condition as FakeRow, {
      priority: spec.priority,
      action_type: spec.action.action_type,
      action_direction: spec.action.action_direction,
      action_value: spec.action.action_value,
      is_pickup_rule: spec.is_pickup_rule,
    }),
  );
}

let resId = 0;
function booking(stay: string, bookedOn: string, roomTypeId = STD): FakeRow {
  return {
    id: `f0000000-0000-4000-8000-${String(++resId).padStart(12, "0")}`,
    hotel_id: "h1",
    stay_date: stay,
    room_type_id: roomTypeId,
    booking_date: bookedOn,
    booking_window_days: daysBetween(bookedOn, stay),
    current_rate: 100,
    base_rate: 100,
    created_at: `${bookedOn}T10:00:00.000Z`,
  };
}

/**
 * The same booking curve on every night from 400 days back to `last`: one
 * booking at each of `leads` days before arrival. Every night then reads
 * exactly Normal against the nights it is compared with, unless a test adds
 * something. Rows dated after a run's day are never counted by it: their
 * lead time is shorter than the night is away.
 */
function background(last: string, leads: number[], roomTypeId = STD): FakeRow[] {
  const out: FakeRow[] = [];
  for (let stay = addDays(D0, -400); stay <= last; stay = addDays(stay, 1)) {
    for (const lead of leads) out.push(booking(stay, addDays(stay, -lead), roomTypeId));
  }
  return out;
}

/** One booking every 10 days of lead time: 0 to 1 a day, about 3 a month. */
const QUIET = Array.from({ length: 18 }, (_, i) => 3 + 10 * i);

type Engine = (typeof ENGINES)[number];

function world(
  engine: Engine,
  opts: { rules: FakeRow[]; reservations: FakeRow[]; last: string; roomTypes?: FakeRow[]; manual?: FakeRow[]; timezone?: string },
) {
  const roomTypes = opts.roomTypes ?? [roomType(STD)];
  const nights: string[] = [];
  for (let d = D0; d <= opts.last; d = addDays(d, 1)) nights.push(d);
  const fake = fakeSupabase({
    hotels: [{ id: "h1", timezone: opts.timezone ?? "UTC" }],
    room_types: roomTypes,
    reservations: opts.reservations,
    base_rate_calendar: nights.flatMap((stay) =>
      roomTypes.map((rt) => ({ hotel_id: "h1", stay_date: stay, room_type_id: rt.id, price: 100 })),
    ),
    pricing_rules: opts.rules,
    stay_date_snapshot: [],
    manual_price: opts.manual ?? [],
  });
  /** One run on day `day` of the story, at noon, pricing through `last`. */
  const run = async (day: number, extraMs = 0) => {
    const at = iso(T0 + day * DAY + extraMs);
    vi.setSystemTime(new Date(at));
    return engine.evaluateHotel(fake.client, "h1", at, daysBetween(at.slice(0, 10), opts.last) + 1);
  };
  const fires = (stay: string, rt = STD) =>
    fake.tables.pickup_event
      .filter((e) => e.stay_date === stay && e.affected_room_type_id === rt)
      .sort((a, b) => String(a.applied_at).localeCompare(String(b.applied_at)));
  const firedOn = (stay: string, rt = STD) =>
    fires(stay, rt).map((e) => [e.rule_id, daysBetween(D0, String(e.applied_at).slice(0, 10))]);
  const price = (stay: string, rt = STD) =>
    Number(fake.tables.published_price.find((p) => p.stay_date === stay && p.room_type_id === rt)?.price);
  return { ...fake, run, fires, firedOn, price, nights };
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

describe.each(ENGINES)("$name: a Booking Speed rule never re-counts bookings it already acted on", (engine) => {
  /* ── The audit's cascade ─────────────────────────────────────── */

  describe("one 20-room wedding reservation on a quiet night", () => {
    const NIGHT = addDays(D0, 40);
    const LAST = addDays(D0, 41);
    const wedding = () => Array.from({ length: 20 }, () => booking(NIGHT, D0));

    it("under the starter rules, each rule acts on it once: 3 raises, not 12, and no owner alert", async () => {
      const w = world(engine, { rules: starterRules(), reservations: [...background(LAST, QUIET), ...wedding()], last: LAST });
      for (let day = 0; day <= 32; day++) await w.run(day);

      // Spike the day it lands, the week rule the next day, and the month
      // rule on day 3: on day 2 the week rule, still waiting on what it fired
      // on, holds the night against it.
      expect(w.firedOn(NIGHT)).toEqual([
        ["Sudden-spike catcher", 0],
        ["Hot-week surge", 1],
        ["Warm-date bump", 3],
      ]);
      expect(w.fires(NIGHT).map((e) => [e.fire_seq, e.retired_at])).toEqual([
        [1, null],
        [1, null],
        [1, null],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.25 * 1.25 * 1.1, 1);
      // No night was adjusted three times by one rule, so nothing to ask.
      expect(w.tables.rule_repeat_alert_nights ?? []).toEqual([]);
      // Every other night reads Normal throughout.
      expect(w.tables.pickup_event.every((e) => e.stay_date === NIGHT)).toBe(true);
    }, 120_000);

    it("a single month-window rule with a 3-day wait raises once, not every 3 days for a month", async () => {
      const warm = starterRules().filter((r) => r.name === "Warm-date bump");
      const w = world(engine, { rules: warm, reservations: [...background(LAST, QUIET), ...wedding()], last: LAST });
      for (let day = 0; day <= 30; day += 3) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([["Warm-date bump", 0]]);
      expect(w.price(NIGHT)).toBe(110);
    }, 120_000);

    it("each room type counts from its own last fire", async () => {
      // The rule changes Standard and Suite. The Suite sits at its ceiling on
      // day 0, so only Standard fires; lift the ceiling on day 3 and the
      // Suite, which has not acted on the wedding yet, raises once. Standard
      // doesn't raise again on it.
      const warm = starterRules()
        .filter((r) => r.name === "Warm-date bump")
        .map((r) => ({ ...r, rule_affected_room_type: [{ room_type_id: STD }, { room_type_id: SUITE }] }));
      const w = world(engine, {
        rules: warm,
        reservations: [...background(LAST, QUIET), ...wedding()],
        last: LAST,
        roomTypes: [roomType(STD), roomType(SUITE, { ceiling_price: 100 })],
      });
      await w.run(0);
      expect(w.firedOn(NIGHT, STD)).toEqual([["Warm-date bump", 0]]);
      expect(w.firedOn(NIGHT, SUITE)).toEqual([]);
      w.tables.room_types.find((rt) => rt.id === SUITE)!.ceiling_price = 99999;
      await w.run(3);
      expect(w.firedOn(NIGHT, STD)).toEqual([["Warm-date bump", 0]]);
      expect(w.firedOn(NIGHT, SUITE)).toEqual([["Warm-date bump", 3]]);
      await w.run(6);
      expect(w.fires(NIGHT, STD)).toHaveLength(1);
      expect(w.fires(NIGHT, SUITE)).toHaveLength(1);
    }, 120_000);

    it("a one-day rule doesn't count its own day twice on the 25-hour night the clocks go back", async () => {
      // New York falls back on 2026-11-01. A fire at 00:30 that morning and a
      // run a full day later, at 23:30, are on the same hotel day: the day's
      // wait is over, but there is no new day of bookings to judge yet.
      const night = "2026-11-20";
      const last = "2026-11-21";
      const spike = starterRules().filter((r) => r.name === "Sudden-spike catcher");
      const w = world(engine, {
        rules: spike,
        reservations: [...background(last, QUIET), ...Array.from({ length: 20 }, () => booking(night, "2026-11-01"))],
        last,
        timezone: "America/New_York",
      });
      const firstRun = Date.parse("2026-11-01T04:30:00.000Z") - T0;
      await w.run(0, firstRun);
      expect(w.fires(night)).toHaveLength(1);
      await w.run(1, firstRun);
      expect(w.fires(night)).toHaveLength(1);
      expect(w.price(night)).toBe(125);
    }, 120_000);
  });

  /* ── Real demand still stacks ────────────────────────────────── */

  describe("bookings that keep coming", () => {
    const NIGHT = addDays(D0, 40);
    const LAST = addDays(D0, 41);
    const warm = () => starterRules().filter((r) => r.name === "Warm-date bump");

    it("raise again after each wait, each on the bookings since the last one, with frozen windows end to end", async () => {
      const w = world(engine, { rules: warm(), reservations: background(LAST, QUIET), last: LAST });
      // Four rooms a day, every day, against about one a week usually.
      for (let day = 0; day <= 9; day++) {
        for (let k = 0; k < 4; k++) w.tables.reservations.push(booking(NIGHT, addDays(D0, day)));
        await w.run(day);
      }
      expect(w.firedOn(NIGHT)).toEqual([
        ["Warm-date bump", 0],
        ["Warm-date bump", 3],
        ["Warm-date bump", 6],
        ["Warm-date bump", 9],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.1 ** 4, 1);
      const windows = w.fires(NIGHT).map((e) => [e.window_from, e.window_to, e.window_bookings_at_fire]);
      expect(windows).toEqual([
        // The first judges its whole month (the day's 4 plus 3 older ones).
        [addDays(D0, -29), D0, 7],
        // Every later one only the days since the one before.
        [addDays(D0, 1), addDays(D0, 3), 12],
        [addDays(D0, 4), addDays(D0, 6), 12],
        // Twelve new ones, and the one a night like it gets 33 days out.
        [addDays(D0, 7), addDays(D0, 9), 13],
      ]);
    }, 120_000);

    it("when the bookings behind the second raise cancel, only the second raise comes off", async () => {
      const w = world(engine, { rules: warm(), reservations: background(LAST, QUIET), last: LAST });
      for (let day = 0; day <= 3; day++) {
        for (let k = 0; k < 4; k++) w.tables.reservations.push(booking(NIGHT, addDays(D0, day)));
        await w.run(day);
      }
      expect(w.fires(NIGHT)).toHaveLength(2);
      expect(w.price(NIGHT)).toBe(121);

      // Days 1 to 3 cancel: the second raise's own window is back to usual.
      const second = (r: FakeRow) =>
        r.stay_date === NIGHT && String(r.booking_date) >= addDays(D0, 1) && String(r.booking_date) <= addDays(D0, 3);
      w.tables.reservations = w.tables.reservations.filter((r) => !second(r));
      await w.run(3, HOUR);
      expect(w.fires(NIGHT).map((e) => [e.fire_seq, e.retired_reason])).toEqual([
        [1, null],
        [2, "bookings_cancelled"],
      ]);
      expect(w.price(NIGHT)).toBe(110);

      // Day 0's four go too: the first comes off as well.
      w.tables.reservations = w.tables.reservations.filter((r) => !(r.stay_date === NIGHT && r.booking_date === D0));
      await w.run(3, 2 * HOUR);
      expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual(["bookings_cancelled", "bookings_cancelled"]);
      expect(w.price(NIGHT)).toBe(100);
    }, 120_000);
  });

  /* ── Cuts ─────────────────────────────────────────────────────── */

  describe("a slow night", () => {
    // Nights like it book a room every day from 49 days out to arrival.
    const NIGHT = addDays(D0, 20);
    const LAST = addDays(D0, 21);
    const DAILY = Array.from({ length: 50 }, (_, i) => i);
    const slow = () => [
      rule("r-slow", { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 7 }, {
        action_direction: "decrease",
      }),
    ];
    /** Everything but NIGHT books as usual; NIGHT stopped booking 50 days out. */
    const history = () => [
      ...background(LAST, DAILY).filter((r) => r.stay_date !== NIGHT),
      ...[50, 51, 52].map((lead) => booking(NIGHT, addDays(NIGHT, -lead))),
    ];

    it("cuts again after its wait when nothing came in since the first cut", async () => {
      const w = world(engine, { rules: slow(), reservations: history(), last: LAST });
      await w.run(0);
      expect(w.price(NIGHT)).toBe(90);
      await w.run(6);
      expect(w.fires(NIGHT)).toHaveLength(1);
      await w.run(7);
      expect(w.fires(NIGHT).map((e) => [e.fire_seq, e.window_from, e.window_to, e.window_bookings_at_fire])).toEqual([
        [1, addDays(D0, -29), D0, 0],
        [2, addDays(D0, 1), addDays(D0, 7), 0],
      ]);
      expect(w.price(NIGHT)).toBe(81);
    }, 120_000);

    it("doesn't cut again when the bookings since its cut came in at the usual pace, though its whole month still reads slow", async () => {
      const w = world(engine, { rules: slow(), reservations: history(), last: LAST });
      await w.run(0);
      expect(w.price(NIGHT)).toBe(90);
      // A room a day after the cut: what nights like it get.
      for (let day = 1; day <= 7; day++) w.tables.reservations.push(booking(NIGHT, addDays(D0, day)));
      await w.run(7);
      await w.run(8);
      expect(w.fires(NIGHT)).toHaveLength(1);
      expect(w.price(NIGHT)).toBe(90);
    }, 120_000);
  });

  /* ── Typed prices ─────────────────────────────────────────────── */

  describe("a price typed on the night", () => {
    const NIGHT = addDays(D0, 40);
    const LAST = addDays(D0, 41);

    it("starts the rule over: after its wait it judges its whole window, then counts from its new fire", async () => {
      const warm = starterRules().filter((r) => r.name === "Warm-date bump");
      const w = world(engine, {
        rules: warm,
        reservations: [...background(LAST, QUIET), ...Array.from({ length: 20 }, () => booking(NIGHT, D0))],
        last: LAST,
      });
      await w.run(0);
      expect(w.price(NIGHT)).toBe(110);

      // The owner types 150 on day 1. The raise comes off, and the rule
      // waits its 3 days from then.
      const setAt = iso(T0 + DAY + HOUR);
      w.tables.manual_price.push({ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: setAt, cleared_at: null });
      await w.run(1, 2 * HOUR);
      expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual(["manual_price"]);
      expect(w.price(NIGHT)).toBe(150);
      await w.run(4);
      expect(w.fires(NIGHT)).toHaveLength(1);

      // Wait over: the whole month again, wedding included, as decided for
      // typed prices. It raises on top of the typed price.
      await w.run(4, 2 * HOUR);
      expect(w.fires(NIGHT).map((e) => [e.fire_seq, e.retired_reason, e.window_from])).toEqual([
        [1, "manual_price", addDays(D0, -29)],
        [2, null, addDays(D0, -25)],
      ]);
      expect(w.price(NIGHT)).toBe(165);

      // And from that fire on, only what comes after it counts.
      for (const day of [7, 10, 13, 16]) await w.run(day, 2 * HOUR);
      expect(w.fires(NIGHT)).toHaveLength(2);
      expect(w.price(NIGHT)).toBe(165);
    }, 120_000);
  });
});
