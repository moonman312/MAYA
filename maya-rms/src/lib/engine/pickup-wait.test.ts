/**
 * A pickup count rule waits the wait its owner chose (pickup_cooldown_days),
 * or its lookback window when none was chosen (Jake, 2026-09-24), and counts
 * only what came after the newest change on the night and room type by
 * itself or by a stronger rule that adjusts the same way (countFromFireAt;
 * option A, the same for pickup counts as for booking speed).
 *
 * With a wait shorter than its window, its next decision on a night would
 * otherwise read the burst it raised on again and raise twice on it. So a
 * "more than" count opens at that change (pickupWindowOpensAt): the snapshot
 * the change's run wrote at that instant holds the bookings it acted on. A
 * weaker rule's change never moves where a stronger rule counts from. A
 * typed price is a reset point, after whose wait the rule judges its whole
 * window again.
 *
 * Every case runs whole evaluateHotel runs, on the app's engine and on the
 * edge functions' copy, against the in-memory fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
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
const NIGHT = addDays(D0, 20);
const HORIZON = 21;
const iso = (ms: number) => new Date(ms).toISOString();

const ENGINES = [
  { name: "app engine", evaluateHotel: appEvaluateHotel, resetLog: appResetLog },
  { name: "edge engine", evaluateHotel: edgeEvaluateHotel, resetLog: edgeResetLog },
];

function pickupRule(
  id: string,
  condition: Partial<FakeRow> & { pickup_window_days: number },
  over: Partial<FakeRow> = {},
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
    action_direction: "increase",
    action_value: 10,
    is_pickup_rule: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    rule_condition: [{ pickup_operator: "gt", pickup_threshold: 3, pickup_metric: "room_nights", ...condition }],
    rule_signal_room_type: [{ room_type_id: STD }],
    rule_affected_room_type: [{ room_type_id: STD }],
    ...over,
  };
}

let resId = 0;
function booking(bookedOn: string, stay = NIGHT): FakeRow {
  return {
    id: `f0000000-0000-4000-8000-${String(++resId).padStart(12, "0")}`,
    hotel_id: "h1",
    stay_date: stay,
    room_type_id: STD,
    booking_date: bookedOn,
    booking_window_days: Math.round((Date.parse(stay) - Date.parse(bookedOn)) / DAY),
    current_rate: 100,
    base_rate: 100,
    created_at: `${bookedOn}T10:00:00.000Z`,
  };
}
const bookings = (n: number, bookedOn: string) => Array.from({ length: n }, () => booking(bookedOn));

/** Snapshots every 6 hours over the 10 days before T0, counted from the reservations, for the first run's baseline. */
function snapshots(reservations: FakeRow[], nights: string[]): FakeRow[] {
  const out: FakeRow[] = [];
  for (let h = 10 * 24; h > 0; h -= 6) {
    const ts = iso(T0 - h * HOUR);
    for (const stay of nights) {
      const n = reservations.filter((r) => r.stay_date === stay && `${r.booking_date}T23:59:59.000Z` <= ts).length;
      out.push({ hotel_id: "h1", snapshot_ts: ts, stay_date: stay, room_type_id: STD, sellable_units: 40, booked_units: n, booked_revenue: n * 100 });
    }
  }
  return out;
}

type Engine = (typeof ENGINES)[number];

