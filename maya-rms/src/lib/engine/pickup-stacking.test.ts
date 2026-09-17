/**
 * Whole evaluateHotel runs against the in-memory fake, for what stacking
 * changed: a rule fires again once its wait has passed, a cut is never taken
 * off by the check that undoes raises, a fire that can't move the price
 * doesn't happen, a rule waiting on a cell holds it against weaker rules, a
 * price someone typed holds every event rule for its own wait, and a rule
 * that has adjusted a night three times puts it in front of the owner.
 *
 * The first two cases are the reproductions of the bug this build fixes: a
 * "slower" cut showed for one run and then came off in the same run that made
 * it, and a "pickup less than" cut was written and taken off again every five
 * minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { resetBookingSpeedLogOnce } from "./booking-speed-provider";
import { evaluateHotel } from "./evaluate";
import { FakeRpcError, fakeSupabase, missingFunction, type FakeCall, type FakeRow } from "./fake-supabase.test";

const D0 = "2026-09-16";
const T0 = Date.parse(`${D0}T12:00:00.000Z`);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const STD = "a0000000-0000-4000-8000-0000000000a1";
const SUITE = "a0000000-0000-4000-8000-0000000000a2";
const BASE = 100;
const iso = (ms: number) => new Date(ms).toISOString();

function roomType(id: string, over: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    hotel_id: "h1",
    name: id === STD ? "Standard" : "Suite",
    is_active: true,
    total_rooms: 20,
    floor_price: 10,
    ceiling_price: 5000,
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
    action_direction: "decrease",
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

let resId = 0;
function booking(stay: string, bookedOn: string, roomTypeId = STD): FakeRow {
  const lead = Math.round((Date.parse(stay) - Date.parse(bookedOn)) / DAY);
  return {
    id: `f0000000-0000-4000-8000-${String(++resId).padStart(12, "0")}`,
    hotel_id: "h1",
    stay_date: stay,
    room_type_id: roomTypeId,
    booking_date: bookedOn,
    booking_window_days: lead,
    current_rate: BASE,
    base_rate: BASE,
    created_at: `${bookedOn}T10:00:00.000Z`,
  };
}

/** Snapshots every 6 hours over the days before T0, counted from the reservations. */
function snapshots(reservations: FakeRow[], nights: string[], roomTypeIds: string[], days: number): FakeRow[] {
  const out: FakeRow[] = [];
  for (let h = days * 24; h > 0; h -= 6) {
    const ts = iso(T0 - h * HOUR);
    for (const stay of nights) {
      for (const rt of roomTypeIds) {
        const n = reservations.filter(
          (r) => r.stay_date === stay && r.room_type_id === rt && `${r.booking_date}T23:59:59.000Z` <= ts,
        ).length;
        out.push({ hotel_id: "h1", snapshot_ts: ts, stay_date: stay, room_type_id: rt, sellable_units: 20, booked_units: n, booked_revenue: n * BASE });
      }
    }
  }
  return out;
}

type WorldOptions = {
  rules: FakeRow[];
  reservations?: FakeRow[];
  horizon?: number;
  roomTypes?: FakeRow[];
  base?: (stay: string, roomTypeId: string) => number;
  manual?: FakeRow[];
  snapshotDays?: number;
  extra?: Record<string, FakeRow[]>;
  fault?: (c: FakeCall) => { code?: string; message: string } | null;
  rpc?: (fn: string, args: unknown, tables: Record<string, FakeRow[]>) => unknown;
  beforeCall?: (c: FakeCall) => void | Promise<void>;
};

function world(opts: WorldOptions) {
  const horizon = opts.horizon ?? 12;
  const roomTypes = opts.roomTypes ?? [roomType(STD)];
  const roomTypeIds = roomTypes.map((rt) => String(rt.id));
  const nights = Array.from({ length: horizon }, (_, i) => addDays(D0, i));
  const reservations = opts.reservations ?? [];
  const base = opts.base ?? (() => BASE);
  const seed: Record<string, FakeRow[]> = {
    hotels: [{ id: "h1", timezone: "UTC" }],
    room_types: roomTypes,
    reservations,
    base_rate_calendar: nights.flatMap((stay) =>
      roomTypeIds.map((rt) => ({ hotel_id: "h1", stay_date: stay, room_type_id: rt, price: base(stay, rt) })),
    ),
    pricing_rules: opts.rules,
    stay_date_snapshot: snapshots(reservations, nights, roomTypeIds, opts.snapshotDays ?? 10),
    manual_price: opts.manual ?? [],
    ...(opts.extra ?? {}),
  };
  const fake = fakeSupabase(seed, {
    ...(opts.fault ? { fault: opts.fault } : {}),
    ...(opts.rpc ? { rpc: opts.rpc } : {}),
    ...(opts.beforeCall ? { beforeCall: opts.beforeCall } : {}),
  });
  const run = async (atMs: number) => {
    const at = iso(atMs);
    vi.setSystemTime(new Date(at));
    const result = await evaluateHotel(fake.client, "h1", at, horizon);
    return { at, ...result };
  };
  const price = (stay: string, rt = STD) =>
    Number(fake.tables.published_price.find((p) => p.stay_date === stay && p.room_type_id === rt)?.price);
  const fires = (stay: string, rt = STD) =>
    fake.tables.pickup_event.filter((e) => e.stay_date === stay && e.affected_room_type_id === rt);
  const audits = (stay: string, rt = STD) =>
    fake.tables.evaluation_audit.filter((a) => a.stay_date === stay && a.room_type_id === rt);
  return { ...fake, run, price, fires, audits, nights };
}

