/**
 * A rule counts only the bookings made after the newest change on the night
 * and room type by itself or by a rule that adjusts the same way and ranks
 * ahead of it (Jake, 2026-09-18 and 2026-09-24, option A). A weaker rule's
 * change never restarts a stronger rule's count: "the clock doesn't reset,
 * the count just continues".
 *
 * After such a change, a Booking Speed rule's next decision on the night
 * and room type counts only the bookings that reached MAYA after it: a
 * raise rule from the change's hotel day on, that day only the bookings
 * first seen after it (the split in observeBookingSpeed, on
 * reservations.created_at), against how the nights it is compared with did
 * over the same days of their booking curves. A cut rule reads complete
 * days only, ending yesterday, and after a cut counts the complete days
 * after the cut's day. The change that starts the count is the newest fire
 * there that counts toward the owner alert (open, or taken off for
 * cancellations), from its rule's current version, by the rule itself or a
 * stronger one, paused or not, a pickup count rule included. Raises and
 * cuts never move each other. A rule with no such change on the night
 * judges its whole window. A stronger rule that is waiting holds the night
 * against the weaker rules its way only while what it counts itself meets
 * its bar again; tiers climb as pace climbs. A typed price is
 * a reset point: the fires it took off start nothing, and after its wait
 * the rule judges its whole window again.
 *
 * The first case is the audit's reproduction (groups-audit.json, risks):
 * twenty rooms booked in one day, 40 days out on a quiet night, under the
 * five starter rules. The engine used to stack 12 raises on it, about 5x the
 * price, and file the owner alert twice. Now the one-day spike rule raises
 * on it the day it lands, and the week and month rules, which rank below
 * it, never count those twenty again. That case keeps its rows unkeyed, so
 * they are twenty separate bookings. The audit's real wedding, one 20-room reservation keyed as the
 * PMS keys it, is the case after it: booking speed counts bookings (Jake,
 * 2026-09-20), so the wedding is one booking on a quiet night and no rule
 * raises on pace at all, while an occupancy rule still sees its twenty
 * rooms. booking-speed-cumulative.test.ts runs the owner's own examples and
 * the same stories with bookings arriving at their created_at.
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

/**
 * Snapshots every 6 hours over the `days` before T0, counted from the
 * reservations in rooms, so a pickup count rule has a baseline to read on
 * day 0 (the engine writes its own from then on).
 */
function snapshots(reservations: FakeRow[], nights: string[], roomTypeIds: string[], days: number): FakeRow[] {
  const out: FakeRow[] = [];
  for (let h = days * 24; h > 0; h -= 6) {
    const ts = iso(T0 - h * HOUR);
    for (const stay of nights) {
      for (const rt of roomTypeIds) {
        const n = reservations.filter(
          (r) => r.stay_date === stay && r.room_type_id === rt && `${r.booking_date}T23:59:59.000Z` <= ts,
        ).length;
        out.push({ hotel_id: "h1", snapshot_ts: ts, stay_date: stay, room_type_id: rt, sellable_units: 40, booked_units: n, booked_revenue: n * 100 });
      }
    }
  }
  return out;
}

type Engine = (typeof ENGINES)[number];

