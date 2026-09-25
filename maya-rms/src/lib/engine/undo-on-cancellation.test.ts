/**
 * The owner's box on every rule, "Undo this change if cancellations mean the
 * rule is no longer true" (Jake, 2026-09-25): ticked by default, the same
 * for a raise and a cut and for every kind of rule. Ticked, a change comes
 * off once cancellations make its rule no longer true, judged on what the
 * change counted (its stored window, less what has cancelled since, against
 * the usual frozen at the change) and on the night's occupancy now.
 * Unticked, cancellations never take it off. After an undo the rule's wait
 * still runs from the change that came off; a change that came off covers
 * no weaker rule and no longer counts toward the three-changes alert.
 *
 * Every case runs whole evaluateHotel runs on the app's engine and on the
 * edge functions' copy, ticked and unticked, against the in-memory fake. A
 * booking reaches the reservations table at its created_at, and a
 * cancellation deletes its row, the way the syncs do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, daysBetween } from "@/lib/observations/calendar";
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
 * Nights like NIGHT book 2 a day at every lead from 50 to 30 days out, so
 * over one day "much faster" first reads at 5 bookings and "surging" at 7
 * (booking-speed-cumulative.test.ts). NIGHT itself has its 20 from 50 to 41
 * days out and none from 40 on: 50% of 40 rooms before the story starts.
 */
function paced(): FakeRow[] {
  const out: FakeRow[] = [];
  for (let stay = addDays(D0, -400); stay <= LAST; stay = addDays(stay, 1)) {
    for (let lead = 30; lead <= 50; lead++) {
      if (stay === NIGHT && lead <= 40) continue;
      const on = addDays(stay, -lead);
      for (let k = 0; k < 2; k++) out.push(booking(stay, on, `${on}T03:00:00.000Z`));
    }
  }
  return out;
}

/** NIGHT alone with `n` rooms booked long ago, 60 days out and more: no pickup in the story's days. */
function settled(n: number): FakeRow[] {
  return Array.from({ length: n }, (_, i) => {
    const on = addDays(NIGHT, -(60 + i));
    return booking(NIGHT, on, `${on}T09:00:00.000Z`);
  });
}

/**
 * A hotel whose bookings reach MAYA at their created_at. `runAt` puts every
 * booking first seen by then on the books and runs the engine at that
 * instant, pricing through LAST; `cancel` deletes rows, as a cancellation
 * does. `snapshotDays` writes 6-hourly snapshots over that many days before
 * D0 for a pickup count to open on.
 */
