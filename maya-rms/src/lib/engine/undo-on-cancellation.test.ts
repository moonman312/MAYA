/**
 * The owner's box on every rule, "Undo this change if cancellations mean the
 * rule is no longer true" (Jake, 2026-09-25): ticked by default, the same
 * for a raise and a cut and for every kind of rule. Ticked, a change comes
 * off once cancellations make its rule no longer true, judged on what the
 * change counted (its stored window, less what has cancelled since, against
 * the usual frozen at the change) and on the night's occupancy now.
 * A change whose own count cancellations took short still stays while its
 * rule is true counted the way it would count without it (bookings made
 * since included): the condition that led to it is still met, and its
 * numbers are taken again from that count.
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
import { buildExplainView, humanDate } from "@/lib/explain";

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
/** One booking of one room, first seen at `firstSeen` (with `pmsId`, one room of that PMS reservation). */
function booking(stay: string, bookedOn: string, firstSeen: number | string, pmsId?: string): FakeRow {
  resId++;
  return {
    id: `f0000000-0000-4000-8000-${String(resId).padStart(12, "0")}`,
    hotel_id: "h1",
    external_reservation_id: pmsId ?? `${700000000 + resId}`,
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
 * Nights like NIGHT book one booking at every third lead from 30 to 90 days
 * out, and one more at 43 days out on every third night, so over a week
 * "much faster" first reads at 5 bookings and "surging" at 8. NIGHT itself
 * has none of its own from 50 days out.
 */
function weekly(): FakeRow[] {
  const out: FakeRow[] = [];
  for (let stay = addDays(D0, -400); stay <= LAST; stay = addDays(stay, 1)) {
    for (let lead = 30; lead <= 90; lead += 3) {
      if (stay === NIGHT && lead <= 50) continue;
      const on = addDays(stay, -lead);
      out.push(booking(stay, on, `${on}T03:00:00.000Z`));
    }
    if (stay !== NIGHT && ((daysBetween(D0, stay) % 3) + 3) % 3 === 0) {
      const on = addDays(stay, -43);
      out.push(booking(stay, on, `${on}T03:00:00.000Z`));
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
  /** Edit a rule's condition, and with `over` anything else, as updateRule does: a new version. */
  const edit = (id: string, condition: FakeRow, over: FakeRow = {}) => {
    const r = fake.tables.pricing_rules.find((x) => x.id === id)!;
    Object.assign(r, over);
    r.version = Number(r.version) + 1;
    r.rule_condition = [condition];
  };
  const fires = () =>
    fake.tables.pickup_event
      .filter((e) => e.stay_date === NIGHT)
      .sort((a, b) => String(a.applied_at).localeCompare(String(b.applied_at)));
  /** [rule, when, why it came off] per change on NIGHT. */
  const story = () => fires().map((e) => [e.rule_id, iso(Date.parse(String(e.applied_at))), e.retired_reason ?? null]);
  const price = () =>
    Math.round(Number(fake.tables.published_price.find((p) => p.stay_date === NIGHT && p.room_type_id === STD)?.price) * 100) / 100;
  return { ...fake, runAt, cancel, edit, fires, story, price };
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

/** More than 9 room nights in 7 days, +20%, waiting `wait` days (its week when null). */
const ten = (wait: number | null) =>
  rule(
    "Ten",
    { pickup_operator: "gt", pickup_threshold: 9, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: wait },
    { action_value: 20 },
  );
/** More than 4 room nights in 7 days, +10%. */
const five = rule(
  "Five",
  { pickup_operator: "gt", pickup_threshold: 4, pickup_window_days: 7, pickup_metric: "room_nights", pickup_cooldown_days: null },
  { action_value: 10 },
);
/** The same two as booking speed over a week (weekly(): "much faster" from 5, "surging" from 8). */
const weekFive = rule(
  "Five",
  { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 7, booking_speed_cooldown_days: 7 },
  { action_value: 10 },
);
const weekTen = rule(
  "Ten",
  { booking_speed_operator: "at_least", booking_speed_level: "surging", booking_speed_window_days: 7, booking_speed_cooldown_days: 7 },
  { action_value: 20 },
);

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
      // The audit row says why it came off, and what it found: of the 5 it
      // counted, 3 are still booked, against the usual frozen at the raise.
      const off = w.tables.evaluation_audit
        .filter((a) => a.stay_date === NIGHT && a.evaluated_at === iso(at(0, 11, 5)))
        .flatMap((a) => (a.details as { retired_pickup_effects?: FakeRow[] }).retired_pickup_effects ?? []);
      expect(off.map((e) => e.reason)).toEqual(undo ? ["bookings_cancelled"] : []);
      const fire = w.fires()[0];
      if (undo) {
        expect(off[0].finding).toEqual({
          part: "booking_speed",
          left: 3,
          counted: 5,
          expected: Number(fire.window_expected_at_fire),
          level: "much_faster",
        });
      }
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

    it.each(BOXES)("$box: an edit is judged whole: on at 60%, edited to more than 80%, it comes off", async ({ undo }) => {
      const w = timeline(engine, { rules: [busy(undo)], rows: settled(24) });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      w.edit("Busy night", { occupancy_operator: "gt", occupancy_threshold: 0.8 });
      await w.runAt(at(0, 11, 5));
      expect(w.price()).toBe(100);
    }, 120_000);

    it.each(BOXES)("$box: an edit it still meets makes the change the edited rule's, its adjustment included", async ({ undo }) => {
      const w = timeline(engine, { rules: [busy(undo)], rows: settled(24) });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      w.edit("Busy night", { occupancy_operator: "gt", occupancy_threshold: 0.5 }, { action_value: 20 });
      await w.runAt(at(0, 11, 5));
      expect(w.price()).toBe(120);
    }, 120_000);

    it("unticked: a days-before-arrival rule edited to need occupancy more than 80% comes off at 60%", async () => {
      const closeIn = rule("Close in", { dta_operator: "lt", dta_threshold_days: 60 }, { is_pickup_rule: false, undo_on_cancellation: false });
      const w = timeline(engine, { rules: [closeIn], rows: settled(24) });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      w.edit("Close in", { dta_operator: "lt", dta_threshold_days: 60, occupancy_operator: "gt", occupancy_threshold: 0.8 });
      await w.runAt(at(0, 11, 5));
      expect(w.price()).toBe(100);
    }, 120_000);

    it("unticked: an edit it still meets keeps the change, and cancellations after it still don't take it off", async () => {
      const old = settled(24);
      const w = timeline(engine, { rules: [busy(false)], rows: old });
      await w.runAt(at(0, 10, 5));
      w.edit("Busy night", { occupancy_operator: "gt", occupancy_threshold: 0.55 });
      await w.runAt(at(0, 11, 5));
      // 60% is more than 55%.
      expect(w.price()).toBe(110);
      w.cancel(old.slice(0, 4));
      await w.runAt(at(0, 12, 5));
      // 50% after cancellations: unticked, it stays.
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

  describe("a change stays while bookings made since keep its rule true", () => {
    // More than 9 room nights in 7 days, +20%: 10 at once, 3 more the next
    // day, then one of the 10 cancels. The 9 left of what it counted are not
    // more than 9, but with the 3 since there are 12 in its week: the
    // condition that led to it is still met.
    it.each([
      { wait: "its week", days: null },
      { wait: "a day", days: 1 },
    ])("pickup, waiting $wait: the raise stays, once, and only its check's numbers are taken again", async ({ days }) => {
      const tenAtOnce = burst(10, at(0, 10));
      const w = timeline(engine, { rules: [ten(days)], rows: [...settled(5), ...tenAtOnce, ...burst(3, at(1, 10))], snapshotDays: 8 });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(120);
      await w.runAt(at(1, 10, 5));
      w.cancel(tenAtOnce.slice(0, 1));
      await w.runAt(at(2, 10, 5));
      expect(w.price()).toBe(120);
      await w.runAt(at(3, 10, 5));
      expect(w.price()).toBe(120);
      // Neither taken off nor made again.
      expect(w.story()).toEqual([["Ten", iso(at(0, 10, 5)), null]]);
      const [fire] = w.fires();
      expect(fire.fire_seq).toBe(1);
      // Its check now recounts the 12 in its week, counted at the run that
      // kept it. What it counted when it was made stays as it was.
      const checked = fire.checked_count as FakeRow;
      expect([fire.checked_at, checked.signal_booked_units_end, checked.pickup_units_arrived_at_fire]).toEqual([
        iso(at(2, 10, 5)),
        17,
        12,
      ]);
      expect([fire.applied_at, fire.baseline_end_ts, fire.signal_booked_units_end, fire.pickup_units_arrived_at_fire]).toEqual([
        iso(at(0, 10, 5)),
        iso(at(0, 10, 5)),
        15,
        10,
      ]);
    }, 120_000);

    it("pickup, with the rule for 5 as well: still 120, the 3 since the raise not being enough for it", async () => {
      const tenAtOnce = burst(10, at(0, 10));
      const w = timeline(engine, { rules: [five, ten(null)], rows: [...settled(5), ...tenAtOnce, ...burst(3, at(1, 10))], snapshotDays: 8 });
      await w.runAt(at(0, 10, 5));
      await w.runAt(at(1, 10, 5));
      w.cancel(tenAtOnce.slice(0, 1));
      for (const d of [2, 3, 8]) {
        await w.runAt(at(d, 10, 5));
        expect(w.price()).toBe(120);
      }
      expect(w.story()).toEqual([["Ten", iso(at(0, 10, 5)), null]]);
    }, 120_000);

    it("booking speed (the owner's rules for 5 and for 10 in a day): 10, 3 more, then 4 of the 10 cancel: 9 in the day still surge", async () => {
      const rules = [
        rule(
          "Five in a day",
          { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
          { priority: 100, action_value: 10 },
        ),
        rule(
          "Stronger tier",
          { booking_speed_operator: "at_least", booking_speed_level: "surging", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
          { priority: 120, action_value: 20 },
        ),
      ];
      const tenAtOnce = burst(10, at(0, 10));
      const w = timeline(engine, { rules, rows: [...paced(), ...tenAtOnce, ...burst(3, at(0, 11))] });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(120);
      await w.runAt(at(0, 11, 5));
      w.cancel(tenAtOnce.slice(0, 4));
      await w.runAt(at(0, 11, 35));
      expect(w.price()).toBe(120);
      expect(w.story()).toEqual([["Stronger tier", iso(at(0, 10, 5)), null]]);
      const [fire] = w.fires();
      expect([fire.window_bookings_at_fire, (fire.checked_count as FakeRow).window_bookings_at_fire]).toEqual([10, 9]);
    }, 120_000);

    it.each([
      { k: 1, price: 120, story: [["Ten", 0, null]] },
      { k: 4, price: 120, story: [["Ten", 0, null]] },
      { k: 6, price: 110, story: [["Ten", 0, "bookings_cancelled"], ["Five", 2, null]] },
    ])(
      "booking speed in a week (the rules for 5 and for 10): 10, 3 more the next day, then $k of the 10 cancel",
      async ({ k, price, story }) => {
        const tenAtOnce = burst(10, at(0, 10));
        const w = timeline(engine, { rules: [weekFive, weekTen], rows: [...weekly(), ...tenAtOnce, ...burst(3, at(1, 10))] });
        await w.runAt(at(0, 10, 5));
        expect(w.price()).toBe(120);
        await w.runAt(at(1, 10, 5));
        expect(w.price()).toBe(120);
        w.cancel(tenAtOnce.slice(0, k));
        await w.runAt(at(2, 10, 5));
        expect(w.price()).toBe(price);
        // Never an undo and a raise again in the one run.
        expect(w.story()).toEqual(story.map(([id, day, why]) => [id, iso(at(Number(day), 10, 5)), why]));
      },
      120_000,
    );
  });

  describe("counting starts again only when a price changes (Jake, 2026-09-27)", () => {
    // Rules for 10 bookings in a week (+20%) and for 5 (+10%), both ticked.
    // Monday 10 bookings: the rule for 10 raises to $120. Tuesday 3 more.
    // Wednesday one of Monday's cancels: the rule for 10 still has 12 in its
    // week, so its raise stays. Thursday 2 more: the rule for 5 counts the
    // 3 + 2 since Monday's raise and raises to $132.
    const monToThu = async (w: ReturnType<typeof timeline>, cancelled: FakeRow[]) => {
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(120);
      await w.runAt(at(1, 10, 5));
      expect(w.price()).toBe(120);
      w.cancel(cancelled);
      await w.runAt(at(2, 10, 5));
      expect(w.price()).toBe(120);
      await w.runAt(at(3, 10, 5));
      expect(w.price()).toBe(132);
    };

    it.each([
      { cancels: "one of Monday's cancels on Wednesday", k: 1 },
      { cancels: "no cancellation", k: 0 },
    ])("pickup rules, $cancels: the rule for 5 raises on Thursday", async ({ k }) => {
      const monday = burst(10, at(0, 10));
      const w = timeline(engine, {
        rules: [five, ten(null)],
        rows: [...settled(5), ...monday, ...burst(3, at(1, 10)), ...burst(2, at(3, 10))],
        snapshotDays: 8,
      });
      await monToThu(w, monday.slice(0, k));
      expect(w.story()).toEqual([
        ["Ten", iso(at(0, 10, 5)), null],
        ["Five", iso(at(3, 10, 5)), null],
      ]);
      // It counted the 5 that arrived since Monday's raise, still booked.
      const [, fiveFire] = w.fires();
      expect([fiveFire.baseline_start_ts, fiveFire.pickup_units_arrived_at_fire]).toEqual([iso(at(0, 10, 5)), 5]);
      expect(Number(fiveFire.signal_booked_units_end) - Number(fiveFire.signal_booked_units_start)).toBe(5);
      if (k > 0) expect(w.fires()[0].checked_at).toBe(iso(at(2, 10, 5)));
      else expect(w.fires()[0].checked_at ?? null).toBeNull();
    }, 120_000);

    it.each([
      { cancels: "one of Monday's cancels on Wednesday", k: 1 },
      { cancels: "four of Monday's cancel on Wednesday, the week still surging with Tuesday's", k: 4 },
      { cancels: "no cancellation", k: 0 },
    ])("booking speed rules in a week, $cancels: the rule for 5 raises on Thursday", async ({ k }) => {
      const monday = burst(10, at(0, 10));
      const w = timeline(engine, {
        rules: [weekFive, weekTen],
        rows: [...weekly(), ...monday, ...burst(3, at(1, 10)), ...burst(2, at(3, 10))],
      });
      await monToThu(w, monday.slice(0, k));
      expect(w.story()).toEqual([
        ["Ten", iso(at(0, 10, 5)), null],
        ["Five", iso(at(3, 10, 5)), null],
      ]);
      // It counted from Monday's raise, not from when the raise was checked,
      // and the drill-down behind Thursday's raise names Monday.
      expect(w.fires()[1].window_since).toBe(iso(at(0, 10, 5)));
      expect(w.fires()[1].window_bookings_at_fire).toBe(5);
      const thursday = w.tables.evaluation_audit.find((a) => a.stay_date === NIGHT && a.evaluated_at === iso(at(3, 10, 5)));
      const reading = (thursday?.details as { booking_speed_observations?: unknown[] } | undefined)?.booking_speed_observations?.[0];
      expect(buildExplainView(reading)?.observed).toContain(`was made on ${humanDate(D0)}.`);
    }, 120_000);
  });

  describe("a change kept on bookings made since doesn't come off once its window moves past them", () => {
    it("pickup: kept on Wednesday, still on a week later, and after one of Tuesday's cancels too", async () => {
      const monday = burst(10, at(0, 10));
      const tuesday = burst(3, at(1, 10));
      const w = timeline(engine, { rules: [ten(null)], rows: [...settled(5), ...monday, ...tuesday], snapshotDays: 8 });
      await w.runAt(at(0, 10, 5));
      await w.runAt(at(1, 10, 5));
      w.cancel(monday.slice(0, 1));
      await w.runAt(at(2, 10, 5));
      expect(w.fires()[0].checked_at).toBe(iso(at(2, 10, 5)));
      // Its week now starts after Monday, and nothing has come in since.
      for (const d of [8, 9]) {
        await w.runAt(at(d, 10, 5));
        expect(w.price()).toBe(120);
      }
      // 11 of the 12 it now stands for are still booked: still more than 9.
      w.cancel(tuesday.slice(0, 1));
      await w.runAt(at(10, 10, 5));
      expect(w.price()).toBe(120);
      expect(w.story()).toEqual([["Ten", iso(at(0, 10, 5)), null]]);
    }, 120_000);

    it("booking speed: kept on Wednesday with 6 of Monday's 10 and Tuesday's 3, still on a week later", async () => {
      const monday = burst(10, at(0, 10));
      const w = timeline(engine, { rules: [weekTen], rows: [...weekly(), ...monday, ...burst(3, at(1, 10))] });
      await w.runAt(at(0, 10, 5));
      await w.runAt(at(1, 10, 5));
      w.cancel(monday.slice(0, 4));
      await w.runAt(at(2, 10, 5));
      expect(w.price()).toBe(120);
      expect(w.fires()[0].checked_at).toBe(iso(at(2, 10, 5)));
      for (const d of [8, 10]) {
        await w.runAt(at(d, 10, 5));
        expect(w.price()).toBe(120);
      }
      expect(w.story()).toEqual([["Ten", iso(at(0, 10, 5)), null]]);
    }, 120_000);
  });

  describe("a group is one booking until its last room on the night cancels (much faster in a day, and surging in a day)", () => {
    const rules = [
      rule(
        "Quick",
        { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
        { priority: 100, action_value: 10 },
      ),
      rule(
        "Surge",
        { booking_speed_operator: "at_least", booking_speed_level: "surging", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
        { priority: 120, action_value: 20 },
      ),
    ];

    it("the group cancels its first rooms and keeps two it added after both raises: both stay", async () => {
      const bookedOn = dayOf(at(0, 10));
      const group = [1, 2, 3].map((k) => booking(NIGHT, bookedOn, at(0, 10), `6364686337417-${k}`));
      const added = [4, 5].map((k) => booking(NIGHT, bookedOn, at(0, 11), `6364686337417-${k}`));
      const w = timeline(engine, { rules, rows: [...paced(), ...burst(4, at(0, 10)), ...group, ...burst(2, at(0, 10, 30)), ...added] });
      // Four singles and the group: 5 bookings, much faster.
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      // Two more: 7 in the day, surging, on top.
      await w.runAt(at(0, 10, 35));
      expect(w.price()).toBe(132);
      expect(w.fires().map((e) => (e.window_booking_keys as string[]).length)).toEqual([5, 7]);
      await w.runAt(at(0, 11, 5));
      w.cancel(group);
      await w.runAt(at(0, 12, 5));
      // Every booking either raise counted is still booked.
      expect(w.price()).toBe(132);
      expect(w.story()).toEqual([
        ["Quick", iso(at(0, 10, 5)), null],
        ["Surge", iso(at(0, 10, 35)), null],
      ]);
    }, 120_000);
  });

  describe("what the check reads", () => {
    it("with nothing cancelled, a change's window is never read again", async () => {
      const quick = rule(
        "Quick pickup",
        { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
      );
      const w = timeline(engine, { rules: [quick], rows: [...paced(), ...burst(5, at(0, 10))] });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      const before = w.calls.length;
      await w.runAt(at(2, 10, 5));
      const since = w.calls
        .slice(before)
        .filter((c) => c.table === "rpc:booking_speed_windows")
        .flatMap((c) => ((c.payload as { p_since?: string[] | null } | null)?.p_since ?? []) as string[]);
      expect(since).not.toContain(iso(at(0, 10, 5)));
      expect(w.price()).toBe(110);
    }, 120_000);
  });

  describe("what a fire records reads only for fires about to be written", () => {
    it("a raise that loses, or is held by a stronger rule still waiting, reads none of the night's bookings", async () => {
      const rules = [
        rule(
          "Five in a day",
          { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
          { priority: 100, action_value: 10 },
        ),
        rule(
          "Stronger tier",
          { booking_speed_operator: "at_least", booking_speed_level: "surging", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
          { priority: 120, action_value: 20 },
        ),
      ];
      const w = timeline(engine, { rules, rows: [...paced(), ...burst(10, at(0, 10)), ...burst(7, at(0, 10, 30))] });
      const nightReads = (from: number) =>
        w.calls
          .slice(from)
          .filter((c) => c.table === "reservations" && c.op === "select" && c.columns.includes("external_reservation_id")).length;
      let before = w.calls.length;
      // Both are true on the 10; the stronger one wins and is written with its keys.
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(120);
      expect(nightReads(before)).toBe(1);
      expect((w.fires()[0].window_booking_keys as string[]).length).toBe(10);
      // 7 more: the first rule counts them since the raise and would raise,
      // but the stronger one, waiting, counts them too and holds the night.
      before = w.calls.length;
      await w.runAt(at(0, 10, 35));
      expect(w.price()).toBe(120);
      expect(w.story()).toEqual([["Stronger tier", iso(at(0, 10, 5)), null]]);
      expect(nightReads(before)).toBe(0);
    }, 120_000);
  });

  describe("a rate changed in the PMS is not a cancellation (revenue more than 400 in 3 days, +10%)", () => {
    it("one of the five it counted is re-rated to 0 and an older booking cancels: it stays", async () => {
      const rev = rule("Revenue pickup", {
        pickup_operator: "gt",
        pickup_threshold: 400,
        pickup_window_days: 3,
        pickup_metric: "revenue",
        pickup_cooldown_days: 1,
      });
      const five = burst(5, at(0, 10));
      const old = settled(10);
      const w = timeline(engine, { rules: [rev], rows: [...old, ...five], snapshotDays: 4 });
      await w.runAt(at(0, 10, 5));
      expect(w.price()).toBe(110);
      w.tables.reservations.find((r) => r.id === five[0].id)!.current_rate = 0;
      await w.runAt(at(0, 11, 5));
      w.cancel(old.slice(0, 1));
      await w.runAt(at(0, 12, 5));
      expect(w.price()).toBe(110);
      expect(w.story()).toEqual([["Revenue pickup", iso(at(0, 10, 5)), null]]);
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