function world(
  engine: Engine,
  opts: {
    rules: FakeRow[];
    reservations: FakeRow[];
    last: string;
    roomTypes?: FakeRow[];
    manual?: FakeRow[];
    timezone?: string;
    /** Days of 6-hourly snapshots before T0, for a pickup count rule's baseline. */
    snapshotDays?: number;
  },
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
    stay_date_snapshot: opts.snapshotDays
      ? snapshots(opts.reservations, nights, roomTypes.map((rt) => String(rt.id)), opts.snapshotDays)
      : [],
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

describe.each(ENGINES)("$name: a Booking Speed rule never counts bookings it or a stronger rule already acted on", (engine) => {
  /* ── The audit's cascade ─────────────────────────────────────── */

  describe("twenty separate bookings landing on a quiet night in one day", () => {
    const NIGHT = addDays(D0, 40);
    const LAST = addDays(D0, 41);
    // Unkeyed rows: each one a booking of its own.
    const wedding = () => Array.from({ length: 20 }, () => booking(NIGHT, D0));

    it("under the starter rules, the spike rule raises on them once, the weaker rules never count them again, and no owner alert", async () => {
      const w = world(engine, { rules: starterRules(), reservations: [...background(LAST, QUIET), ...wedding()], last: LAST });
      await w.run(0);
      expect(w.firedOn(NIGHT)).toEqual([["Sudden-spike catcher", 0]]);
      // A later run the same day: the spike rule waits, and the week and
      // month rules, which rank below it, count only what came after its
      // raise: nothing.
      await w.run(0, 6 * HOUR);
      expect(w.fires(NIGHT)).toHaveLength(1);
      for (let day = 1; day <= 32; day++) await w.run(day);

      // The days after, the week and month rules still count only what came
      // after its raise, which is the usual trickle: neither raises. One raise, not
      // twelve, and not the three it took while each rule counted the
      // twenty for itself.
      expect(w.firedOn(NIGHT)).toEqual([["Sudden-spike catcher", 0]]);
      expect(w.fires(NIGHT).map((e) => [e.window_from, e.window_since, e.window_to, e.window_bookings_at_fire, e.retired_at])).toEqual([
        [D0, null, D0, 20, null],
      ]);
      expect(w.price(NIGHT)).toBe(125);
      // No night was adjusted three times by one rule, so nothing to ask.
      expect(w.tables.rule_repeat_alert_nights ?? []).toEqual([]);
      // Every other night reads Normal throughout.
      expect(w.tables.pickup_event.every((e) => e.stay_date === NIGHT)).toBe(true);
    }, 120_000);

    it("pausing the rule that raised keeps its raise on the night, and it still covers the weaker rules", async () => {
      const w = world(engine, { rules: starterRules(), reservations: [...background(LAST, QUIET), ...wedding()], last: LAST });
      await w.run(0);
      expect(w.firedOn(NIGHT)).toEqual([["Sudden-spike catcher", 0]]);
      // The owner pauses the spike rule that evening. Its raise stays on the
      // price, so the week and month rules still count only what came after
      // it, as if it were running.
      w.tables.pricing_rules.find((r) => r.name === "Sudden-spike catcher")!.is_active = false;
      for (let day = 1; day <= 6; day++) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([["Sudden-spike catcher", 0]]);
      expect(w.price(NIGHT)).toBe(125);
    }, 120_000);

    it("a stronger pickup count rule's raise covers the Booking Speed rules below it", async () => {
      // Ten separate bookings land on the quiet night. A pickup count rule
      // (more than 5 room-nights in 7 days) raises 30%, more than any
      // starter rule, so it outranks them and raises on them on day 0. The
      // starter rules' windows still hold the ten after that, but they came
      // before a stronger rule's raise, so they don't count them.
      const pickup = rule(
        "Pickup raise",
        { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" },
        { action_value: 30 },
      );
      const w = world(engine, {
        rules: [pickup, ...starterRules()],
        reservations: [...background(LAST, QUIET), ...Array.from({ length: 10 }, () => booking(NIGHT, D0))],
        last: LAST,
        snapshotDays: 10,
      });
      for (let day = 0; day <= 12; day++) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([["Pickup raise", 0]]);
      expect(w.price(NIGHT)).toBe(130);
      // The pickup fire carries no frozen window of its own, and records
      // what was first seen during its week: the ten and the one booking
      // the night usually gets in a week (made 43 days out, 3 days ago).
      expect(
        w.fires(NIGHT).map((e) => [e.cancel_check, e.window_from, e.window_bookings_at_fire, e.pickup_units_arrived_at_fire]),
      ).toEqual([["recount", null, null, 11]]);
    }, 120_000);

    it("a weaker pickup count rule counts only what came after a stronger Booking Speed rule's raise", async () => {
      // The other way round: the pickup rule raises 10%, less than the
      // spike rule's 25%, so it ranks below it.
      // Its week holds the twenty, but its count opens at the spike rule's
      // raise, and nothing came after it.
      const pickup = rule(
        "Pickup raise",
        { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" },
        { priority: 90, action_value: 10 },
      );
      const w = world(engine, {
        rules: [pickup, ...starterRules()],
        reservations: [...background(LAST, QUIET), ...wedding()],
        last: LAST,
        snapshotDays: 10,
      });
      for (let day = 0; day <= 8; day++) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([["Sudden-spike catcher", 0]]);
      expect(w.price(NIGHT)).toBe(125);
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

    it("a one-day rule doesn't count the bookings it raised on twice on the 25-hour night the clocks go back", async () => {
      // New York falls back on 2026-11-01. A fire at 00:30 that morning and a
      // run a full day later, at 23:30, are on the same hotel day: the day's
      // wait is over, and the rule reads that day again, but only what
      // reached MAYA after its raise, which is nothing.
      const night = "2026-11-20";
      const last = "2026-11-21";
      const spike = starterRules().filter((r) => r.name === "Sudden-spike catcher");
      const w = world(engine, {
        rules: spike,
        reservations: [
          ...background(last, QUIET),
          ...Array.from({ length: 20 }, () => ({ ...booking(night, "2026-11-01"), created_at: "2026-11-01T03:00:00.000Z" })),
        ],
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

  /* ── Bookings that reach MAYA later on the day of a raise ─────── */

  describe("a bigger wave later on the day of a raise", () => {
    const NIGHT = addDays(D0, 40);
    const LAST = addDays(D0, 41);
    /** Ten separate bookings dated D0, on the books before the noon run. */
    const morning = () => Array.from({ length: 10 }, () => booking(NIGHT, D0));
    const week = () => starterRules().filter((r) => r.name === "Hot-week surge");

    it("is not lost with the raise: after its wait the rule raises again on the thirty that came after it, and on those alone", async () => {
      const w = world(engine, { rules: week(), reservations: [...background(LAST, QUIET), ...morning()], last: LAST });
      await w.run(0);
      expect(w.firedOn(NIGHT)).toEqual([["Hot-week surge", 0]]);
      // Thirty more separate bookings, dated D0, reach MAYA that afternoon.
      for (let k = 0; k < 30; k++) w.tables.reservations.push({ ...booking(NIGHT, D0), created_at: iso(T0 + 2 * HOUR) });
      // The rule waits two days.
      for (const extra of [3 * HOUR, 6 * HOUR]) await w.run(0, extra);
      await w.run(1);
      expect(w.fires(NIGHT)).toHaveLength(1);
      for (let day = 2; day <= 6; day++) await w.run(day);
      // Then it counts from its own raise: the thirty that came after it on
      // D0, and nothing since, against what a night like it gets over those
      // three days. That is the wave, and it raises once more.
      expect(w.firedOn(NIGHT)).toEqual([
        ["Hot-week surge", 0],
        ["Hot-week surge", 2],
      ]);
      expect(w.fires(NIGHT).map((e) => [e.window_from, e.window_since, e.window_to, e.window_bookings_at_fire])).toEqual([
        [addDays(D0, -6), null, D0, 11],
        [D0, iso(T0), addDays(D0, 2), 30],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.25 * 1.25, 1);
      // The fire's own audit says the count started at its last raise, on its day.
      const fired = w.tables.evaluation_audit
        .filter((a) => a.stay_date === NIGHT)
        .flatMap((a) => ((a.details as { pickup_candidates?: { rule_id: string; outcome: string; fire_seq?: number; metrics?: { booking_speed?: Record<string, unknown> } }[] }).pickup_candidates ?? []))
        .find((c) => c.rule_id === "Hot-week surge" && c.outcome === "won" && c.fire_seq === 2);
      expect(fired?.metrics?.booking_speed).toMatchObject({ recent: 30, window_days: 3, counted_from: D0, counted_since: iso(T0), full_window_days: 7 });
    }, 120_000);

    it("control: the same thirty dated the next day raise again the same way", async () => {
      const w = world(engine, { rules: week(), reservations: [...background(LAST, QUIET), ...morning()], last: LAST });
      await w.run(0);
      for (let k = 0; k < 30; k++) w.tables.reservations.push(booking(NIGHT, addDays(D0, 1)));
      for (let day = 1; day <= 6; day++) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([
        ["Hot-week surge", 0],
        ["Hot-week surge", 2],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.25 * 1.25, 1);
    }, 120_000);

    it("a wave that reached MAYA before the raise is that raise's, and the rule never raises again on it", async () => {
      // Forty rows on the books before noon: the rule raises on all forty
      // at once, and never reads them again.
      const w = world(engine, {
        rules: week(),
        reservations: [...background(LAST, QUIET), ...morning(), ...Array.from({ length: 30 }, () => booking(NIGHT, D0))],
        last: LAST,
      });
      for (let day = 0; day <= 8; day++) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([["Hot-week surge", 0]]);
      expect(w.fires(NIGHT)[0].window_bookings_at_fire).toBe(41);
      expect(w.price(NIGHT)).toBe(125);
    }, 120_000);

    it("with the week and month rules, the month rule ranks below the week rule and never counts what the week rule raised on", async () => {
      const rules = starterRules().filter((r) => r.name !== "Sudden-spike catcher");
      const w = world(engine, { rules, reservations: [...background(LAST, QUIET), ...morning()], last: LAST });
      await w.run(0);
      expect(w.firedOn(NIGHT)).toEqual([["Hot-week surge", 0]]);
      for (let k = 0; k < 30; k++) w.tables.reservations.push({ ...booking(NIGHT, D0), created_at: iso(T0 + 2 * HOUR) });
      await w.run(0, 6 * HOUR);
      // The month rule counts the wave from the week rule's raise, but the
      // week rule counts the thirty since its own raise too, reads much
      // faster again and holds the night through its 2-day wait: they are
      // its own next raise. Then it fires on the thirty. After that the
      // month rule counts only what came after the week rule's second
      // raise: nothing. Both waves were the week rule's.
      expect(w.fires(NIGHT)).toHaveLength(1);
      for (let day = 1; day <= 6; day++) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([
        ["Hot-week surge", 0],
        ["Hot-week surge", 2],
      ]);
      expect(w.fires(NIGHT).map((e) => [e.window_from, e.window_since, e.window_to, e.window_bookings_at_fire])).toEqual([
        [addDays(D0, -6), null, D0, 11],
        [D0, iso(T0), addDays(D0, 2), 30],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.25 * 1.25, 1);
    }, 120_000);
  });

  /* ── The audit's wedding: one reservation, twenty rooms ───────── */

  describe.each([
    { pms: "Cloudbeds", key: (k: number) => `6364686337417-${k}` },
    { pms: "Think", key: (k: number) => `res_77:b${k}` },
  ])("one 20-room wedding reservation on a quiet night, keyed as $pms keys it", ({ key }) => {
    const NIGHT = addDays(D0, 40);
    const LAST = addDays(D0, 41);
    const wedding = (bookedOn: string, from = 1, to = 20) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({ ...booking(NIGHT, bookedOn), external_reservation_id: key(from + i) }));
    /** The one occupancy rule: above half full, raise 10%. */
    const busy = () =>
      rule("Busy night", { occupancy_operator: "gt", occupancy_threshold: 0.5 }, { is_pickup_rule: false, priority: 50 });

    it("is one booking for pace: under the starter rules nothing raises, while an occupancy rule sees its twenty rooms", async () => {
      const w = world(engine, {
        rules: [...starterRules(), busy()],
        reservations: [...background(LAST, QUIET), ...wedding(D0)],
        last: LAST,
      });
      for (let day = 0; day <= 32; day++) await w.run(day);
      // One booking against the none to one a night like it gets: Normal.
      expect(w.tables.pickup_event).toEqual([]);
      expect(w.tables.rule_repeat_alert_nights ?? []).toEqual([]);
      // The 18 background rooms are 45% of 40; the wedding's twenty take it to 95%.
      expect(w.price(NIGHT)).toBe(110);
      expect(w.price(addDays(D0, 39))).toBe(100);
      const audit = w.tables.evaluation_audit.filter((a) => a.stay_date === NIGHT && a.room_type_id === STD).at(-1)!;
      expect(JSON.stringify(audit.details)).toContain("Busy night");
    }, 120_000);

    it("records a fire's window in bookings, so the cancellation check and the owner alert read the same unit", async () => {
      // A 6-room reservation and four singles land on day 0: five bookings,
      // ten rooms. The spike rule fires on five, and writes five.
      const spike = starterRules().filter((r) => r.name === "Sudden-spike catcher");
      const w = world(engine, {
        rules: spike,
        reservations: [...background(LAST, QUIET), ...wedding(D0, 1, 6), ...Array.from({ length: 4 }, () => booking(NIGHT, D0))],
        last: LAST,
      });
      await w.run(0);
      expect(w.fires(NIGHT).map((e) => [e.rule_id, e.window_from, e.window_to, e.window_bookings_at_fire, e.cancel_check])).toEqual([
        ["Sudden-spike catcher", D0, D0, 5, "recount"],
      ]);
      // Four of the reservation's six rooms cancel: rooms went, but it is
      // still five bookings, still a surge, and the raise stays.
      w.tables.reservations = w.tables.reservations.filter((r) => !["3", "4", "5", "6"].map((k) => key(Number(k))).includes(String(r.external_reservation_id)));
      await w.run(0, HOUR);
      expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual([null]);
      // The whole reservation cancels: four bookings on a day a night like it
      // gets none is still a surge.
      w.tables.reservations = w.tables.reservations.filter(
        (r) => !["1", "2"].map((k) => key(Number(k))).includes(String(r.external_reservation_id)),
      );
      await w.run(0, 2 * HOUR);
      expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual([null]);
      // Two of the singles cancel too: two bookings is no longer a surge, so
      // the raise comes off.
      const singles = w.tables.reservations.filter((r) => r.stay_date === NIGHT && r.booking_date === D0).slice(0, 2);
      w.tables.reservations = w.tables.reservations.filter((r) => !singles.includes(r));
      await w.run(0, 3 * HOUR);
      expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual(["bookings_cancelled"]);
    }, 120_000);

    it("counts rooms added to the reservation later at the booking's own date, not as new bookings", async () => {
      // Ten rooms booked a month ago; ten more join the same reservation on day 3.
      const w = world(engine, { rules: starterRules(), reservations: [...background(LAST, QUIET), ...wedding(addDays(D0, -30), 1, 10)], last: LAST });
      for (let day = 0; day <= 2; day++) await w.run(day);
      expect(w.tables.pickup_event).toEqual([]);
      w.tables.reservations.push(...wedding(addDays(D0, 3), 11, 20));
      for (let day = 3; day <= 12; day++) await w.run(day);
      expect(w.tables.pickup_event).toEqual([]);
      expect(w.price(NIGHT)).toBe(100);
      // Where twenty separate bookings on day 3 would have raised.
      const separate = world(engine, {
        rules: starterRules(),
        reservations: [...background(LAST, QUIET), ...Array.from({ length: 10 }, () => booking(NIGHT, addDays(D0, 3)))],
        last: LAST,
      });
      for (let day = 0; day <= 3; day++) await separate.run(day);
      expect(separate.firedOn(NIGHT)).toEqual([["Sudden-spike catcher", 3]]);
    }, 120_000);
  });

  /* ── A burst that keeps growing climbs the tiers ─────────────── */

  describe("a burst that keeps growing after the first raise", () => {
    const NIGHT = addDays(D0, 40);
    const LAST = addDays(D0, 41);
    // Nights like it book a room a day over their last 50 days.
    const DAILY = Array.from({ length: 50 }, (_, i) => i);

    it("climbs to the tier the burst reaches, and the weaker tiers count only what came after it", async () => {
      // Five rooms booked 50 days out put the month a bit ahead (15 against
      // the usual 10) while the week and the day read normal: the month rule
      // raises 10% on day 0. On day 1 twenty rooms land in one day.
      const w = world(engine, {
        rules: starterRules(),
        reservations: [...background(LAST, DAILY), ...Array.from({ length: 5 }, () => booking(NIGHT, addDays(NIGHT, -50)))],
        last: LAST,
      });
      await w.run(0);
      expect(w.firedOn(NIGHT)).toEqual([["Warm-date bump", 0]]);
      for (let k = 0; k < 20; k++) w.tables.reservations.push(booking(NIGHT, addDays(D0, 1)));
      for (let day = 1; day <= 10; day++) await w.run(day);
      // The spike rule fires on the twenty while the month rule waits: the
      // month rule's raise is weaker, so it doesn't restart the spike rule's
      // count. The week and month rules rank below the spike rule, so from
      // then on they count only what came after its raise: a room a day,
      // the usual pace. Nobody counts the twenty twice.
      expect(w.firedOn(NIGHT)).toEqual([
        ["Warm-date bump", 0],
        ["Sudden-spike catcher", 1],
      ]);
      expect(w.fires(NIGHT).map((e) => [e.window_from, e.window_since, e.window_to, e.window_bookings_at_fire])).toEqual([
        [addDays(D0, -29), null, D0, 15],
        [addDays(D0, 1), null, addDays(D0, 1), 21],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.1 * 1.25, 1);
    }, 120_000);
  });

  /* ── Real demand still stacks ────────────────────────────────── */

  describe("bookings that keep coming", () => {
    const NIGHT = addDays(D0, 40);
    const LAST = addDays(D0, 41);
    const warm = () => starterRules().filter((r) => r.name === "Warm-date bump");

    it("a surge of separate bookings over two weeks still stacks raises under the starter rules, each on the bookings since that rule's last raise", async () => {
      const w = world(engine, { rules: starterRules(), reservations: background(LAST, QUIET), last: LAST });
      // Three rooms a day, every day, against about one a week usually.
      for (let day = 0; day <= 13; day++) {
        for (let k = 0; k < 3; k++) w.tables.reservations.push(booking(NIGHT, addDays(D0, day)));
        await w.run(day);
      }
      // The week rule catches it on day 0 and, after each 2-day wait, fires
      // again on the days since its own last raise (from that raise's day
      // on, the day itself split at the raise). The month rule counts from
      // those raises too, and in between the week rule holds the night
      // against it while those bookings read much faster again. The day
      // rule never reads surging on
      // three rooms in a day (too few to call it), so it stays out.
      expect(w.firedOn(NIGHT)).toEqual([
        ["Hot-week surge", 0],
        ["Hot-week surge", 2],
        ["Hot-week surge", 4],
        ["Hot-week surge", 6],
        ["Hot-week surge", 8],
        ["Hot-week surge", 10],
        ["Hot-week surge", 12],
      ]);
      const windows = w.fires(NIGHT).map((e) => [e.window_from, e.window_to, e.window_since]);
      expect(windows).toEqual([
        [addDays(D0, -6), D0, null],
        [D0, addDays(D0, 2), iso(T0)],
        [addDays(D0, 2), addDays(D0, 4), iso(T0 + 2 * DAY)],
        [addDays(D0, 4), addDays(D0, 6), iso(T0 + 4 * DAY)],
        [addDays(D0, 6), addDays(D0, 8), iso(T0 + 6 * DAY)],
        [addDays(D0, 8), addDays(D0, 10), iso(T0 + 8 * DAY)],
        [addDays(D0, 10), addDays(D0, 12), iso(T0 + 10 * DAY)],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.25 ** 7, 1);
      // Three raises on one night by one rule: MAYA asks, and carries on
      // until the owner answers.
      expect((w.tables.rule_repeat_alert_nights ?? []).map((n) => [n.rule_id, n.stay_date])).toEqual([
        ["Hot-week surge", NIGHT],
      ]);
    }, 120_000);

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
        // Every later one only the days since the one before, from that
        // raise's own day on: the four that came in that day were there
        // before the raise, so its split leaves them out.
        [D0, addDays(D0, 3), 12],
        [addDays(D0, 3), addDays(D0, 6), 12],
        // Twelve new ones, and the one a night like it gets 33 days out.
        [addDays(D0, 6), addDays(D0, 9), 13],
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
      // Its window starts on day 0, split at the first raise: the four from
      // that morning are the first raise's and don't keep the second on.
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

    it("cuts again after its wait when nothing came in since the first cut, reading complete days only", async () => {
      const w = world(engine, { rules: slow(), reservations: history(), last: LAST });
      await w.run(0);
      expect(w.price(NIGHT)).toBe(90);
      await w.run(6);
      expect(w.fires(NIGHT)).toHaveLength(1);
      await w.run(7);
      // A cut rule's month ends the day before the run (the booking made 50
      // days out is its one), and after its cut it counts the complete days
      // after the cut's day: days 1 to 6.
      expect(w.fires(NIGHT).map((e) => [e.fire_seq, e.window_from, e.window_to, e.window_bookings_at_fire, e.window_expected_at_fire])).toEqual([
        [1, addDays(D0, -30), addDays(D0, -1), 1, 29],
        [2, addDays(D0, 1), addDays(D0, 6), 0, 6],
      ]);
      expect(w.price(NIGHT)).toBe(81);
    }, 120_000);

    it("with a day's wait, cuts again only once complete days after the cut's day read slow", async () => {
      // A day after the cut there is no complete day since it to judge, and
      // the day after only one (none against the one a night like it gets:
      // too few to call). Three complete days of nothing are slow.
      const quick = rule(
        "r-slow",
        { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 1 },
        { action_direction: "decrease" },
      );
      const w = world(engine, { rules: [quick], reservations: history(), last: LAST });
      for (let day = 0; day <= 4; day++) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([
        ["r-slow", 0],
        ["r-slow", 4],
      ]);
      expect(w.fires(NIGHT)[1]).toMatchObject({ window_from: addDays(D0, 1), window_to: addDays(D0, 3), window_bookings_at_fire: 0, window_expected_at_fire: 3 });
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

  /* ── Raises and cuts never move each other's count ──────────── */

  describe("raises and cuts never move where the other counts from", () => {
    // Nights like it book a room every day from 49 days out to arrival.
    const NIGHT = addDays(D0, 20);
    const LAST = addDays(D0, 21);
    const DAILY = Array.from({ length: 50 }, (_, i) => i);
    const slow = () =>
      rule("r-slow", { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 7 }, {
        action_direction: "decrease",
      });
    /** Everything but NIGHT books as usual; NIGHT stopped booking 50 days out. */
    const history = () => [
      ...background(LAST, DAILY).filter((r) => r.stay_date !== NIGHT),
      ...[50, 51, 52].map((lead) => booking(NIGHT, addDays(NIGHT, -lead))),
    ];

    it("a raise on the night doesn't move where the cut rule starts counting", async () => {
      const spike = starterRules().filter((r) => r.name === "Sudden-spike catcher");
      const w = world(engine, { rules: [slow(), ...spike], reservations: history(), last: LAST });
      await w.run(0);
      expect(w.firedOn(NIGHT)).toEqual([["r-slow", 0]]);
      // Six rooms in one day on day 2: the spike rule raises on top of the cut.
      for (let k = 0; k < 6; k++) w.tables.reservations.push(booking(NIGHT, addDays(D0, 2)));
      for (let day = 1; day <= 8; day++) await w.run(day);
      // The cut rule's wait is over on day 7. It counts the complete days
      // after its own cut's day, 1 to 6: six rooms against the six a night
      // like it gets, the usual pace, so no second cut. Counting from the
      // raise instead would read nothing in four days and cut a night that
      // just took six rooms.
      expect(w.firedOn(NIGHT)).toEqual([
        ["r-slow", 0],
        ["Sudden-spike catcher", 2],
      ]);
      expect(w.price(NIGHT)).toBe(112.5);
    }, 120_000);

    it("a cut on the night doesn't move where a raise rule starts counting", async () => {
      const warm = starterRules().filter((r) => r.name === "Warm-date bump");
      const w = world(engine, { rules: [slow(), ...warm], reservations: history(), last: LAST });
      await w.run(0);
      expect(w.firedOn(NIGHT)).toEqual([["r-slow", 0]]);
      // Twenty rooms land on day 1. Over its whole month the night is still
      // behind (20 against the usual 30), so the month rule leaves it.
      // Counting from the cut instead would read twenty in a day and raise.
      for (let k = 0; k < 20; k++) w.tables.reservations.push(booking(NIGHT, addDays(D0, 1)));
      for (let day = 1; day <= 7; day++) await w.run(day);
      expect(w.firedOn(NIGHT)).toEqual([["r-slow", 0]]);
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
      // waits its 3 days from then: until day 4 begins.
      const setAt = iso(T0 + DAY + HOUR);
      w.tables.manual_price.push({ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: setAt, cleared_at: null });
      await w.run(1, 2 * HOUR);
      expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual(["manual_price"]);
      expect(w.price(NIGHT)).toBe(150);
      await w.run(3, 11 * HOUR);
      expect(w.fires(NIGHT)).toHaveLength(1);

      // Wait over: the whole month again, wedding included, as decided for
      // typed prices. It raises on top of the typed price.
      await w.run(4, -11 * HOUR);
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
