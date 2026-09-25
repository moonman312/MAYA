/**
 * A rule counts only the bookings made after the newest change on the night
 * and room type by itself or by a rule that adjusts the same way and ranks
 * ahead of it (Jake, 2026-09-24, option A). A weaker rule's change never
 * restarts a stronger rule's count: "the clock doesn't reset, the count
 * just continues". So:
 *
 * - With a rule for 5 bookings and a stronger one for 10, 5 and then 5 more
 *   raise twice, the second time on all 10, while 10 at once raise once and
 *   the rule for 5 then counts only what comes after that raise. The
 *   owner's five examples run below as Booking Speed rules and as pickup
 *   count rules. Under the starter rules ten bookings at once end at $125,
 *   not $172.
 * - A rule that raises counts today so far, the day of the raise it counts
 *   from split at the raise (reservations.created_at). A rule that cuts
 *   reads complete hotel days only, ending yesterday, on the night and on
 *   the nights it is compared with alike, first decision or repeat; after a
 *   cut it counts the complete days after the cut's day, and has nothing to
 *   judge until one has passed. A stronger cut covers the weaker cut rules
 *   the same way.
 * - A stronger rule that is waiting and still matches holds the night, so
 *   tiers climb as the count climbs.
 *
 * Every case runs whole evaluateHotel runs on the app's engine and on the
 * edge functions' copy, against the in-memory fake. A booking reaches the
 * reservations table only once its created_at has passed, and runs happen
 * at given instants, the way the syncs and the daily pass would run them.
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
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T00 = Date.parse(`${D0}T00:00:00.000Z`);
const STD = "a0000000-0000-4000-8000-0000000000a1";
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    rule_condition: [condition],
    rule_signal_room_type: [{ room_type_id: STD }],
    rule_affected_room_type: [{ room_type_id: STD }],
    ...over,
  };
}

/** The five starter rules, as onboarding writes them. */
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
/** One booking of one room, first seen at `firstSeen`, its own reservation unless `ext` says otherwise. */
function booking(stay: string, bookedOn: string, firstSeen: number | string, ext?: string): FakeRow {
  resId++;
  return {
    id: `f0000000-0000-4000-8000-${String(resId).padStart(12, "0")}`,
    hotel_id: "h1",
    external_reservation_id: ext ?? `${700000000 + resId}`,
    stay_date: stay,
    room_type_id: STD,
    booking_date: bookedOn,
    booking_window_days: daysBetween(bookedOn, stay),
    current_rate: 100,
    base_rate: 100,
    created_at: typeof firstSeen === "number" ? iso(firstSeen) : firstSeen,
  };
}

/**
 * Every night from 400 days back to `last`: `per` bookings at each lead
 * time in `leads`, first seen at `hours` of their booking day, unless
 * `skip` says otherwise.
 */
function background(
  last: string,
  leads: number[],
  opts: { per?: number; hours?: number[]; skip?: (stay: string, lead: number) => boolean } = {},
): FakeRow[] {
  const per = opts.per ?? 1;
  const hours = opts.hours ?? [10];
  const out: FakeRow[] = [];
  for (let stay = addDays(D0, -400); stay <= last; stay = addDays(stay, 1)) {
    for (const lead of leads) {
      if (opts.skip?.(stay, lead)) continue;
      const on = addDays(stay, -lead);
      for (let k = 0; k < per; k++) out.push(booking(stay, on, `${on}T${String(hours[k % hours.length]).padStart(2, "0")}:00:00.000Z`));
    }
  }
  return out;
}

/** One booking every 10 days of lead time: 0 to 1 a day, about 3 a month. */
const QUIET = Array.from({ length: 18 }, (_, i) => 3 + 10 * i);

/**
 * A hotel whose bookings reach MAYA at their created_at. `runAt` first puts
 * every booking first seen by then on the books, then runs the engine at
 * that instant, pricing through `last`. `snapshotDays` writes the 6-hourly
 * snapshots a pickup count rule reads its window from over that many days
 * before D0, from the bookings first seen by each (the engine writes its
 * own from then on).
 */