function timeline(engine: Engine, o: { rules: FakeRow[]; rows: FakeRow[]; rooms?: number; snapshotDays?: number }) {
  const nights: string[] = [];
  for (let d = D0; d <= LAST; d = addDays(d, 1)) nights.push(d);
  const rooms = o.rooms ?? 40;
  const seeded: FakeRow[] = [];
  for (let h = (o.snapshotDays ?? 0) * 24; h > 0; h -= 6) {
    const ts = T00 - h * HOUR;
    for (const stay of nights) {
      const seen = o.rows.filter((r) => r.stay_date === stay && Date.parse(String(r.created_at)) <= ts);
      seeded.push({ hotel_id: "h1", snapshot_ts: iso(ts), stay_date: stay, room_type_id: STD, sellable_units: rooms, booked_units: seen.length, booked_revenue: seen.length * 100 });
    }
  }
  const fake = fakeSupabase({
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: [{ id: STD, hotel_id: "h1", name: "Standard", is_active: true, total_rooms: rooms, floor_price: 10, ceiling_price: 99999, counts_as_room: true }],
    reservations: [],
    base_rate_calendar: nights.map((stay) => ({ hotel_id: "h1", stay_date: stay, room_type_id: STD, price: 100 })),
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
  /** Delete these rows from the books, as their cancellation does. */
  const cancel = (rows: FakeRow[]) => {
    const gone = new Set(rows.map((r) => r.id));
    fake.tables.reservations = fake.tables.reservations.filter((r) => !gone.has(r.id));
  };
  const fires = () =>
    fake.tables.pickup_event
      .filter((e) => e.stay_date === NIGHT)
      .sort((a, b) => String(a.applied_at).localeCompare(String(b.applied_at)));
  /** [rule, when, why it came off] per change on NIGHT. */
  const story = () => fires().map((e) => [e.rule_id, iso(Date.parse(String(e.applied_at))), e.retired_reason ?? null]);
  const price = () =>
    Math.round(Number(fake.tables.published_price.find((p) => p.stay_date === NIGHT && p.room_type_id === STD)?.price) * 100) / 100;
  return { ...fake, runAt, cancel, fires, story, price };
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

const BOXES = [
  { box: "ticked", undo: true },
  { box: "unticked", undo: false },
];

describe.each(ENGINES)("$name: the undo box", (engine) => {
  describe("a booking speed raise (much faster in a day, +10%)", () => {
    const five = (undo: boolean) =>
      rule(
        "Quick pickup",
        { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
        { undo_on_cancellation: undo },
      );

    it.each(BOXES)("$box: two of the five cancel the same day", async ({ undo }) => {
      const five_ = burst(5, at(0, 10));
      const w = timeline(engine, { rules: [five(undo)], rows: [...paced(), ...five_] });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      w.cancel(five_.slice(0, 2));
      await w.runAt(at(0, 11, 5));
      // Three left in its day no longer read "much faster".
      expect(w.price()).toBe(undo ? 100 : 110);
      expect(w.story()).toEqual([["Quick pickup", iso(at(0, 10, 5)), undo ? "bookings_cancelled" : null]]);
      // The audit row says why it came off.
      const off = w.tables.evaluation_audit
        .filter((a) => a.stay_date === NIGHT && a.evaluated_at === iso(at(0, 11, 5)))
        .flatMap((a) => ((a.details as { retired_pickup_effects?: FakeRow[] }).retired_pickup_effects ?? []).map((e) => e.reason));
      expect(off).toEqual(undo ? ["bookings_cancelled"] : []);
    }, 120_000);

    it.each(BOXES)("$box: cancellations a long time later: only the change's own window is recounted", async ({ undo }) => {
      const five_ = burst(5, at(0, 10));
      const bg = paced();
      const w = timeline(engine, { rules: [five(undo)], rows: [...bg, ...five_] });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      // Ten days on, three bookings made before its window cancel: the five
      // it counted are all still there.
      w.cancel(bg.filter((r) => r.stay_date === NIGHT).slice(0, 3));
      await w.runAt(at(10, 10, 5));
      expect(w.price()).toBe(110);
      // Twelve days on, one of the five cancels: four no longer read "much faster".
      w.cancel(w.tables.reservations.filter((r) => five_.some((f) => f.id === r.id)).slice(0, 1));
      await w.runAt(at(12, 10, 5));
      expect(w.price()).toBe(undo ? 100 : 110);
    }, 120_000);
  });

  describe("a pickup count raise (more than 4 room nights in 3 days, +10%, waits a day)", () => {
    const quick = (undo: boolean) =>
      rule(
        "Quick pickup",
        { pickup_operator: "gt", pickup_threshold: 4, pickup_window_days: 3, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
        { undo_on_cancellation: undo },
      );

    it.each(BOXES)("$box: cancellations take it to its threshold; after its wait, true again, it raises again", async ({ undo }) => {
      const first = burst(5, at(0, 10));
      const later = burst(3, at(0, 12));
      const w = timeline(engine, { rules: [quick(undo)], rows: [...settled(10), ...first, ...later], snapshotDays: 4 });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      w.cancel(first.slice(0, 2));
      await w.runAt(at(0, 11, 5));
      // Net 3 of the five it counted: not more than 4.
      expect(w.price()).toBe(undo ? 100 : 110);
      // Three more come in. Its wait runs from the change that came off, so
      // not yet, though the three days now hold six.
      await w.runAt(at(0, 12, 5));
      expect(w.price()).toBe(undo ? 100 : 110);
      // A day on, its wait is over. Ticked, nothing is on the night, so it
      // counts its whole three days: six, and it raises again. Unticked, it
      // counts from its own change still on the price: one.
      await w.runAt(at(1, 10, 5));
      expect(w.price()).toBe(110);
      expect(w.story()).toEqual(
        undo
          ? [
              ["Quick pickup", iso(at(0, 10, 5)), "bookings_cancelled"],
              ["Quick pickup", iso(at(1, 10, 5)), null],
            ]
          : [["Quick pickup", iso(at(0, 10, 5)), null]],
      );
      expect(w.fires().map((e) => e.pickup_units_arrived_at_fire)).toEqual(undo ? [5, 6] : [5]);
    }, 120_000);

    it("an older booking cancelling doesn't touch the count", async () => {
      const first = burst(5, at(0, 10));
      const old = settled(10);
      const w = timeline(engine, { rules: [quick(true)], rows: [...old, ...first], snapshotDays: 4 });
      await w.runAt(at(0, 10, 5));
      w.cancel(old.slice(0, 3));
      await w.runAt(at(0, 11, 5));
      expect(w.price()).toBe(110);
      expect(w.story()).toEqual([["Quick pickup", iso(at(0, 10, 5)), null]]);
    }, 120_000);
  });

  describe("an occupancy rule (more than 50%, +10%), which holds while it is true", () => {
    const busy = (undo: boolean, extra: FakeRow = {}) =>
      rule("Busy night", { occupancy_operator: "gt", occupancy_threshold: 0.5, ...extra }, { is_pickup_rule: false, undo_on_cancellation: undo });

    it.each(BOXES)("$box: cancellations take the night under its bar, then new bookings bring it back", async ({ undo }) => {
      const two = burst(2, at(0, 10));
      const four = burst(4, at(0, 12));
      const old = settled(20);
      const w = timeline(engine, { rules: [busy(undo)], rows: [...old, ...two, ...four] });
      await w.runAt(at(0, 10, 5));
      // 22 of 40.
      expect(w.price()).toBe(110);
      w.cancel([...two, old[0]]);
      await w.runAt(at(0, 11, 5));
      // 19 of 40.
      expect(w.price()).toBe(undo ? 100 : 110);
      await w.runAt(at(0, 12, 5));
      // 23 of 40: true again, and with no wait it is back on at once.
      expect(w.price()).toBe(110);
    }, 120_000);

    it("unticked, a days-before-arrival condition still runs out with time", async () => {
      const two = burst(2, at(0, 10));
      const old = settled(20);
      const w = timeline(engine, { rules: [busy(false, { dta_operator: "gt", dta_threshold_days: 39 })], rows: [...old, ...two] });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      w.cancel([...two, old[0]]);
      await w.runAt(at(0, 11, 5));
      expect(w.price()).toBe(110);
      // 39 days out is not more than 39.
      await w.runAt(at(1, 10, 5));
      expect(w.price()).toBe(100);
    }, 120_000);

    it.each(BOXES)("$box: a cut on occupancy less than 30% only gets truer as bookings cancel, and new bookings end it", async ({ undo }) => {
      const quiet = rule(
        "Quiet night",
        { occupancy_operator: "lt", occupancy_threshold: 0.3 },
        { is_pickup_rule: false, action_direction: "decrease", undo_on_cancellation: undo },
      );
      const old = settled(10);
      const w = timeline(engine, { rules: [quiet], rows: [...old, ...burst(4, at(0, 12))] });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(90);
      w.cancel(old.slice(0, 2));
      await w.runAt(at(0, 11, 5));
      expect(w.price()).toBe(90);
      // 12 of 40 is not under 30%.
      await w.runAt(at(0, 12, 5));
      expect(w.price()).toBe(100);
    }, 120_000);
  });

  describe("a cut works the same way (pickup less than 1 in 3 days and occupancy more than 45%, -10%)", () => {
    it.each(BOXES)("$box: cancellations take occupancy under its bar", async ({ undo }) => {
      const stale = rule(
        "Stale but busy",
        { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights", occupancy_operator: "gt", occupancy_threshold: 0.45 },
        { action_direction: "decrease", undo_on_cancellation: undo },
      );
      const old = settled(20);
      const w = timeline(engine, { rules: [stale], rows: old, snapshotDays: 4 });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(90);
      w.cancel(old.slice(0, 3));
      await w.runAt(at(0, 11, 5));
      // 17 of 40 is not more than 45%. Pickup fell too, which only keeps "less than 1" true.
      expect(w.price()).toBe(undo ? 100 : 90);
      expect(w.story()).toEqual([["Stale but busy", iso(at(0, 10, 5)), undo ? "bookings_cancelled" : null]]);
    }, 120_000);
  });

  describe("booking speed and occupancy together (much faster in a day and occupancy more than 60%)", () => {
    it.each(BOXES)("$box: a cancellation that takes occupancy to the bar undoes it while the pace still holds", async ({ undo }) => {
      const both = rule(
        "Fast and full",
        {
          booking_speed_operator: "at_least",
          booking_speed_level: "much_faster",
          booking_speed_window_days: 1,
          booking_speed_cooldown_days: 1,
          occupancy_operator: "gt",
          occupancy_threshold: 0.6,
        },
        { undo_on_cancellation: undo },
      );
      const five = burst(5, at(0, 10));
      const w = timeline(engine, { rules: [both], rows: [...paced(), ...five] });
      await w.runAt(at(0, 10, 5));
      // 25 of 40 and five in a day.
      expect(w.price()).toBe(110);
      // One booking made before its window cancels: still five in the day, but 24 of 40 is not more than 60%.
      const older = w.tables.reservations.find((r) => r.stay_date === NIGHT && !five.some((f) => f.id === r.id))!;
      w.cancel([older]);
      await w.runAt(at(0, 11, 5));
      expect(w.price()).toBe(undo ? 100 : 110);
    }, 120_000);
  });

  describe("a stronger rule's change that came off covers nothing (the owner's rules for 5 and for 10 in a day)", () => {
    const rules = (undo: boolean) => [
      rule(
        "Five in a day",
        { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
        { priority: 100, action_value: 10, undo_on_cancellation: undo },
      ),
      rule(
        "Stronger tier",
        { booking_speed_operator: "at_least", booking_speed_level: "surging", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
        { priority: 120, action_value: 20, undo_on_cancellation: undo },
      ),
    ];

    it.each(BOXES)("$box: 10 at once raise the stronger rule; 4 cancel, and the 6 left are the first rule's", async ({ undo }) => {
      const ten = burst(10, at(0, 10));
      const w = timeline(engine, { rules: rules(undo), rows: [...paced(), ...ten] });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(120);
      w.cancel(ten.slice(0, 4));
      await w.runAt(at(0, 11, 5));
      // Ticked: six no longer read "surging", so its 20% comes off. Nothing
      // on the price covers them any more, and six read "much faster": the
      // first rule raises on them in the same run. Unticked: the stronger
      // change stays and still covers them.
      expect(w.price()).toBe(undo ? 110 : 120);
      expect(w.story()).toEqual(
        undo
          ? [
              ["Stronger tier", iso(at(0, 10, 5)), "bookings_cancelled"],
              ["Five in a day", iso(at(0, 11, 5)), null],
            ]
          : [["Stronger tier", iso(at(0, 10, 5)), null]],
      );
    }, 120_000);

    it("ticked, 6 of the 10 cancel: neither rule is true, and the night goes back to its base", async () => {
      const ten = burst(10, at(0, 10));
      const w = timeline(engine, { rules: rules(true), rows: [...paced(), ...ten] });
      await w.runAt(at(0, 10, 5));
      w.cancel(ten.slice(0, 6));
      await w.runAt(at(0, 11, 5));
      expect(w.price()).toBe(100);
      expect(w.story()).toEqual([["Stronger tier", iso(at(0, 10, 5)), "bookings_cancelled"]]);
    }, 120_000);
  });

  describe("the three-changes alert counts changes still on the price", () => {
    it.each(BOXES)("$box: three raises file the night; the third coming off takes it back under three", async ({ undo }) => {
      const quick = rule(
        "Quick pickup",
        { pickup_operator: "gt", pickup_threshold: 2, pickup_window_days: 1, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
        { undo_on_cancellation: undo },
      );
      const days = [0, 1, 2].map((d) => burst(3, at(d, 10)));
      const w = timeline(engine, { rules: [quick], rows: [...settled(5), ...days.flat()], snapshotDays: 2 });
      for (const d of [0, 1, 2]) await w.runAt(at(d, 10, 5));
      expect(w.price()).toBeCloseTo(133.1, 2);
      const nights = () => (w.tables.rule_repeat_alert_nights ?? []).filter((n) => n.stay_date === NIGHT);
      expect(nights().map((n) => [n.fire_count, n.closed_reason ?? null])).toEqual([[3, null]]);
      // Two of the third day's three cancel: it counted 3, now 1.
      w.cancel(days[2].slice(0, 2));
      await w.runAt(at(2, 11, 5));
      expect(w.price()).toBeCloseTo(undo ? 121 : 133.1, 2);
      expect(nights().map((n) => [n.fire_count, n.closed_reason ?? null])).toEqual(undo ? [[3, "bookings_cancelled"]] : [[3, null]]);
    }, 120_000);
  });
});