function world(engine: Engine, opts: { rules: FakeRow[]; reservations: FakeRow[]; extra?: Record<string, FakeRow[]> }) {
  const nights = Array.from({ length: HORIZON }, (_, i) => addDays(D0, i));
  const fake = fakeSupabase({
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: [
      { id: STD, hotel_id: "h1", name: "Standard", is_active: true, total_rooms: 40, floor_price: 10, ceiling_price: 5000, counts_as_room: true },
    ],
    reservations: opts.reservations,
    base_rate_calendar: Array.from({ length: HORIZON + 20 }, (_, i) => ({
      hotel_id: "h1",
      stay_date: addDays(D0, i),
      room_type_id: STD,
      price: 100,
    })),
    pricing_rules: opts.rules,
    stay_date_snapshot: snapshots(opts.reservations, nights),
    manual_price: [],
    ...(opts.extra ?? {}),
  });
  const run = async (atMs: number) => {
    const at = iso(atMs);
    vi.setSystemTime(new Date(at));
    return engine.evaluateHotel(fake.client, "h1", at, HORIZON);
  };
  const fires = () =>
    fake.tables.pickup_event
      .filter((e) => e.stay_date === NIGHT && e.affected_room_type_id === STD)
      .sort((a, b) => String(a.applied_at).localeCompare(String(b.applied_at)));
  const firedOn = () => fires().map((e) => [e.rule_id, (Date.parse(String(e.applied_at)) - T0) / DAY]);
  const price = () =>
    Number(fake.tables.published_price.find((p) => p.stay_date === NIGHT && p.room_type_id === STD)?.price);
  /** The pickup candidate metrics the audit recorded for a fire. */
  const fireMetrics = (appliedAt: number) => {
    const row = fake.tables.evaluation_audit.find(
      (a) => a.stay_date === NIGHT && a.room_type_id === STD && a.evaluated_at === iso(appliedAt),
    );
    const details = row?.details as { pickup_candidates?: { outcome: string; metrics: Record<string, unknown> }[] } | undefined;
    return details?.pickup_candidates?.find((c) => c.outcome === "won")?.metrics;
  };
  return { ...fake, run, fires, firedOn, price, fireMetrics };
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

describe.each(ENGINES)("$name: a pickup count rule's wait", (engine) => {
  it("waits the 2 days chosen, not its 7-day window, and never raises again on the burst it raised on", async () => {
    const rule = pickupRule("r-wait2", { pickup_window_days: 7, pickup_cooldown_days: 2 });
    const w = world(engine, { rules: [rule], reservations: [...bookings(2, addDays(D0, -30)), ...bookings(5, D0)] });

    await w.run(T0);
    expect(w.firedOn()).toEqual([["r-wait2", 0]]);
    expect(w.price()).toBe(110);

    // Inside its two days: still the one raise.
    await w.run(T0 + DAY);
    expect(w.fires()).toHaveLength(1);

    // Its wait is over, and the five bookings it raised on are still inside
    // its 7-day window. They are not counted again: nothing came in since.
    await w.run(T0 + 2 * DAY);
    expect(w.fires()).toHaveLength(1);
    expect(w.price()).toBe(110);

    // Four new bookings since that raise are enough on their own.
    w.tables.reservations.push(...bookings(4, addDays(D0, 3)));
    await w.run(T0 + 3 * DAY);
    expect(w.firedOn()).toEqual([
      ["r-wait2", 0],
      ["r-wait2", 3],
    ]);
    expect(w.price()).toBe(121);
    // The second raise counted from the first: its window opened there, on
    // the seven bookings the first raise's run saw, and the audit says so.
    expect(w.fires()[1]).toMatchObject({
      baseline_start_ts: iso(T0),
      signal_booked_units_start: 7,
      signal_booked_units_end: 11,
      fire_seq: 2,
    });
    expect(w.fireMetrics(T0 + 3 * DAY)).toMatchObject({ net_pickup_units: 4, pickup_counted_since: iso(T0) });
    // The first counted its whole window.
    expect(w.fires()[0]).toMatchObject({ baseline_start_ts: iso(T0 - 7 * DAY), signal_booked_units_start: 2 });
    expect(w.fireMetrics(T0)).not.toHaveProperty("pickup_counted_since");
  }, 60_000);

  it("waits a wait longer than its window, then judges its window again", async () => {
    const rule = pickupRule("r-wait14", { pickup_window_days: 3, pickup_cooldown_days: 14 });
    const w = world(engine, { rules: [rule], reservations: bookings(5, D0) });
    await w.run(T0);
    expect(w.fires()).toHaveLength(1);

    // A second burst on day 4, past its 3-day window: it is still waiting.
    w.tables.reservations.push(...bookings(5, addDays(D0, 4)));
    for (let day = 1; day <= 11; day++) await w.run(T0 + day * DAY);
    expect(w.fires()).toHaveLength(1);

    // Fourteen days on, its 3-day window no longer reaches that burst, nor
    // the raise: only what came in during those three days counts.
    w.tables.reservations.push(...bookings(4, addDays(D0, 12)));
    for (let day = 12; day <= 13; day++) await w.run(T0 + day * DAY);
    expect(w.fires()).toHaveLength(1);
    await w.run(T0 + 14 * DAY);
    expect(w.firedOn()).toEqual([
      ["r-wait14", 0],
      ["r-wait14", 14],
    ]);
    expect(w.fires()[1]).toMatchObject({ baseline_start_ts: iso(T0 + 11 * DAY) });
    expect(w.fireMetrics(T0 + 14 * DAY)).toMatchObject({ net_pickup_units: 4 });
    expect(w.fireMetrics(T0 + 14 * DAY)).not.toHaveProperty("pickup_counted_since");
  }, 60_000);

  it("left on the lookback window, waits its window and counts it whole, as before the choice existed", async () => {
    const rule = pickupRule("r-same", { pickup_window_days: 3, pickup_cooldown_days: null });
    const w = world(engine, { rules: [rule], reservations: bookings(5, D0) });
    await w.run(T0);
    expect(w.fires()).toHaveLength(1);

    // A burst on day 2: still inside its 3-day wait.
    w.tables.reservations.push(...bookings(4, addDays(D0, 2)));
    await w.run(T0 + 2 * DAY);
    expect(w.fires()).toHaveLength(1);

    // Three days on its window opens exactly where its raise was: nothing is
    // cut, and it raises on the four that came since.
    await w.run(T0 + 3 * DAY);
    expect(w.firedOn()).toEqual([
      ["r-same", 0],
      ["r-same", 3],
    ]);
    expect(w.fires()[1]).toMatchObject({ baseline_start_ts: iso(T0), signal_booked_units_start: 5, signal_booked_units_end: 9 });
    expect(w.fireMetrics(T0 + 3 * DAY)).not.toHaveProperty("pickup_counted_since");
  }, 60_000);

  it("a weaker rule doesn't raise again on the burst a stronger rule raised on", async () => {
    // The 3-day rule changes the price more, so it is the stronger one, and
    // it raises on the burst. After that the week rule counts from that
    // raise, not over its whole week, so it doesn't raise on the same five
    // bookings.
    const quick = pickupRule("r-quick", { pickup_window_days: 3 }, { priority: 200 });
    const week = pickupRule("r-week", { pickup_window_days: 7, pickup_threshold: 4 }, { action_value: 5 });
    const w = world(engine, { rules: [quick, week], reservations: bookings(5, D0) });
    await w.run(T0);
    expect(w.firedOn()).toEqual([["r-quick", 0]]);

    // Paused that evening, so it no longer holds the night; its raise stays
    // on the night, and so the week rule still counts from it.
    w.tables.pricing_rules.find((r) => r.id === "r-quick")!.is_active = false;
    for (let day = 1; day <= 4; day++) await w.run(T0 + day * DAY);
    expect(w.firedOn()).toEqual([["r-quick", 0]]);
    expect(w.price()).toBe(110);

    // Five more on day 5 are new: the week rule raises on them.
    w.tables.reservations.push(...bookings(5, addDays(D0, 5)));
    await w.run(T0 + 5 * DAY);
    expect(w.firedOn()).toEqual([
      ["r-quick", 0],
      ["r-week", 5],
    ]);
    expect(w.fires()[1]).toMatchObject({ baseline_start_ts: iso(T0), signal_booked_units_start: 5, signal_booked_units_end: 10 });
    expect(w.price()).toBe(115.5);
  }, 60_000);
});

describe.each(ENGINES)("$name: a pickup count rule after a typed price", (engine) => {
  it("waits from the price, then judges its whole window, though a raise that came off for cancellations came before it", async () => {
    const rule = pickupRule("r-wait1", { pickup_window_days: 7, pickup_cooldown_days: 1 });
    const burst = bookings(5, D0);
    const w = world(engine, { rules: [rule], reservations: [...bookings(2, addDays(D0, -30)), ...burst] });
    await w.run(T0);
    expect(w.fires()).toHaveLength(1);

    // The burst cancels: the raise comes off for it, and still counts.
    const cancelled = new Set(burst.map((r) => r.id));
    w.tables.reservations = w.tables.reservations.filter((r) => !cancelled.has(r.id));
    await w.run(T0 + DAY);
    expect(w.fires()[0].retired_reason).toBe("bookings_cancelled");

    // A price is typed, and four bookings come in after it.
    const setAt = T0 + DAY + HOUR;
    w.tables.manual_price.push({ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: iso(setAt), cleared_at: null });
    w.tables.reservations.push(...bookings(4, addDays(D0, 1)));
    await w.run(setAt + HOUR);
    expect(w.fires()).toHaveLength(1);
    expect(w.price()).toBe(150);

    // A day after the price it counts its whole week again, not from the
    // raise before the price (whose run saw the five that cancelled).
    await w.run(setAt + DAY + HOUR);
    expect(w.fires()).toHaveLength(2);
    expect(w.fires()[1]).toMatchObject({ baseline_start_ts: iso(setAt + DAY + HOUR - 7 * DAY), signal_booked_units_start: 2 });
    expect(w.price()).toBe(165);
  }, 60_000);

  it("a raise the price took off starts nothing: after the wait it counts its whole window, on top of the price", async () => {
    const rule = pickupRule("r-wait1", { pickup_window_days: 7, pickup_cooldown_days: 1 });
    const w = world(engine, { rules: [rule], reservations: bookings(5, D0) });
    await w.run(T0);
    const setAt = T0 + HOUR;
    w.tables.manual_price.push({ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: iso(setAt), cleared_at: null });
    for (const e of w.fires()) {
      e.retired_at = iso(setAt);
      e.retired_reason = "manual_price";
    }
    await w.run(setAt + HOUR);
    expect(w.price()).toBe(150);
    await w.run(setAt + DAY + HOUR);
    expect(w.fires().map((e) => [e.fire_seq, e.retired_reason])).toEqual([
      [1, "manual_price"],
      [2, null],
    ]);
    expect(w.fires()[1]).toMatchObject({ baseline_start_ts: iso(setAt + DAY + HOUR - 7 * DAY) });
    expect(w.price()).toBe(165);
  }, 60_000);
});

describe.each(ENGINES)("$name: no snapshot where the count opens", (engine) => {
  it("leaves the rule unfired, as a window with no history does, rather than counting from an older one", async () => {
    // Every fire's own run writes a snapshot at the fire's instant, so this
    // only happens to a fire recorded some other way, or to a room type that
    // was not measured then. Here: a stronger raise rule's raise a day ago,
    // and no snapshot within 12 hours before it.
    const week = pickupRule("r-week", { pickup_window_days: 7 });
    const other = pickupRule("r-other", { pickup_window_days: 3, pickup_threshold: 100 }, { action_value: 20 });
    const raisedAt = iso(T0 - DAY);
    const w = world(engine, {
      rules: [week, other],
      reservations: bookings(5, addDays(D0, -2)),
      extra: {
        pickup_event: [
          {
            id: "e-other",
            hotel_id: "h1",
            rule_id: "r-other",
            rule_version: 1,
            stay_date: NIGHT,
            affected_room_type_id: STD,
            baseline_start_ts: iso(T0 - 4 * DAY),
            baseline_end_ts: raisedAt,
            signal_booked_units_start: 0,
            signal_booked_units_end: 5,
            signal_booked_revenue_start: 0,
            signal_booked_revenue_end: 500,
            applied_at: raisedAt,
            retired_at: null,
            retired_reason: null,
            action_kind: "percent",
            action_direction: "increase",
            action_value: 20,
            fire_seq: 1,
            cancel_check: "none",
            window_from: null,
            window_since: null,
            window_to: null,
            window_bookings_at_fire: null,
            window_expected_at_fire: null,
            signal_set_key: STD,
          },
        ],
      },
    });
    const gapFrom = T0 - 3 * DAY;
    w.tables.stay_date_snapshot = w.tables.stay_date_snapshot.filter(
      (s) => Date.parse(String(s.snapshot_ts)) <= gapFrom || Date.parse(String(s.snapshot_ts)) > T0 - DAY,
    );
    // Four new bookings since that raise would be enough: the count can't be
    // read, so the week rule doesn't fire on it.
    w.tables.reservations.push(...bookings(4, D0));
    await w.run(T0);
    expect(w.firedOn()).toEqual([["r-other", -1]]);
  }, 60_000);
});

/** A fire another rule made on NIGHT, as pickup_event keeps it. */
function otherFire(
  id: string,
  ruleId: string,
  appliedAt: string,
  direction: "increase" | "decrease",
  units: number,
  actionValue = 20,
): FakeRow {
  return {
    id,
    hotel_id: "h1",
    rule_id: ruleId,
    rule_version: 1,
    stay_date: NIGHT,
    affected_room_type_id: STD,
    baseline_start_ts: iso(Date.parse(appliedAt) - 3 * DAY),
    baseline_end_ts: appliedAt,
    signal_booked_units_start: units,
    signal_booked_units_end: units,
    signal_booked_revenue_start: units * 100,
    signal_booked_revenue_end: units * 100,
    applied_at: appliedAt,
    retired_at: null,
    retired_reason: null,
    action_kind: "percent",
    action_direction: direction,
    action_value: actionValue,
    fire_seq: 1,
    cancel_check: "none",
    window_from: null,
    window_since: null,
    window_to: null,
    window_bookings_at_fire: null,
    window_expected_at_fire: null,
    signal_set_key: STD,
  };
}

describe.each(ENGINES)("$name: a fire later than the run's clock", (engine) => {
  it("a stronger rule's raise recorded ahead of the run's clock leaves nothing to count yet, then the count runs from it", async () => {
    // A stronger raise rule's raise, recorded a minute after this run's clock
    // by an overlapping run. Counting from it there is nothing to count yet.
    const fast = pickupRule("r-fast", { pickup_window_days: 3 }, { action_value: 5 });
    const other = pickupRule("r-other", { pickup_window_days: 3, pickup_threshold: 100 }, { action_value: 10 });
    const later = iso(T0 + 60_000);
    const w = world(engine, {
      rules: [fast, other],
      reservations: bookings(4, addDays(D0, -1)),
      extra: { pickup_event: [otherFire("e-later", "r-other", later, "increase", 4, 10)] },
    });
    // Over its window the four would do, but they came before that raise.
    await w.run(T0);
    await w.run(T0 + HOUR);
    expect(w.fires().map((e) => e.rule_id)).toEqual(["r-other"]);
    // Four since that raise do.
    w.tables.reservations.push(...bookings(4, D0));
    await w.run(T0 + 2 * HOUR);
    expect(w.fires().map((e) => e.rule_id)).toEqual(["r-other", "r-fast"]);
    expect(w.fireMetrics(T0 + 2 * HOUR)).toMatchObject({ net_pickup_units: 4, pickup_counted_since: later });
  }, 60_000);
});

describe.each(ENGINES)("$name: a \"less than\" pickup rule", (engine) => {
  it("is not set off by a stronger rule's cut: it has nothing to judge until a whole window has passed it", async () => {
    // A: pickup under 6 over a day, true on a night that had its five
    // bookings three days ago, and the strongest cut. B and C: under 2 over
    // the week and under 3 over three days, both false on those five, and
    // weaker, so they count from A's cut. Counted from there they would read
    // nothing booked since, and cut one after another every run
    // (pickupJudgesShortStretch).
    const a = pickupRule(
      "r-a",
      { pickup_operator: "lt", pickup_threshold: 6, pickup_window_days: 1 },
      { action_direction: "decrease", action_value: 15 },
    );
    const b = pickupRule(
      "r-b",
      { pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 7 },
      { action_direction: "decrease", action_value: 10 },
    );
    const c = pickupRule(
      "r-c",
      { pickup_operator: "lt", pickup_threshold: 3, pickup_window_days: 3, pickup_cooldown_days: 1 },
      { action_direction: "decrease", action_value: 5 },
    );
    const w = world(engine, { rules: [a, b, c], reservations: bookings(5, addDays(D0, -3)) });
    await w.run(T0);
    expect(w.firedOn()).toEqual([["r-a", 0]]);
    expect(w.price()).toBe(85);
    for (let n = 1; n <= 3; n++) await w.run(T0 + n * 5 * 60_000);
    expect(w.firedOn()).toEqual([["r-a", 0]]);
    expect(w.price()).toBe(85);
  }, 60_000);

  it("with a wait shorter than its window, never cuts a night again before its whole window has passed its cut", async () => {
    // Under 2 over the week, waiting a day, on a night nothing books: after
    // its cut it has a whole week of nothing to judge only on day 7, so the
    // day's wait changes nothing (the builder says "low pickup holds it to 1
    // week").
    const rule = pickupRule(
      "r-slow",
      { pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 7, pickup_cooldown_days: 1 },
      { action_direction: "decrease", action_value: 5 },
    );
    const w = world(engine, { rules: [rule], reservations: [] });
    for (let day = 0; day <= 8; day++) await w.run(T0 + day * DAY);
    expect(w.firedOn()).toEqual([
      ["r-slow", 0],
      ["r-slow", 7],
    ]);
    expect(w.price()).toBe(90.25);
    // The second cut judged the whole week after the first.
    expect(w.fires()[1]).toMatchObject({ baseline_start_ts: iso(T0) });
  }, 60_000);
});

describe.each(ENGINES)("$name: a raise that came off for cancellations", (engine) => {
  it("starts no pickup count: new bookings after it are counted over the window, not netted against the ones that cancelled", async () => {
    // r-quick raises on six bookings (more than 5 in 3 days); they cancel
    // and the raise comes off.
    const quick = pickupRule("r-quick", { pickup_window_days: 3, pickup_threshold: 5 });
    const burst = bookings(6, D0);
    const w = world(engine, { rules: [quick], reservations: burst });
    await w.run(T0);
    expect(w.firedOn()).toEqual([["r-quick", 0]]);
    const cancelled = new Set(burst.map((r) => r.id));
    w.tables.reservations = w.tables.reservations.filter((r) => !cancelled.has(r.id));
    await w.run(T0 + 6 * HOUR);
    expect(w.fires()[0].retired_reason).toBe("bookings_cancelled");
    expect(w.price()).toBe(100);

    // A weaker week rule is added, and five new bookings come in the next
    // day: too few for r-quick, so it holds nothing while it waits. The week
    // rule counts its whole week: five, over its mark. Counted from that
    // raise, whose run saw the six that cancelled, it would read one less
    // than none.
    w.tables.pricing_rules.push(pickupRule("r-week", { pickup_window_days: 7 }, { action_value: 5 }));
    w.tables.reservations.push(...bookings(5, addDays(D0, 1)));
    await w.run(T0 + DAY);
    expect(w.firedOn()).toEqual([
      ["r-quick", 0],
      ["r-week", 1],
    ]);
    expect(w.fireMetrics(T0 + DAY)).toMatchObject({ net_pickup_units: 5 });
    expect(w.fireMetrics(T0 + DAY)).not.toHaveProperty("pickup_counted_since");
    expect(w.price()).toBe(105);
  }, 60_000);

  it("starts nothing in the run that takes it off either", async () => {
    // r-quick counts its 3 days: five bookings from five days ago are
    // before it, and it raises on five more. r-week (weaker) counts from
    // that raise. When the five new ones cancel, the run that takes the
    // raise off already counts r-week's whole week: the five older ones,
    // which no rule acted on.
    const quick = pickupRule("r-quick", { pickup_window_days: 3 });
    const week = pickupRule("r-week", { pickup_window_days: 7, pickup_threshold: 4 }, { action_value: 5 });
    const burst = bookings(5, D0);
    const w = world(engine, { rules: [quick, week], reservations: [...bookings(5, addDays(D0, -5)), ...burst] });
    await w.run(T0);
    expect(w.firedOn()).toEqual([["r-quick", 0]]);
    await w.run(T0 + HOUR);
    expect(w.fires()).toHaveLength(1);

    const cancelled = new Set(burst.map((r) => r.id));
    w.tables.reservations = w.tables.reservations.filter((r) => !cancelled.has(r.id));
    await w.run(T0 + 6 * HOUR);
    expect(w.fires().map((e) => [e.rule_id, e.retired_reason])).toEqual([
      ["r-quick", "bookings_cancelled"],
      ["r-week", null],
    ]);
    expect(w.fireMetrics(T0 + 6 * HOUR)).toMatchObject({ net_pickup_units: 5 });
    expect(w.fireMetrics(T0 + 6 * HOUR)).not.toHaveProperty("pickup_counted_since");
    expect(w.price()).toBe(105);
  }, 60_000);

  it("a rule's own cancelled raise doesn't hold back its next count either", async () => {
    // A day's wait and a week's window: five new bookings after the
    // cancellation raise it again once the day is up, not a week later.
    const rule = pickupRule("r-daily", { pickup_window_days: 7, pickup_cooldown_days: 1 });
    const burst = bookings(5, D0);
    const w = world(engine, { rules: [rule], reservations: burst });
    await w.run(T0);
    const cancelled = new Set(burst.map((r) => r.id));
    w.tables.reservations = w.tables.reservations.filter((r) => !cancelled.has(r.id));
    await w.run(T0 + 6 * HOUR);
    expect(w.fires()[0].retired_reason).toBe("bookings_cancelled");
    w.tables.reservations.push(...bookings(5, addDays(D0, 1)));
    await w.run(T0 + DAY + HOUR);
    expect(w.firedOn()).toEqual([
      ["r-daily", 0],
      ["r-daily", 1 + 1 / 24],
    ]);
    expect(w.price()).toBe(110);
  }, 60_000);
});

describe.each(ENGINES)("$name: a rule with a booking speed condition too", (engine) => {
  /** One booking every 10 days of lead time on every night from 400 days back: history for booking speed to compare with. */
  function history(last: string): FakeRow[] {
    const out: FakeRow[] = [];
    for (let stay = addDays(D0, -400); stay <= last; stay = addDays(stay, 1)) {
      for (let lead = 3; lead < 180; lead += 10) out.push(booking(addDays(stay, -lead), stay));
    }
    return out;
  }

  it("waits the longer of its two waits: 3 days of booking speed over the 1 day chosen for pickup", async () => {
    const rule = pickupRule("r-mixed", {
      pickup_window_days: 7,
      pickup_cooldown_days: 1,
      booking_speed_operator: "at_least",
      booking_speed_level: "stalled",
      booking_speed_window_days: 7,
      booking_speed_cooldown_days: 3,
    });
    const w = world(engine, {
      rules: [rule],
      reservations: [...history(addDays(D0, HORIZON)).filter((r) => r.booking_date! <= addDays(D0, -1)), ...bookings(5, D0)],
    });
    await w.run(T0);
    expect(w.firedOn()).toEqual([["r-mixed", 0]]);

    // Enough new pickup by day 1 for the pickup condition alone, but the
    // booking speed wait holds the rule for three days.
    w.tables.reservations.push(...bookings(4, addDays(D0, 1)));
    await w.run(T0 + DAY);
    await w.run(T0 + 2 * DAY);
    expect(w.fires()).toHaveLength(1);

    await w.run(T0 + 3 * DAY);
    expect(w.firedOn()).toEqual([
      ["r-mixed", 0],
      ["r-mixed", 3],
    ]);
    // Counted from its first raise, not over its week.
    expect(w.fireMetrics(T0 + 3 * DAY)).toMatchObject({ net_pickup_units: 4, pickup_counted_since: iso(T0) });
  }, 120_000);
});

describe.each(ENGINES)("$name: the owner alert after three raises", (engine) => {
  it("files the latest raise's pickup as counted since the raise before it, not over the window", async () => {
    const rule = pickupRule("r-daily", { pickup_window_days: 7, pickup_cooldown_days: 1 });
    const w = world(engine, { rules: [rule], reservations: bookings(5, D0) });
    await w.run(T0);
    w.tables.reservations.push(...bookings(4, addDays(D0, 1)));
    await w.run(T0 + DAY);
    w.tables.reservations.push(...bookings(6, addDays(D0, 2)));
    await w.run(T0 + 2 * DAY);
    expect(w.fires()).toHaveLength(3);
    const night = (w.tables.rule_repeat_alert_nights ?? []).find((n) => n.stay_date === NIGHT);
    // The six that came in since the second raise, not the fifteen of the week.
    expect(night).toMatchObject({ fire_count: 3, pickup_threshold: 3, pickup_window_days: null, pickup_net: 6 });
  }, 60_000);

  it("keeps the window's days when the latest raise counted its whole window", async () => {
    const rule = pickupRule("r-window", { pickup_window_days: 1 });
    const w = world(engine, { rules: [rule], reservations: bookings(5, D0) });
    await w.run(T0);
    w.tables.reservations.push(...bookings(4, addDays(D0, 1)));
    await w.run(T0 + DAY);
    w.tables.reservations.push(...bookings(6, addDays(D0, 2)));
    await w.run(T0 + 2 * DAY);
    const night = (w.tables.rule_repeat_alert_nights ?? []).find((n) => n.stay_date === NIGHT);
    expect(night).toMatchObject({ fire_count: 3, pickup_window_days: 1, pickup_net: 6 });
  }, 60_000);
});

describe.each(ENGINES)("$name: counts that open at fires, read many nights at a time", (engine) => {
  it("reads every night's own starting snapshot together, not once per night and room type, and counts the same", async () => {
    // A stronger raise rule raised each of 30 nights at a different run
    // within the week rule's window, across 6 room types. The week rule's
    // count on each night opens at that night's raise: 30 starting instants.
    const NIGHTS = 30;
    const TYPES = Array.from({ length: 6 }, (_, i) => `b0000000-0000-4000-8000-00000000000${i}`);
    const nights = Array.from({ length: NIGHTS }, (_, i) => addDays(D0, i + 1));
    const firedAt = (i: number) => iso(T0 - (2 + i) * HOUR - i * 60_000);
    const reservations: FakeRow[] = [];
    const snapshotRows: FakeRow[] = [];
    // One booking per night and room type from well before.
    for (const stay of nights) {
      for (const rt of TYPES) reservations.push({ ...booking(addDays(D0, -20), stay), room_type_id: rt });
    }
    // History for the window starts, and the snapshot each raise's run wrote
    // at its own instant, for every night and room type as a run does.
    const stamps = [
      ...Array.from({ length: 40 }, (_, k) => iso(T0 - (k + 1) * 6 * HOUR)),
      ...nights.map((_, i) => firedAt(i)),
    ];
    for (const ts of stamps) {
      for (const stay of nights) {
        for (const rt of TYPES) {
          snapshotRows.push({ hotel_id: "h1", snapshot_ts: ts, stay_date: stay, room_type_id: rt, sellable_units: 10, booked_units: 1, booked_revenue: 100 });
        }
      }
    }
    // After each raise, even nights got four more bookings in the first room type.
    nights.forEach((stay, i) => {
      if (i % 2 === 0) for (let n = 0; n < 4; n++) reservations.push({ ...booking(D0, stay), room_type_id: TYPES[0] });
    });
    const everyType = TYPES.map((room_type_id) => ({ room_type_id }));
    const week = pickupRule("r-week", { pickup_window_days: 7 }, { rule_signal_room_type: everyType, rule_affected_room_type: everyType });
    const other = pickupRule(
      "r-other",
      { pickup_window_days: 3, pickup_threshold: 1000 },
      { action_value: 20, rule_signal_room_type: everyType, rule_affected_room_type: everyType },
    );
    const raises = nights.flatMap((stay, i) =>
      TYPES.map((rt) => ({
        ...otherFire(`e-${i}-${rt.slice(-1)}`, "r-other", firedAt(i), "increase", 1),
        stay_date: stay,
        affected_room_type_id: rt,
        signal_set_key: TYPES.join(","),
      })),
    );
    const fake = fakeSupabase({
      hotels: [{ id: "h1", timezone: "UTC" }],
      room_types: TYPES.map((id, i) => ({ id, hotel_id: "h1", name: `Type ${i}`, is_active: true, total_rooms: 10, floor_price: 10, ceiling_price: 5000, counts_as_room: true })),
      reservations,
      base_rate_calendar: [...nights, D0].flatMap((stay) => TYPES.map((rt) => ({ hotel_id: "h1", stay_date: stay, room_type_id: rt, price: 100 }))),
      pricing_rules: [week, other],
      stay_date_snapshot: snapshotRows,
      manual_price: [],
      pickup_event: raises,
    });
    vi.setSystemTime(new Date(T0));
    await engine.evaluateHotel(fake.client, "h1", iso(T0), NIGHTS + 1);

    const reads = fake.calls.filter((c) => c.table === "stay_date_snapshot" && c.op === "select");
    // One read for all thirty raises' instants; none per night and room type
    // (180 of them). Tonight's own window starts are a handful of cells,
    // read one at a time as they always were.
    const atFires = reads.filter((c) => c.filters.some((f) => f.kind === "or"));
    expect(atFires).toHaveLength(1);
    const perCell = reads.filter((c) =>
      c.filters.some((f) => f.col === "stay_date" && f.kind === "eq" && nights.includes(String(f.value))),
    );
    expect(perCell).toHaveLength(0);
    // The even nights picked up four since their raise, the odd ones none.
    const weekFires = fake.tables.pickup_event.filter((e) => e.rule_id === "r-week");
    const firedNights = [...new Set(weekFires.map((e) => String(e.stay_date)))].sort();
    expect(firedNights).toEqual(nights.filter((_, i) => i % 2 === 0));
    const first = weekFires.find((e) => e.stay_date === nights[0] && e.affected_room_type_id === TYPES[0])!;
    expect(first).toMatchObject({ baseline_start_ts: firedAt(0), signal_booked_units_start: 6, signal_booked_units_end: 10 });
  }, 120_000);
});