function timeline(engine: Engine, o: { rules: FakeRow[]; rows: FakeRow[]; last: string; rooms?: number; snapshotDays?: number }) {
  const nights: string[] = [];
  for (let d = D0; d <= o.last; d = addDays(d, 1)) nights.push(d);
  const seeded: FakeRow[] = [];
  for (let h = (o.snapshotDays ?? 0) * 24; h > 0; h -= 6) {
    const ts = T00 - h * HOUR;
    for (const stay of nights) {
      const n = o.rows.filter((r) => r.stay_date === stay && Date.parse(String(r.created_at)) <= ts).length;
      seeded.push({ hotel_id: "h1", snapshot_ts: iso(ts), stay_date: stay, room_type_id: STD, sellable_units: o.rooms ?? 40, booked_units: n, booked_revenue: n * 100 });
    }
  }
  const fake = fakeSupabase({
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: [
      { id: STD, hotel_id: "h1", name: "Standard", is_active: true, total_rooms: o.rooms ?? 40, floor_price: 10, ceiling_price: 99999, counts_as_room: true },
    ],
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
    await engine.evaluateHotel(fake.client, "h1", now, daysBetween(now.slice(0, 10), o.last) + 1);
  };
  const runAll = async (instants: number[]) => {
    for (const t of [...new Set(instants)].sort((a, b) => a - b)) await runAt(t);
  };
  const fires = (stay: string) =>
    fake.tables.pickup_event
      .filter((e) => e.stay_date === stay)
      .sort((a, b) => String(a.applied_at).localeCompare(String(b.applied_at)));
  /** [rule, when, days counted from..to, day split at, bookings counted] per fire. */
  const fired = (stay: string) =>
    fires(stay).map((e) => [
      e.rule_id,
      String(e.applied_at),
      e.window_from,
      e.window_to,
      e.window_since,
      e.window_bookings_at_fire,
    ]);
  const price = (stay: string) =>
    Number(fake.tables.published_price.find((p) => p.stay_date === stay && p.room_type_id === STD)?.price);
  return { ...fake, runAt, runAll, fires, fired, price };
}

/** Every 5 minutes from `from` to `to`, both included. */
function everyFive(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = from; t <= to; t += 5 * MIN) out.push(t);
  return out;
}