beforeEach(() => {
  resId = 0;
  resetBookingSpeedLogOnce();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ── The bug: a cut taken off in the run that made it ─────────── */

describe("a cut holds until the rule's wait has passed, then cuts again", () => {
  const NIGHT = addDays(D0, 9);
  /** "Pickup less than 1 room-night in 3 days -> cut 5%", the rule that used to write a row every run. */
  const thin = rule("r-thin", { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" }, { action_value: 5 });

  it("writes one fire and one audit row an hour of runs later, and cuts again three days on", async () => {
    // Bookings long before the window, so nothing is picked up in it.
    const reservations = [addDays(D0, 0), addDays(D0, 1), NIGHT].map((stay) => booking(stay, addDays(D0, -30)));
    const w = world({ rules: [thin], reservations });

    for (let k = 0; k <= 12; k++) {
      const r = await w.run(T0 + k * 5 * 60_000);
      expect(w.price(NIGHT)).toBe(95);
      expect(r.pickup_events_created).toBe(k === 0 ? w.nights.length : 0);
    }
    expect(w.fires(NIGHT)).toHaveLength(1);
    expect(w.fires(NIGHT)[0]).toMatchObject({ fire_seq: 1, retired_at: null, cancel_check: "none" });
    expect(w.audits(NIGHT)).toHaveLength(1);

    // A day short of its window: still the one cut.
    await w.run(T0 + 3 * DAY - HOUR);
    expect(w.price(NIGHT)).toBe(95);
    expect(w.fires(NIGHT)).toHaveLength(1);

    // Three days on it cuts again, on the price the first cut left.
    await w.run(T0 + 3 * DAY);
    expect(w.fires(NIGHT).map((e) => e.fire_seq)).toEqual([1, 2]);
    expect(w.price(NIGHT)).toBe(90.25);
    expect(w.audits(NIGHT)).toHaveLength(2);
  }, 60_000);

  it("never takes a cut off, whatever the bookings do", async () => {
    const reservations = [booking(NIGHT, addDays(D0, -30))];
    const w = world({ rules: [thin], reservations });
    await w.run(T0);
    expect(w.price(NIGHT)).toBe(95);
    // The night's only booking cancels: a raise would come off, a cut never does.
    w.tables.reservations = [];
    await w.run(T0 + HOUR);
    expect(w.fires(NIGHT)[0].retired_at).toBeNull();
    expect(w.price(NIGHT)).toBe(95);
  }, 60_000);
});

/* ── The same, for a rule that reads the booking pace ─────────── */

describe("a Booking Speed rule", () => {
  const HORIZON = 20;
  const NIGHT = addDays(D0, 12);

  /**
   * Three years of history at a steady pace, and future nights whose last
   * booking was made more than 20 days ago: every one of them reads slower
   * than the nights it is compared with, while still holding bookings.
   */
  function history(opts: { burst?: boolean } = {}) {
    const reservations: FakeRow[] = [];
    for (let off = -400; off < HORIZON + 30; off++) {
      const stay = addDays(D0, off);
      for (const lead of [60, 63, 66]) reservations.push(booking(stay, addDays(stay, -lead)));
      for (let i = 0; i < 10; i++) {
        const bookedOn = addDays(stay, -i * 3);
        if (off >= 0 ? bookedOn > addDays(D0, -20) : bookedOn > D0) continue;
        reservations.push(booking(stay, bookedOn));
      }
      // A burst of bookings on every future night, made 4 to 19 days ago.
      if (opts.burst && off >= 0) {
        for (let j = 0; j < 12; j++) reservations.push(booking(stay, addDays(D0, -(4 + (j % 16)))));
      }
    }
    return reservations;
  }

  it("cuts, holds the cut through its wait, then cuts again", async () => {
    const slow = rule(
      "r-slow",
      { booking_speed_operator: "at_most", booking_speed_level: "slower", booking_speed_window_days: 30 },
      { action_value: 10 },
    );
    const w = world({ rules: [slow], reservations: history(), horizon: HORIZON, snapshotDays: 3 });
    const prices: number[] = [];
    for (let k = 0; k <= 16; k++) {
      await w.run(T0 + k * 12 * HOUR);
      prices.push(w.price(NIGHT));
    }
    // One cut, held every run for the week, then a second cut on top of it.
    expect(prices.slice(0, 14)).toEqual(Array.from({ length: 14 }, () => 90));
    expect(prices[14]).toBe(81);
    expect(w.fires(NIGHT).map((e) => [e.fire_seq, e.retired_at, e.cancel_check])).toEqual([
      [1, null, "none"],
      [2, null, "none"],
    ]);
    // One row per change, not one per run.
    expect(w.audits(NIGHT)).toHaveLength(2);
  }, 120_000);

  it("holds a raise whose window still has its bookings, and takes it off when they cancel", async () => {
    const fast = rule(
      "r-fast",
      { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 30, booking_speed_cooldown_days: 3 },
      { action_direction: "increase", action_value: 10 },
    );
    const w = world({ rules: [fast], reservations: history({ burst: true }), horizon: HORIZON, snapshotDays: 3 });
    await w.run(T0);
    expect(w.price(NIGHT)).toBe(110);
    const fire = w.fires(NIGHT)[0];
    expect(fire).toMatchObject({ cancel_check: "window_bookings", window_to: D0, window_from: addDays(D0, -29) });
    expect(Number(fire.window_bookings_at_fire)).toBeGreaterThan(Number(fire.window_expected_at_fire));

    // The raise holds: nothing cancelled.
    await w.run(T0 + 12 * HOUR);
    expect(w.fires(NIGHT)[0].retired_at).toBeNull();
    expect(w.price(NIGHT)).toBe(110);

    // Enough of the window's bookings cancel to bring the night back to the
    // pace a night like it usually has.
    const window = w.tables.reservations.filter(
      (r) => r.stay_date === NIGHT && String(r.booking_date) >= addDays(D0, -29) && String(r.booking_date) <= D0,
    );
    const expected = Number(fire.window_expected_at_fire);
    const drop = new Set(window.slice(0, window.length - Math.floor(expected)).map((r) => r.id));
    w.tables.reservations = w.tables.reservations.filter((r) => !drop.has(r.id));
    await w.run(T0 + 24 * HOUR);
    expect(w.fires(NIGHT)[0].retired_reason).toBe("bookings_cancelled");
    expect(w.price(NIGHT)).toBe(100);
  }, 120_000);
});

/* ── Raises, and the cancellations that take them off ─────────── */

describe("stacked raises come off one at a time, newest first", () => {
  const NIGHT = addDays(D0, 9);
  // "Pickup more than 1 room-night in a day -> raise 10%": a day's wait.
  const surge = rule(
    "r-surge",
    { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" },
    { action_direction: "increase", action_value: 10 },
  );

  it("cancelling the second window's bookings takes the second raise off, and the first holds", async () => {
    const old = [booking(NIGHT, addDays(D0, -30))];
    const first = [booking(NIGHT, D0), booking(NIGHT, D0)];
    const w = world({ rules: [surge], reservations: [...old, ...first] });

    await w.run(T0);
    expect(w.price(NIGHT)).toBe(110);
    // Two more the next day: the rule's wait has passed, so it raises again.
    const second = [booking(NIGHT, addDays(D0, 1)), booking(NIGHT, addDays(D0, 1))];
    w.tables.reservations.push(...second);
    await w.run(T0 + DAY);
    expect(w.fires(NIGHT).map((e) => [e.fire_seq, e.signal_booked_units_start])).toEqual([
      [1, 1],
      [2, 3],
    ]);
    expect(w.price(NIGHT)).toBe(121);

    // The second window's two bookings cancel: only the second raise goes.
    const gone = new Set(second.map((b) => b.id));
    w.tables.reservations = w.tables.reservations.filter((r) => !gone.has(r.id));
    await w.run(T0 + DAY + HOUR);
    expect(w.fires(NIGHT).map((e) => [e.fire_seq, e.retired_reason])).toEqual([
      [1, null],
      [2, "bookings_cancelled"],
    ]);
    expect(w.price(NIGHT)).toBe(110);

    // The first window's two go too: the night is back to its base.
    const alsoGone = new Set(first.map((b) => b.id));
    w.tables.reservations = w.tables.reservations.filter((r) => !alsoGone.has(r.id));
    await w.run(T0 + DAY + 2 * HOUR);
    expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual(["bookings_cancelled", "bookings_cancelled"]);
    expect(w.price(NIGHT)).toBe(100);
  }, 60_000);

  it("a raise still holds its wait after cancellations take it off", async () => {
    const w = world({ rules: [surge], reservations: [booking(NIGHT, addDays(D0, -30)), booking(NIGHT, D0), booking(NIGHT, D0)] });
    await w.run(T0);
    const surged = w.tables.reservations.filter((r) => r.booking_date === D0).map((r) => r.id);
    w.tables.reservations = w.tables.reservations.filter((r) => !surged.includes(r.id));
    await w.run(T0 + HOUR);
    expect(w.fires(NIGHT)[0].retired_reason).toBe("bookings_cancelled");
    // Two new bookings the same day: the rule is still waiting out its day.
    w.tables.reservations.push(booking(NIGHT, D0), booking(NIGHT, D0));
    await w.run(T0 + 2 * HOUR);
    expect(w.fires(NIGHT)).toHaveLength(1);
    expect(w.price(NIGHT)).toBe(100);
  }, 60_000);
});

/* ── Floors and ceilings ──────────────────────────────────────── */

describe("a fire that can't move the price doesn't happen", () => {
  const NIGHT = addDays(D0, 9);
  const thin = rule("r-thin", { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" }, { action_value: 50 });

  it("cuts stop at the floor, and start again when the floor is lowered", async () => {
    const w = world({ rules: [thin], roomTypes: [roomType(STD, { floor_price: 50 })], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    expect(w.price(NIGHT)).toBe(50);
    expect(w.fires(NIGHT)).toHaveLength(1);
    // A day later the cut would change nothing: the price is at the floor.
    await w.run(T0 + DAY);
    expect(w.fires(NIGHT)).toHaveLength(1);
    expect(w.audits(NIGHT)).toHaveLength(1);

    // The owner lowers the floor: the next run cuts again from the price it left.
    w.tables.room_types[0].floor_price = 10;
    await w.run(T0 + 2 * DAY);
    expect(w.fires(NIGHT).map((e) => e.fire_seq)).toEqual([1, 2]);
    expect(w.price(NIGHT)).toBe(25);
  }, 60_000);

  it("a raise at the ceiling doesn't fire, and a cut on the same night still does", async () => {
    const raise = rule(
      "r-raise",
      { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" },
      { action_direction: "increase", action_value: 10, priority: 200 },
    );
    const w = world({
      rules: [raise],
      roomTypes: [roomType(STD, { ceiling_price: 100 })],
      reservations: [booking(NIGHT, addDays(D0, -30)), booking(NIGHT, D0), booking(NIGHT, D0)],
    });
    await w.run(T0);
    expect(w.fires(NIGHT)).toHaveLength(0);
    expect(w.price(NIGHT)).toBe(100);
    // Room to move again: it fires.
    w.tables.room_types[0].ceiling_price = 200;
    await w.run(T0 + HOUR);
    expect(w.fires(NIGHT)).toHaveLength(1);
    expect(w.price(NIGHT)).toBe(110);
  }, 60_000);

  it("a percent raise on a comp night typed as 0 never fires, however long it runs", async () => {
    // 0 is a real price someone set, so the night is published and no ceiling
    // is in the way. A percent of 0 is still 0, so the raise would fire on
    // every wait for ever without the night ever moving.
    const raise = rule(
      "r-comp-raise",
      { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" },
      { action_direction: "increase", action_value: 10 },
    );
    const w = world({
      rules: [raise],
      reservations: [booking(NIGHT, addDays(D0, -30))],
      manual: [{ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 0, set_by: "u1", set_at: iso(T0 - 2 * DAY), cleared_at: null }],
    });
    for (let day = 0; day <= 4; day++) await w.run(T0 + day * DAY);
    expect(w.fires(NIGHT)).toHaveLength(0);
    expect(w.audits(NIGHT)).toHaveLength(1);
    expect(w.price(NIGHT)).toBe(0);
    // The rule is doing its job everywhere else.
    expect(w.fires(addDays(D0, 8)).length).toBeGreaterThan(1);
  }, 60_000);

  it("a fixed raise never walks a comp night typed as 0 up, and says why in the audit", async () => {
    // 0 is the owner giving the night away. A fixed amount moves it every
    // time, so neither the ceiling nor "does this change the price?" stops
    // it: 0, then 20, then 40, and the owner reads that a night they comped
    // is being sold. No event rule raises a comp night.
    const raise = rule(
      "r-comp-fixed",
      { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" },
      { action_type: "fixed", action_direction: "increase", action_value: 20 },
    );
    const w = world({
      rules: [raise],
      reservations: [booking(NIGHT, addDays(D0, -30))],
      manual: [{ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 0, set_by: "u1", set_at: iso(T0 - 2 * DAY), cleared_at: null }],
    });
    for (let day = 0; day <= 4; day++) await w.run(T0 + day * DAY);

    expect(w.fires(NIGHT)).toHaveLength(0);
    expect(w.price(NIGHT)).toBe(0);
    // Nothing about it reached the owner either, though the rule has stacked
    // its way to an alert on the nights it really is adjusting.
    expect((w.tables.rule_repeat_alert_nights ?? []).filter((n) => n.stay_date === NIGHT)).toHaveLength(0);
    // The audit says it was the comp night, not a limit.
    const candidates = w.audits(NIGHT).flatMap(
      (a) => (a.details as { pickup_candidates: { rule_id: string; outcome: string; tie_break_trace: string[] }[] }).pickup_candidates,
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({ rule_id: "r-comp-fixed", outcome: "comp_night", tie_break_trace: ["manual_price_zero"] }),
    );
    // The rule is doing its job everywhere else.
    expect(w.fires(addDays(D0, 8)).length).toBeGreaterThan(1);
  }, 60_000);

  it("a night the run leaves unpriced gets no fire", async () => {
    // The hotel has the night at 0 in its own calendar: MAYA does not price it.
    const w = world({
      rules: [thin],
      reservations: [booking(NIGHT, addDays(D0, -30))],
      base: (stay) => (stay === NIGHT ? 0 : BASE),
    });
    await w.run(T0);
    expect(w.fires(NIGHT)).toHaveLength(0);
    expect(w.fires(addDays(D0, 0))).toHaveLength(1);
  }, 60_000);
});

/* ── Which rule fires while another waits ─────────────────────── */

describe("a rule waiting on a cell holds it", () => {
  const NIGHT = addDays(D0, 9);
  const cond = { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" };
  const strong = rule("r-strong", { ...cond }, { priority: 200, action_value: 15 });
  const weak = rule("r-weak", { ...cond, pickup_window_days: 1 }, { priority: 100, action_value: 5 });

  it("nothing fires under it, and it fires again itself once its wait has passed", async () => {
    const w = world({ rules: [strong, weak], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    expect(w.fires(NIGHT).map((e) => e.rule_id)).toEqual(["r-strong"]);
    expect(w.price(NIGHT)).toBe(85);

    // A day on, the weak rule's own wait has passed but the strong rule is
    // still waiting and still matches: nothing fires.
    await w.run(T0 + DAY);
    expect(w.fires(NIGHT)).toHaveLength(1);
    expect(w.price(NIGHT)).toBe(85);
    // Nothing changed on the cell, so there is nothing new to record either.
    expect(w.audits(NIGHT)).toHaveLength(1);

    // Three days on, the strong rule cuts again.
    await w.run(T0 + 3 * DAY);
    expect(w.fires(NIGHT).map((e) => [e.rule_id, e.fire_seq])).toEqual([
      ["r-strong", 1],
      ["r-strong", 2],
    ]);
    expect(w.price(NIGHT)).toBe(72.25);
  }, 60_000);

  it("a stronger rule fires while a weaker one waits", async () => {
    const w = world({ rules: [weak], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    expect(w.fires(NIGHT).map((e) => e.rule_id)).toEqual(["r-weak"]);
    // The stronger rule is switched on and fires at once, on the weak rule's price.
    w.tables.pricing_rules.push({ ...strong });
    await w.run(T0 + HOUR);
    expect(w.fires(NIGHT).map((e) => e.rule_id)).toEqual(["r-weak", "r-strong"]);
    expect(w.price(NIGHT)).toBe(80.75);
  }, 60_000);

  it("the wait is per room type: a rule that lost one room fires there next run", async () => {
    const both = rule("r-both", { ...cond }, {
      priority: 100,
      action_value: 5,
      rule_signal_room_type: [{ room_type_id: STD }],
      rule_affected_room_type: [{ room_type_id: STD }, { room_type_id: SUITE }],
    });
    const suiteOnly = rule("r-suite", { ...cond }, {
      priority: 200,
      action_value: 20,
      rule_signal_room_type: [{ room_type_id: STD }],
      rule_affected_room_type: [{ room_type_id: SUITE }],
    });
    const w = world({
      rules: [both, suiteOnly],
      roomTypes: [roomType(STD), roomType(SUITE)],
      reservations: [booking(NIGHT, addDays(D0, -30))],
    });
    await w.run(T0);
    expect(w.fires(NIGHT, STD).map((e) => e.rule_id)).toEqual(["r-both"]);
    expect(w.fires(NIGHT, SUITE).map((e) => e.rule_id)).toEqual(["r-suite"]);

    // The Suite is the only cell r-both has not fired on: it fires there next
    // run, while it waits on the Standard.
    w.tables.pricing_rules = w.tables.pricing_rules.filter((r) => r.id !== "r-suite");
    await w.run(T0 + HOUR);
    expect(w.fires(NIGHT, STD)).toHaveLength(1);
    expect(w.fires(NIGHT, SUITE).map((e) => e.rule_id)).toEqual(["r-suite", "r-both"]);
  }, 60_000);
});

/* ── A price someone typed ────────────────────────────────────── */

describe("after a price someone typed", () => {
  const NIGHT = addDays(D0, 9);
  const thin = rule("r-thin", { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" }, { action_value: 10 });

  it("every event rule waits its own wait from the price, then stacks on it", async () => {
    const w = world({ rules: [thin], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    await w.run(T0 + 3 * DAY);
    expect(w.fires(NIGHT)).toHaveLength(2);
    expect(w.price(NIGHT)).toBe(81);

    // Someone types 150 for the night: the fires come off with the reason,
    // and the typed number is what goes out.
    const setAt = iso(T0 + 3 * DAY + HOUR);
    w.tables.manual_price.push({ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: setAt, cleared_at: null });
    for (const e of w.tables.pickup_event.filter((x) => x.stay_date === NIGHT)) {
      e.retired_at = setAt;
      e.retired_reason = "manual_price";
    }
    await w.run(T0 + 3 * DAY + 2 * HOUR);
    expect(w.price(NIGHT)).toBe(150);
    expect(w.fires(NIGHT)).toHaveLength(2);

    // Still held two days later, though its window is long past its last fire.
    await w.run(T0 + 5 * DAY);
    expect(w.fires(NIGHT)).toHaveLength(2);
    expect(w.price(NIGHT)).toBe(150);

    // Three days after the price was typed it cuts again, on the typed number.
    await w.run(T0 + 6 * DAY + 2 * HOUR);
    expect(w.fires(NIGHT).map((e) => e.fire_seq)).toEqual([1, 2, 3]);
    expect(w.price(NIGHT)).toBe(135);
  }, 60_000);

  it("a rule made after the price was typed is not held by it", async () => {
    const setAt = iso(T0 - HOUR);
    const later = rule("r-later", { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" }, {
      action_value: 10,
      created_at: iso(T0 - 60_000),
    });
    const w = world({
      rules: [later],
      reservations: [booking(NIGHT, addDays(D0, -30))],
      manual: [{ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: setAt, cleared_at: null }],
    });
    await w.run(T0);
    expect(w.fires(NIGHT)).toHaveLength(1);
    expect(w.price(NIGHT)).toBe(135);
  }, 60_000);

  it("takes a fire made by a run that was already under way off the typed cell", async () => {
    const w = world({ rules: [thin], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    // The price was typed a minute after that run started: its fire predates it.
    const setAt = iso(T0 + 60_000);
    w.tables.manual_price.push({ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: setAt, cleared_at: null });
    await w.run(T0 + 2 * 60_000);
    expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual(["manual_price"]);
    expect(w.price(NIGHT)).toBe(150);
  }, 60_000);
});

/* ── Editing, pausing and nights that pass ────────────────────── */

describe("an edited rule starts fresh", () => {
  const NIGHT = addDays(D0, 9);
  const thin = rule("r-thin", { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" }, { action_value: 10 });

  it("takes the old version's fires off and fires again on the next run", async () => {
    const w = world({ rules: [thin], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    expect(w.price(NIGHT)).toBe(90);
    // An edit the app made without taking its fires off (a failed write, or a
    // run that raced it).
    w.tables.pricing_rules[0].version = 2;
    await w.run(T0 + HOUR);
    expect(w.fires(NIGHT).map((e) => [e.rule_version, e.retired_reason])).toEqual([
      [1, "rule_edited"],
      [2, null],
    ]);
    expect(w.price(NIGHT)).toBe(90);
  }, 60_000);

  it("takes every fire on a night that is over off, and prices nothing there", async () => {
    const w = world({ rules: [thin], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    // Ten days on, the night is behind the hotel.
    await w.run(T0 + 10 * DAY);
    expect(w.fires(NIGHT).map((e) => e.retired_reason)).toEqual(["night_passed"]);
  }, 60_000);

  it("a paused rule's fires keep applying and are never tested while it is paused", async () => {
    const surge = rule(
      "r-surge",
      { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" },
      { action_direction: "increase", action_value: 10 },
    );
    const w = world({ rules: [surge], reservations: [booking(NIGHT, addDays(D0, -30)), booking(NIGHT, D0), booking(NIGHT, D0)] });
    await w.run(T0);
    expect(w.price(NIGHT)).toBe(110);
    // Paused, and every booking behind the raise cancels.
    w.tables.pricing_rules[0].is_active = false;
    w.tables.reservations = w.tables.reservations.filter((r) => r.booking_date !== D0);
    await w.run(T0 + HOUR);
    expect(w.fires(NIGHT)[0].retired_at).toBeNull();
    expect(w.price(NIGHT)).toBe(110);
    // Switched on again: the first run after tests it.
    w.tables.pricing_rules[0].is_active = true;
    await w.run(T0 + 2 * HOUR);
    expect(w.fires(NIGHT)[0].retired_reason).toBe("bookings_cancelled");
    expect(w.price(NIGHT)).toBe(100);
  }, 60_000);
});

/* ── Three adjustments on one night ───────────────────────────── */

describe("a rule that keeps adjusting the same night", () => {
  const NIGHT = addDays(D0, 9);
  const daily = rule("r-daily", { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights" }, { action_value: 5 });
  const start = (w: ReturnType<typeof world>) => w.tables;

  const alertFor = (tables: Record<string, FakeRow[]>, night = NIGHT) =>
    (tables.rule_repeat_alert_nights ?? []).find((n) => n.stay_date === night);

  it("puts the night in front of the owner at its third fire, with the numbers behind it", async () => {
    const w = world({ rules: [daily], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    await w.run(T0 + DAY);
    expect(start(w).rule_repeat_alerts ?? []).toHaveLength(0);

    await w.run(T0 + 2 * DAY);
    const alerts = start(w).rule_repeat_alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule_id: "r-daily", rule_version: 1, action_direction: "decrease", resolved_at: null });
    const night = alertFor(start(w))!;
    expect(night).toMatchObject({
      fire_count: 3,
      choice: null,
      closed_at: null,
      pickup_metric: "room_nights",
      pickup_threshold: 1,
      pickup_window_days: 1,
      pickup_net: 0,
      window_days: null,
    });
    expect(night.room_types).toEqual([
      { room_type_id: STD, fires: 3, limit: 10, limit_is_default: false, price: 85.74 },
    ]);
    // One alert for the rule, with every night that reached three under it.
    expect(new Set((start(w).rule_repeat_alert_nights ?? []).map((n) => n.alert_id)).size).toBe(1);

    // It keeps firing, and the night's row follows it.
    await w.run(T0 + 3 * DAY);
    expect(alertFor(start(w))).toMatchObject({ fire_count: 4, last_fire_at: iso(T0 + 3 * DAY) });
    expect(w.fires(NIGHT)).toHaveLength(4);
  }, 120_000);

  it("files a night whose three fires are already on record, even on a run that fires nothing", async () => {
    // What happens after a run under a signed-in session, which may not write
    // the alert: the fires are the record, so the next scheduled run files it.
    const fires = [1, 2, 3].map((seq) => ({
      id: `e${seq}`,
      hotel_id: "h1",
      rule_id: "r-daily",
      rule_version: 1,
      stay_date: NIGHT,
      affected_room_type_id: STD,
      baseline_start_ts: iso(T0 - (4 - seq) * DAY - 12 * HOUR),
      baseline_end_ts: iso(T0 - (3 - seq) * DAY - 12 * HOUR),
      signal_booked_units_start: 1,
      signal_booked_units_end: 1,
      signal_booked_revenue_start: 100,
      signal_booked_revenue_end: 100,
      applied_at: iso(T0 - (3 - seq) * DAY - 12 * HOUR),
      retired_at: null,
      retired_reason: null,
      action_kind: "percent",
      action_direction: "decrease",
      action_value: 5,
      fire_seq: seq,
      cancel_check: "none",
      window_from: null,
      window_to: null,
      window_bookings_at_fire: null,
      window_expected_at_fire: null,
      signal_set_key: STD,
    }));
    const w = world({ rules: [daily], reservations: [booking(NIGHT, addDays(D0, -30))], extra: { pickup_event: fires } });
    // Its wait has not passed, so this run fires nothing on that night.
    const r = await w.run(T0);
    expect(w.fires(NIGHT)).toHaveLength(3);
    expect(r.pickup_events_created).toBe(w.nights.length - 1);
    expect(alertFor(start(w))).toMatchObject({ fire_count: 3, last_fire_at: iso(T0 - 12 * HOUR) });
  }, 120_000);

  it("stops firing on a night the owner stopped, and keeps going on the others", async () => {
    const w = world({ rules: [daily], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    await w.run(T0 + DAY);
    await w.run(T0 + 2 * DAY);
    const night = alertFor(start(w))!;
    night.choice = "stop";
    night.chosen_at = iso(T0 + 2 * DAY + HOUR);

    const other = addDays(D0, 8);
    await w.run(T0 + 3 * DAY);
    expect(w.fires(NIGHT)).toHaveLength(3);
    expect(w.fires(other)).toHaveLength(4);
    // The price the rule already set stays where it was.
    expect(w.price(NIGHT)).toBe(85.74);
  }, 120_000);

  it("says nothing more about a night the owner told it to keep adjusting", async () => {
    const w = world({ rules: [daily], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    await w.run(T0 + DAY);
    await w.run(T0 + 2 * DAY);
    const night = alertFor(start(w))!;
    night.choice = "keep_adjusting";
    night.chosen_at = iso(T0 + 2 * DAY + HOUR);

    await w.run(T0 + 3 * DAY);
    expect(w.fires(NIGHT)).toHaveLength(4);
    expect(alertFor(start(w))).toMatchObject({ fire_count: 3, choice: "keep_adjusting" });
  }, 120_000);

  it("closes a night nobody answered once a price is set for it, and one whose rule was edited", async () => {
    const w = world({ rules: [daily], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    await w.run(T0 + DAY);
    await w.run(T0 + 2 * DAY);
    const other = addDays(D0, 8);
    expect((start(w).rule_repeat_alert_nights ?? []).length).toBeGreaterThan(1);

    // Someone types a price for the night: its fires come off, so its count
    // falls under three and the night stops waiting on an answer.
    const setAt = iso(T0 + 2 * DAY + HOUR);
    w.tables.manual_price.push({ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: setAt, cleared_at: null });
    for (const e of w.tables.pickup_event.filter((x) => x.stay_date === NIGHT)) {
      e.retired_at = setAt;
      e.retired_reason = "manual_price";
    }
    await w.run(T0 + 2 * DAY + 2 * HOUR);
    expect(alertFor(start(w))).toMatchObject({ closed_reason: "price_set", choice: null });
    expect(alertFor(start(w), other)).toMatchObject({ closed_at: null, choice: null });

    // The rule is edited: every night still waiting on an answer closes with it.
    w.tables.pricing_rules[0].version = 2;

    await w.run(T0 + 2 * DAY + 3 * HOUR);
    expect((start(w).rule_repeat_alert_nights ?? []).every((n) => n.closed_at != null)).toBe(true);
    expect(start(w).rule_repeat_alerts[0]).toMatchObject({ resolution: "closed" });
    expect(start(w).rule_repeat_alerts[0].resolved_at).not.toBeNull();
  }, 120_000);

  it("asks again when the rule stacks its way back to three on a night a price closed", async () => {
    const w = world({ rules: [daily], reservations: [booking(NIGHT, addDays(D0, -30))] });
    await w.run(T0);
    await w.run(T0 + DAY);
    await w.run(T0 + 2 * DAY);
    expect(alertFor(start(w))).toMatchObject({ fire_count: 3, choice: null, closed_at: null });

    const setAt = iso(T0 + 2 * DAY + HOUR);
    w.tables.manual_price.push({ hotel_id: "h1", stay_date: NIGHT, room_type_id: STD, price: 150, set_by: "u1", set_at: setAt, cleared_at: null });
    for (const e of w.tables.pickup_event.filter((x) => x.stay_date === NIGHT)) {
      e.retired_at = setAt;
      e.retired_reason = "manual_price";
    }
    await w.run(T0 + 2 * DAY + 2 * HOUR);
    expect(alertFor(start(w))).toMatchObject({ closed_reason: "price_set", choice: null });

    // The wait runs from the price; after it the rule cuts the typed number
    // the same way. Three cuts on and the night is in front of the owner
    // again, on the row it was filed under.
    await w.run(T0 + 3 * DAY + 2 * HOUR);
    await w.run(T0 + 4 * DAY + 2 * HOUR);
    expect(alertFor(start(w))).toMatchObject({ closed_reason: "price_set" });
    await w.run(T0 + 5 * DAY + 2 * HOUR);

    expect(w.fires(NIGHT).filter((e) => e.retired_at === null)).toHaveLength(3);
    expect(alertFor(start(w))).toMatchObject({
      fire_count: 3,
      choice: null,
      closed_at: null,
      closed_reason: null,
      reached_at: iso(T0 + 5 * DAY + 2 * HOUR),
    });
    expect((start(w).rule_repeat_alert_nights ?? []).filter((n) => n.stay_date === NIGHT)).toHaveLength(1);
    const alertId = alertFor(start(w))!.alert_id;
    expect(start(w).rule_repeat_alerts.find((a) => a.id === alertId)).toMatchObject({ resolved_at: null });
  }, 120_000);
});

/* ── Two runs at once ─────────────────────────────────────────── */

describe("two runs recording the same fire", () => {
  const NIGHT = addDays(D0, 9);
  const thin = rule("r-thin", { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" }, { action_value: 10 });

  it("only one is written, and the other prices the night with it", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldOnce = false;
    let inserted = false;
    const w = world({
      rules: [thin],
      reservations: [booking(NIGHT, addDays(D0, -30))],
      beforeCall: (c) => {
        // Hold the first run on the read that follows the fire history,
        // until the second run has written its fires: both decided to fire
        // from the same history.
        if (c.table === "rule_repeat_alert_nights" && c.op === "select" && !heldOnce) {
          heldOnce = true;
          return held;
        }
        if (c.table === "pickup_event" && c.op === "insert" && !inserted) {
          inserted = true;
          setTimeout(() => release?.(), 0);
        }
        return undefined;
      },
    });
    vi.setSystemTime(new Date(iso(T0)));
    const [a, b] = await Promise.all([
      evaluateHotel(w.client, "h1", iso(T0), w.nights.length),
      evaluateHotel(w.client, "h1", iso(T0 + 60_000), w.nights.length),
    ]);

    expect(w.fires(NIGHT)).toHaveLength(1);
    expect(w.fires(NIGHT)[0].fire_seq).toBe(1);
    // The run that lost the race counted no fire of its own.
    expect([a.pickup_events_created, b.pickup_events_created].sort((x, y) => x - y)).toEqual([0, w.nights.length]);
    // Both published the cut the one fire makes.
    expect(w.price(NIGHT)).toBe(90);
    // Every night of the horizon has exactly one fire, and one audit row
    // recording it: the run that lost the race wrote nothing, and its own
    // price matched, so it had nothing new to record either.
    for (const night of w.nights) {
      expect(w.fires(night)).toHaveLength(1);
      expect(w.price(night)).toBe(90);
      expect(w.audits(night)).toHaveLength(1);
    }
  }, 60_000);
});

/* ── No fire history, no run ──────────────────────────────────── */

describe("before the migration", () => {
  it("stops rather than treating every night as unfired", async () => {
    const thin = rule("r-thin", { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "room_nights" });
    const w = world({
      rules: [thin],
      reservations: [booking(addDays(D0, 1), addDays(D0, -30))],
      rpc: (fn) => (fn === "pickup_fire_heads" ? new FakeRpcError(missingFunction(fn)) : undefined),
    });
    await expect(w.run(T0)).rejects.toThrow(/rule fire history/);
    expect(w.tables.pickup_event).toHaveLength(0);
  }, 60_000);
});