/** Runs at `hours`:05 on every day from `a` to `b`. */
function ticks(a: number, b: number, hours: number[]): number[] {
  const out: number[] = [];
  for (let d = a; d <= b; d++) for (const h of hours) out.push(at(d, h, 5));
  return out;
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

describe.each(ENGINES)("$name: a rule counts from its own last change or a stronger rule's", (engine) => {
  const NIGHT = addDays(D0, 40);
  const LAST = addDays(D0, 41);
  /** Syncs 2 minutes after every 5-minute mark from before the bookings to well after them, then an evening run. */
  const AFTERNOON = [...everyFive(at(0, 13, 57), at(0, 14, 52)), at(0, 16, 2), at(0, 18, 5)];

  describe.each([
    { pms: "Cloudbeds", key: (k: number) => `6364686337417-${k}` },
    { pms: "Think", key: (k: number) => `res_77:b${k}` },
  ])("a 20-room wedding reservation, keyed as $pms keys it", ({ key }) => {
    it("is one booking: no rule raises on pace, while the occupancy rule still sees its twenty rooms", async () => {
      const busy = rule("Busy night", { occupancy_operator: "gt", occupancy_threshold: 0.5 }, { is_pickup_rule: false, priority: 50 });
      const wedding = Array.from({ length: 20 }, (_, i) => booking(NIGHT, D0, at(0, 14), key(i + 1)));
      const w = timeline(engine, { rules: [...starterRules(), busy], rows: [...background(LAST, QUIET), ...wedding], last: LAST });
      await w.runAll([at(0, 13, 57), at(0, 14, 2), at(0, 14, 7), ...ticks(1, 8, [0])]);
      expect(w.tables.pickup_event).toEqual([]);
      // Fourteen rooms of background (35% of 40) and the wedding's twenty.
      expect(w.price(NIGHT)).toBe(110);
      expect(w.price(addDays(D0, 39))).toBe(100);
    }, 120_000);
  });

  describe("ten separate bookings first seen at once", () => {
    const rows = () => [...background(LAST, QUIET), ...Array.from({ length: 10 }, () => booking(NIGHT, D0, at(0, 14)))];

    it("the strongest rule that matches raises once, and the weaker tiers never count the ten again: $125, not $172", async () => {
      const w = timeline(engine, { rules: starterRules(), rows: rows(), last: LAST });
      await w.runAll(AFTERNOON);
      // All three raise rules read the ten; the spike rule ranks first and
      // raises, then holds the night every sync that afternoon.
      expect(w.fired(NIGHT)).toEqual([["Sudden-spike catcher", iso(at(0, 14, 2)), D0, D0, null, 10]]);
      expect(w.price(NIGHT)).toBe(125);
      // Next day its one-day window has nothing in it, so it no longer
      // holds, though it still waits. The week and month rules rank below
      // it, so they count only what came after its raise: nothing. Counting
      // the ten again would have added the week rule's 25% and the month
      // rule's 10%, $172.
      await w.runAll(ticks(1, 5, [0, 12]));
      expect(w.fired(NIGHT)).toEqual([["Sudden-spike catcher", iso(at(0, 14, 2)), D0, D0, null, 10]]);
      expect(w.price(NIGHT)).toBe(125);
    }, 120_000);

    it("control: without the spike rule, the week rule raises on them at the first sync", async () => {
      const rules = starterRules().filter((r) => r.name !== "Sudden-spike catcher");
      const w = timeline(engine, { rules, rows: rows(), last: LAST });
      await w.runAll([at(0, 13, 57), at(0, 14, 2)]);
      expect(w.fired(NIGHT)).toEqual([["Hot-week surge", iso(at(0, 14, 2)), addDays(D0, -6), D0, null, 11]]);
    }, 120_000);
  });

  it("ten bookings one every 5 minutes, synced every 5 minutes: the tiers climb as the running count reaches each, and a weaker rule counts only what came after a stronger one's raise", async () => {
    const rows = [...background(LAST, QUIET), ...Array.from({ length: 10 }, (_, i) => booking(NIGHT, D0, at(0, 14, 5 * i)))];
    const w = timeline(engine, { rules: starterRules(), rows, last: LAST });
    await w.runAll(AFTERNOON);
    // 14:07: two new and the one a night like it gets in a week read much
    // faster for the week rule. 14:17: four today, surging for the spike
    // rule, whose count the weaker week rule's raise doesn't restart; the
    // week rule is waiting and still matches, but the spike rule ranks
    // above it.
    expect(w.fired(NIGHT)).toEqual([
      ["Hot-week surge", iso(at(0, 14, 7)), addDays(D0, -6), D0, null, 3],
      ["Sudden-spike catcher", iso(at(0, 14, 17)), D0, D0, null, 4],
    ]);
    await w.runAll(ticks(1, 5, [0, 18]));
    // After its two-day wait the week rule counts only what reached MAYA
    // after the newest raise by itself or a stronger rule: the spike
    // rule's at 14:17, so the six from 14:20 on (window_since is that
    // raise). The month rule ranks below both and never counts any of
    // them: every one came before a stronger rule's raise.
    expect(w.fired(NIGHT)).toEqual([
      ["Hot-week surge", iso(at(0, 14, 7)), addDays(D0, -6), D0, null, 3],
      ["Sudden-spike catcher", iso(at(0, 14, 17)), D0, D0, null, 4],
      ["Hot-week surge", iso(at(2, 18, 5)), D0, addDays(D0, 2), iso(at(0, 14, 17)), 6],
    ]);
    expect(w.price(NIGHT)).toBeCloseTo(100 * 1.25 ** 3, 2);
    // Every count starts at the newest earlier raise by the rule itself or
    // one that ranks ahead of it, and a rule with none judged its whole
    // window.
    const rank = new Map(starterRules().map((r) => [String(r.id), Number(r.priority)]));
    const fires = w.fires(NIGHT);
    fires.forEach((f, i) => {
      const covering = fires.slice(0, i).filter((g) => rank.get(String(g.rule_id))! >= rank.get(String(f.rule_id))!);
      expect(f.window_since).toBe(covering.length > 0 ? covering[covering.length - 1].applied_at : null);
    });
  }, 120_000);

  /** The hotel date a booking first seen at `ms` was made on (the hotel runs on UTC). */
  const dayOf = (ms: number) => iso(ms).slice(0, 10);

  describe("the owner's five examples as Booking Speed rules: a rule for a fast day, and a stronger one", () => {
    // Nights like this one book 2 a day at every lead from 50 to 30 days
    // out, so over one day "much faster" first reads at 5 bookings and
    // "surging" at 7; this night has none of its own from 40 days out on.
    // His rule for 5 bookings (+10%) is "much faster in a day" here, and
    // his rule for 10 (+20%) "surging in a day", ranked ahead of it. Both
    // wait a day.
    const rows = (batches: { n: number; at: number }[]) => [
      ...background(LAST, Array.from({ length: 21 }, (_, i) => 30 + i), { per: 2, hours: [3], skip: (stay, lead) => stay === NIGHT && lead <= 40 }),
      ...batches.flatMap((b) => Array.from({ length: b.n }, () => booking(NIGHT, dayOf(b.at), b.at))),
    ];
    const rules = () => [
      rule("Five in a day", { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 }, { priority: 100, action_value: 10 }),
      rule("Stronger tier", { booking_speed_operator: "at_least", booking_speed_level: "surging", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 }, { priority: 120, action_value: 20 }),
    ];
    /** Every hour from 09:05 to 13:05 on days 0 and 1, then twice a day to day 3. */
    const RUNS = [...ticks(0, 1, [9, 10, 11, 12, 13]), ...ticks(2, 3, [0, 12])];
    const story = async (batches: { n: number; at: number }[]) => {
      const w = timeline(engine, { rules: rules(), rows: rows(batches), last: LAST });
      await w.runAll(RUNS);
      return w;
    };

    it("5, then 5 more: the first rule raises on 5 ($110), and the stronger rule on all 10 ($132), not on 5 more after the first rule's raise", async () => {
      const w = await story([{ n: 5, at: at(0, 10) }, { n: 5, at: at(0, 11) }]);
      expect(w.fired(NIGHT)).toEqual([
        ["Five in a day", iso(at(0, 10, 5)), D0, D0, null, 5],
        ["Stronger tier", iso(at(0, 11, 5)), D0, D0, null, 10],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.1 * 1.2, 2);
      expect(w.tables.pickup_event.every((e) => e.stay_date === NIGHT)).toBe(true);
    }, 120_000);

    it("10 at once, then nothing: the stronger rule raises ($120), and the first rule never raises on those same 10", async () => {
      const w = await story([{ n: 10, at: at(0, 10) }]);
      expect(w.fired(NIGHT)).toEqual([["Stronger tier", iso(at(0, 10, 5)), D0, D0, null, 10]]);
      expect(w.price(NIGHT)).toBe(120);
    }, 120_000);

    it("10 at once, then 3 more the next day: still $120", async () => {
      const w = await story([{ n: 10, at: at(0, 10) }, { n: 3, at: at(1, 11) }]);
      expect(w.fired(NIGHT)).toEqual([["Stronger tier", iso(at(0, 10, 5)), D0, D0, null, 10]]);
      expect(w.price(NIGHT)).toBe(120);
    }, 120_000);

    it("10 at once, then 5 more the next day: the first rule raises on the 5 new ones ($132)", async () => {
      const w = await story([{ n: 10, at: at(0, 10) }, { n: 5, at: at(1, 11) }]);
      expect(w.fired(NIGHT)).toEqual([
        ["Stronger tier", iso(at(0, 10, 5)), D0, D0, null, 10],
        ["Five in a day", iso(at(1, 11, 5)), addDays(D0, 1), addDays(D0, 1), null, 5],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.2 * 1.1, 2);
    }, 120_000);

    it("6 at once, then 4 more: the first rule raises on the 6 ($110), then the stronger rule on all 10 ($132), because the weaker raise doesn't restart its count", async () => {
      // His example is 7 and then 3. Here "surging" already reads at 7, so
      // 6 plays his 7: past the first rule, short of the stronger one. The
      // 4 after it would not reach even the first rule on their own (below).
      const w = await story([{ n: 6, at: at(0, 10) }, { n: 4, at: at(0, 11) }]);
      expect(w.fired(NIGHT)).toEqual([
        ["Five in a day", iso(at(0, 10, 5)), D0, D0, null, 6],
        ["Stronger tier", iso(at(0, 11, 5)), D0, D0, null, 10],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(100 * 1.1 * 1.2, 2);
    }, 120_000);

    it("the 5 after the first raise alone would not reach the stronger rule, and 4 would not reach the first", async () => {
      for (const [n, want] of [
        [4, []],
        [5, [["Five in a day", 5]]],
      ] as const) {
        const w = timeline(engine, { rules: rules(), rows: rows([{ n, at: at(0, 10) }]), last: LAST });
        await w.runAll([at(0, 10, 5), at(0, 11, 5)]);
        expect(w.fires(NIGHT).map((e) => [e.rule_id, e.window_bookings_at_fire])).toEqual(want);
      }
    }, 120_000);
  });

  describe("the owner's five examples as pickup count rules: more than 4, and more than 9, in 7 days", () => {
    // His numbers exactly: "Five" raises 10% on more than 4 bookings in 7
    // days, "Ten" 20% on more than 9. Same priority, so the higher count
    // ranks ahead (selectPickupWinner). Each waits its 7 days. Nothing else
    // books this night; runs at 00:05 and 12:05 every day.
    const pickup = (id: string, threshold: number, value: number, windowDays = 7) =>
      rule(id, { pickup_operator: "gt", pickup_threshold: threshold, pickup_window_days: windowDays, pickup_metric: "room_nights" }, { action_value: value });
    const story = async (batches: { n: number; at: number }[], rules = [pickup("Five", 4, 10), pickup("Ten", 9, 20)]) => {
      const rows = batches.flatMap((b) => Array.from({ length: b.n }, () => booking(NIGHT, dayOf(b.at), b.at)));
      const w = timeline(engine, { rules, rows, last: LAST, snapshotDays: 8 });
      await w.runAll(ticks(0, 10, [0, 12]));
      return w;
    };
    /** [rule, when, rooms booked where its count started, rooms booked at the fire] per fire. */
    const counted = (w: ReturnType<typeof timeline>) =>
      w.fires(NIGHT).map((e) => [e.rule_id, String(e.applied_at), e.signal_booked_units_start, e.signal_booked_units_end]);

    it("5, then 5 more the next day: Five raises on 5 ($110), and Ten on all 10 ($132)", async () => {
      const w = await story([{ n: 5, at: at(0, 10) }, { n: 5, at: at(1, 10) }]);
      expect(counted(w)).toEqual([
        ["Five", iso(at(0, 12, 5)), 0, 5],
        ["Ten", iso(at(1, 12, 5)), 0, 10],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(132, 2);
    }, 120_000);

    it("10 at once, then nothing: Ten raises ($120), and Five never raises on those same 10", async () => {
      const w = await story([{ n: 10, at: at(0, 10) }]);
      expect(counted(w)).toEqual([["Ten", iso(at(0, 12, 5)), 0, 10]]);
      expect(w.price(NIGHT)).toBe(120);
    }, 120_000);

    it("10 at once, then 3 more: still $120", async () => {
      const w = await story([{ n: 10, at: at(0, 10) }, { n: 3, at: at(2, 10) }]);
      expect(counted(w)).toEqual([["Ten", iso(at(0, 12, 5)), 0, 10]]);
      expect(w.price(NIGHT)).toBe(120);
    }, 120_000);

    it("10 at once, then 5 more: Five raises on the 5 new ones ($132), once Ten stops holding the night", async () => {
      // Ten waits its week and, with 15 in its window, holds the night
      // meanwhile. Then it counts from its own raise (5, not enough) and
      // Five counts from Ten's raise too: the 5.
      const w = await story([{ n: 10, at: at(0, 10) }, { n: 5, at: at(2, 10) }]);
      expect(counted(w)).toEqual([
        ["Ten", iso(at(0, 12, 5)), 0, 10],
        ["Five", iso(at(7, 12, 5)), 10, 15],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(132, 2);
    }, 120_000);

    it("7 at once, then 3 more: Five raises on the 7 ($110), then Ten on all 10 ($132), because Five's raise doesn't restart Ten's count", async () => {
      const w = await story([{ n: 7, at: at(0, 10) }, { n: 3, at: at(1, 10) }]);
      expect(counted(w)).toEqual([
        ["Five", iso(at(0, 12, 5)), 0, 7],
        ["Ten", iso(at(1, 12, 5)), 0, 10],
      ]);
      expect(w.price(NIGHT)).toBeCloseTo(132, 2);
    }, 120_000);

    it("with Ten counting 3 days, Five still never raises on the 10 Ten raised on, once Ten stops holding the night", async () => {
      // Ten waits 3 days. After that Five's own week still holds the 10,
      // but they came before a stronger rule's raise, so Five's count
      // starts at that raise: nothing since.
      const w = await story([{ n: 10, at: at(0, 10) }], [pickup("Five", 4, 10), pickup("Ten", 9, 20, 3)]);
      expect(counted(w)).toEqual([["Ten", iso(at(0, 12, 5)), 0, 10]]);
      expect(w.price(NIGHT)).toBe(120);
    }, 120_000);

    it("a paused stronger cut still covers a weaker 'fewer than' rule, which then judges a whole window after that cut, not a shorter stretch", async () => {
      // "Dead" cuts 15% on no bookings in 3 days and ranks ahead of "Slow",
      // which cuts 7% on fewer than 3 in 7 days. Nothing is booked on this
      // night yet, so Dead cuts at the first run, and the owner pauses it:
      // its cut stays on the price and still covers Slow. Slow counts from
      // that cut, and "fewer than 3 in 7 days" can't be told from a day or
      // two, so it waits for a whole week after the cut, then cuts on that
      // week's one booking.
      const cut = (id: string, threshold: number, windowDays: number, value: number, priority: number) =>
        rule(
          id,
          { pickup_operator: "lt", pickup_threshold: threshold, pickup_window_days: windowDays, pickup_metric: "room_nights" },
          { action_direction: "decrease", action_value: value, priority },
        );
      const w = timeline(engine, {
        rules: [cut("Dead", 1, 3, 15, 120), cut("Slow", 3, 7, 7, 100)],
        rows: [booking(NIGHT, addDays(D0, 1), at(1, 10))],
        last: LAST,
        snapshotDays: 8,
      });
      await w.runAt(at(0, 0, 5));
      expect(counted(w)).toEqual([["Dead", iso(at(0, 0, 5)), 0, 0]]);
      w.tables.pricing_rules.find((r) => r.id === "Dead")!.is_active = false;
      await w.runAll(ticks(0, 10, [0, 12]).filter((t) => t > at(0, 0, 5)));
      expect(counted(w)).toEqual([
        ["Dead", iso(at(0, 0, 5)), 0, 0],
        ["Slow", iso(at(7, 0, 5)), 0, 1],
      ]);
      expect(w.fires(NIGHT)[1].baseline_start_ts).toBe(iso(at(0, 0, 5)));
      expect(w.price(NIGHT)).toBeCloseTo(100 * 0.85 * 0.93, 2);
    }, 120_000);
  });

  it("a surge of separate bookings over two weeks still stacks raises, each on the bookings since the week rule's own last raise", async () => {
    // Three a day at 09:00, 13:00 and 17:00 for two weeks, against about
    // one a week usually.
    const wave: FakeRow[] = [];
    for (let d = 0; d < 14; d++) for (const h of [9, 13, 17]) wave.push(booking(NIGHT, addDays(D0, d), at(d, h)));
    const w = timeline(engine, { rules: starterRules(), rows: [...background(LAST, QUIET), ...wave], last: LAST });
    await w.runAll(ticks(0, 22, [1, 13]));
    const fires = w.fires(NIGHT);
    // The week rule raises every two days while the bookings keep coming,
    // each time on the bookings since its own last raise, holding the
    // night against the month rule in between. The day rule never reads
    // surging on three a day.
    const week = fires.filter((e) => e.rule_id === "Hot-week surge");
    expect(week.map((e) => String(e.applied_at))).toEqual([0, 2, 4, 6, 8, 10, 12, 14].map((d) => iso(at(d, 13, 5))));
    for (let i = 1; i < week.length; i++) expect(week[i].window_since).toBe(week[i - 1].applied_at);
    // Once they stop, the week rule has nothing new. The month rule ranks
    // below it, so it only ever counts what came after the week rule's
    // latest raise, which is never enough: it never raises on them.
    expect(fires.filter((e) => e.rule_id !== "Hot-week surge")).toEqual([]);
    expect(w.price(NIGHT)).toBeCloseTo(100 * 1.25 ** 8, 1);
  }, 120_000);

  describe("a slow night under the starter rules, with a run 5 minutes after every cut", () => {
    // Every night books 3 a day at every lead from 55 to 10 days out, first
    // seen through the day; this night gets `per` a day (or `per(day)` for
    // the day it was booked on), first seen at 11:00 and 19:00. Runs: the
    // daily pass at 00:05, and one 5 minutes after any run that cut.
    const NIGHT20 = addDays(D0, 20);
    const LAST20 = addDays(D0, 21);
    const slowRows = (per: number | ((bookedOn: string) => number)) => {
      const out: FakeRow[] = [];
      for (let stay = addDays(D0, -400); stay <= LAST20; stay = addDays(stay, 1)) {
        const hours = stay === NIGHT20 ? [11, 19] : [3, 11, 19];
        for (let lead = 10; lead <= 55; lead++) {
          const on = addDays(stay, -lead);
          const n = stay !== NIGHT20 ? 3 : typeof per === "number" ? per : per(on);
          for (let k = 0; k < n; k++) out.push(booking(stay, on, `${on}T${String(hours[k % hours.length]).padStart(2, "0")}:00:00.000Z`));
        }
      }
      return out;
    };
    const runDays = async (w: ReturnType<typeof timeline>, days: number) => {
      for (let d = 0; d <= days; d++) {
        const before = w.fires(NIGHT20).length;
        await w.runAt(at(d, 0, 5));
        if (w.fires(NIGHT20).length > before) await w.runAt(at(d, 0, 10));
      }
    };

    it("at two thirds of the usual pace: trims, never rescues on the back of the trim, and trims again once a week of complete days since reads slow", async () => {
      const w = timeline(engine, { rules: starterRules(), rows: slowRows(2), last: LAST20, rooms: 500 });
      await runDays(w, 16);
      // Each cut reads complete days only, ending the day before, on the
      // night and on the nights it is compared with. Five minutes after
      // the trim the rescue rule, which never cut this night, reads its
      // whole month the same way: a bit behind, not far behind.
      expect(w.fired(NIGHT20)).toEqual([
        ["Slow-date trim", iso(at(0, 0, 5)), addDays(D0, -30), addDays(D0, -1), null, 60],
        // After its week's wait: the seven complete days after its cut's
        // day. Six would be too few to call it (12 against 18).
        ["Slow-date trim", iso(at(8, 0, 5)), addDays(D0, 1), addDays(D0, 7), null, 14],
      ]);
      expect(w.price(NIGHT20)).toBeCloseTo(100 * 0.93 * 0.93, 2);
      expect(w.tables.pickup_event.every((e) => e.stay_date === NIGHT20)).toBe(true);
    }, 120_000);

    it("at a third of the usual pace: rescues, and rescues again after each week's wait on the complete days since", async () => {
      const w = timeline(engine, { rules: starterRules(), rows: slowRows(1), last: LAST20, rooms: 500 });
      await runDays(w, 16);
      expect(w.fired(NIGHT20)).toEqual([
        ["Slow-date rescue", iso(at(0, 0, 5)), addDays(D0, -30), addDays(D0, -1), null, 30],
        ["Slow-date rescue", iso(at(7, 0, 5)), addDays(D0, 1), addDays(D0, 6), null, 6],
        // Nothing books this close in (under 10 days out), here or on the
        // nights it is compared with, after the 26th.
        ["Slow-date rescue", iso(at(14, 0, 5)), addDays(D0, 8), addDays(D0, 13), null, 3],
      ]);
      expect(w.price(NIGHT20)).toBeCloseTo(100 * 0.85 ** 3, 2);
    }, 120_000);

    it("picking back up after a rescue: the rescue stops, and the trim, which ranks below it, never cuts on the slow stretch the rescue already cut for", async () => {
      // A third of the usual pace until day 0, the usual 3 a day from then
      // on. The rescue ranks ahead of the trim, so its cut is where the trim
      // starts counting too: the complete days after the rescue's day, all
      // at the usual pace. Counting its whole month instead, the trim would
      // cut again on day 8 (46 against 90) for the slow stretch the rescue
      // already cut for.
      const w = timeline(engine, { rules: starterRules(), rows: slowRows((on) => (on < D0 ? 1 : 3)), last: LAST20, rooms: 500 });
      await runDays(w, 12);
      // Day 7: the rescue's week since (18 against 18) is normal, so no
      // second rescue, and the trim reads the same week the same way.
      expect(w.fired(NIGHT20)).toEqual([
        ["Slow-date rescue", iso(at(0, 0, 5)), addDays(D0, -30), addDays(D0, -1), null, 30],
      ]);
      expect(w.price(NIGHT20)).toBe(85);
    }, 120_000);

    it("a cut rule with a day's wait has nothing to judge until a complete day has passed since its cut's day", async () => {
      // No bookings at all on this night. A cut at 00:05 on day 0; its wait
      // is over at 00:05 on day 1, but day 0 was the cut's own day and day 1
      // has only started, so there is nothing to judge all day 1 (reading
      // day 0's last 24 hours against whole days of other nights would call
      // any night slow). Day 1 whole, read on day 2, is the next cut's.
      const cut = rule(
        "Cut daily",
        { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30, booking_speed_cooldown_days: 1 },
        { action_direction: "decrease" },
      );
      const w = timeline(engine, { rules: [cut], rows: slowRows(0), last: LAST20, rooms: 500 });
      await w.runAll([at(0, 0, 5), at(1, 0, 5), at(1, 0, 10), at(1, 12, 5), at(1, 23, 55), at(2, 0, 5)]);
      expect(w.fired(NIGHT20)).toEqual([
        ["Cut daily", iso(at(0, 0, 5)), addDays(D0, -30), addDays(D0, -1), null, 0],
        ["Cut daily", iso(at(2, 0, 5)), addDays(D0, 1), addDays(D0, 1), null, 0],
      ]);
      expect(w.fires(NIGHT20)[1].window_expected_at_fire).toBe(3);
    }, 120_000);
  });

  it("reads every night's day split at a raise, when the same raise instant is read for one night first and another after", async () => {
    // Rule A (on N1, a day's wait) and rule B (on N2, two days' wait) both
    // raise at noon on day 0, so their raises share one instant. Thirty
    // bookings reach N1 at 14:00 and N2 at 16:00 that day. A raises again
    // on day 1 on its thirty, counting from its noon raise. On day 2 that
    // open raise's cancellation test and B's own count both read the noon
    // raise's day: A's for N1, B's for N2. B must see its thirty.
    const N1 = NIGHT;
    const N2 = addDays(D0, 41);
    const LAST2 = addDays(D0, 42);
    const speed = { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7 };
    const a = rule("A", { ...speed, booking_speed_cooldown_days: 1 }, { start_date: N1, end_date: N1 });
    const b = rule("B", { ...speed, booking_speed_cooldown_days: 2 }, { start_date: N2, end_date: N2 });
    const rows = [
      ...background(LAST2, QUIET),
      ...Array.from({ length: 3 }, () => booking(N1, D0, at(0, 10))),
      ...Array.from({ length: 3 }, () => booking(N2, D0, at(0, 10))),
      ...Array.from({ length: 30 }, () => booking(N1, D0, at(0, 14))),
      ...Array.from({ length: 30 }, () => booking(N2, D0, at(0, 16))),
    ];
    const w = timeline(engine, { rules: [a, b], rows, last: LAST2 });
    await w.runAll([at(0, 12), at(0, 14, 5), at(0, 16, 5), at(1, 12, 5), at(2, 12, 5)]);
    expect(w.fired(N1)).toEqual([
      ["A", iso(at(0, 12)), addDays(D0, -6), D0, null, 4],
      ["A", iso(at(1, 12, 5)), D0, addDays(D0, 1), iso(at(0, 12)), 30],
    ]);
    expect(w.fired(N2)).toEqual([
      ["B", iso(at(0, 12)), addDays(D0, -6), D0, null, 4],
      ["B", iso(at(2, 12, 5)), D0, addDays(D0, 2), iso(at(0, 12)), 30],
    ]);
  }, 120_000);

  it("reads every raise's split day in one windows call per set of room types, however many raise instants there are", async () => {
    // Twenty bookings land on a different night each day for twelve days,
    // and the starter rules raise each of them over the runs that follow.
    const K = 12;
    const nights = Array.from({ length: K }, (_, i) => addDays(D0, 40 + i));
    const last = addDays(D0, 40 + K);
    const rows = background(last, QUIET);
    for (let day = 0; day < K; day++) for (let k = 0; k < 20; k++) rows.push(booking(nights[day], addDays(D0, day), at(day, 11)));
    const w = timeline(engine, { rules: starterRules(), rows, last });
    for (let day = 0; day < K; day++) await w.runAt(at(day, 12));
    const before = w.calls.length;
    await w.runAt(at(K, 12));
    const split = w.calls
      .slice(before)
      .filter((c) => c.table === "rpc:booking_speed_windows")
      .map((c) => c.payload as Record<string, unknown>)
      .filter((p) => p.p_since != null);
    // One call, every (night, raise) pair in it: raises made by many runs.
    expect(split).toHaveLength(1);
    const instants = new Set(split[0].p_since as string[]);
    expect(instants.size).toBeGreaterThan(3);
    expect((split[0].p_dates as string[]).length).toBe((split[0].p_since as string[]).length);
  }, 120_000);
});
