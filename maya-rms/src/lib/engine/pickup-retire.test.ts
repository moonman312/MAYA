/**
 * Which open fires a run takes off before anything fires, and why: a fire
 * older than the price someone set on its cell, a fire of a rule version
 * that has been edited away, and a fire whose rule cancellations have made
 * no longer true, when its rule's box is ticked (the one cancellation check,
 * cancellationsUndo). A fire this run made is never taken off by the run
 * that made it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import type { EngineRule } from "@/types/domain";
import { indexBookingRows, type SlimReservationRow } from "@/lib/observations/booking-rows";
import { detectSeasons } from "@/lib/observations/seasons";
import {
  bookingKeysOnNight,
  resetBookingSpeedLogOnce,
  signalSetKey,
  splitKey,
  windowBookingKeys,
  type BookingSpeedContext,
  type NightBookingRow,
} from "./booking-speed-provider";
import { evaluateHotel } from "./evaluate";
import { fakeSupabase as sharedFake, type FakeRow } from "./fake-supabase.test";
import {
  cancellablePartsHold,
  cancellationChecks,
  cancellationFinding,
  cancellationReads,
  cancellationsUndo,
  firesCancelled,
  firesToReset,
  loadOpenPickupFires,
  recountReads,
  retireFires,
  retirePassedNights,
  somethingCancelled,
  type CancellationInput,
  type OpenPickupFire,
} from "./pickup";
import { bookedBeforeKey, type BookedCount } from "./snapshots";
import type { RuleMetrics } from "./types";

const NOW = "2026-08-01T12:00:00.000Z";
const NIGHT = "2026-09-01";
const FIRED = "2026-07-25T12:00:00.000Z";
const OPENED = "2026-07-18T12:00:00.000Z";

function rule(over: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "r1",
    version: 1,
    action_direction: "increase",
    signal_room_type_ids: ["rt1"],
    affected_room_type_ids: ["rt1"],
    condition: { pickup_operator: "gt", pickup_threshold: 4, pickup_window_days: 7, pickup_metric: "room_nights" },
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  } as unknown as EngineRule;
}

/** A pickup raise that opened its count at 1 booked and fired at 6: 5 came in, net 5. */
function fire(over: Partial<OpenPickupFire> = {}): OpenPickupFire {
  return {
    id: "e1",
    rule_id: "r1",
    rule_version: 1,
    stay_date: NIGHT,
    affected_room_type_id: "rt1",
    applied_at: FIRED,
    counted_at: over.counted_at ?? over.applied_at ?? FIRED,
    fire_seq: 1,
    action_kind: "percent",
    action_direction: "increase",
    action_value: 10,
    cancel_check: "recount",
    baseline_start_ts: OPENED,
    signal_booked_units_start: 1,
    signal_booked_units_end: 6,
    signal_booked_revenue_start: 100,
    signal_booked_revenue_end: 600,
    pickup_units_arrived_at_fire: 5,
    pickup_revenue_arrived_at_fire: 500,
    window_from: null,
    window_since: null,
    window_to: null,
    window_bookings_at_fire: null,
    window_expected_at_fire: null,
    window_booking_keys: null,
    signal_set_key: "rt1",
    ...over,
  };
}

/** What loadBookedBefore would say: per instant, room nights (at 100 each) first seen by then and still booked. */
function booked(counts: Record<string, Record<string, number>>, stayDate = NIGHT): Map<string, Map<string, BookedCount>> {
  const out = new Map<string, Map<string, BookedCount>>();
  for (const [at, byType] of Object.entries(counts)) {
    out.set(
      bookedBeforeKey(stayDate, at),
      new Map(Object.entries(byType).map(([rt, units]) => [rt, { units, revenue: units * 100 }])),
    );
  }
  return out;
}

function input(over: Partial<CancellationInput> = {}): CancellationInput {
  return {
    booked: booked({ [FIRED]: { rt1: 6 }, [OPENED]: { rt1: 1 } }),
    occupancyNow: () => 0.5,
    bsCtx: null,
    ...over,
  };
}

const none = new Map<string, string>();

describe("what a typed price or an edit takes off first (firesToReset)", () => {
  const manual = new Map([[`${NIGHT}|rt1`, "2026-07-28T00:00:00Z"]]);
  const edited = new Map([["r1", rule({ version: 2 })]]);

  it("names only the fires a typed price or an edit takes off", () => {
    expect(firesToReset([fire()], { rules: new Map([["r1", rule()]]), manualSetAtByCell: manual, now: NOW })).toEqual(
      new Map([["e1", "manual_price"]]),
    );
    expect(firesToReset([fire()], { rules: edited, manualSetAtByCell: none, now: NOW })).toEqual(new Map([["e1", "rule_edited"]]));
    // Cancellations are the check's to judge.
    expect(firesToReset([fire()], { rules: new Map([["r1", rule()]]), manualSetAtByCell: none, now: NOW }).size).toBe(0);
    // A fire this run made is never taken off, and one made after the price stays.
    expect(firesToReset([fire({ applied_at: NOW })], { rules: edited, manualSetAtByCell: manual, now: NOW }).size).toBe(0);
    expect(
      firesToReset([fire({ applied_at: "2026-07-29T00:00:00Z" })], { rules: new Map([["r1", rule()]]), manualSetAtByCell: manual, now: NOW }).size,
    ).toBe(0);
  });
});

describe("which fires the cancellation check looks at (cancellationChecks)", () => {
  const rules = (r: EngineRule) => new Map([["r1", r]]);

  it("the open fires of a ticked rule's current version, made before this run, on the room types it measured", () => {
    expect(cancellationChecks([fire()], rules(rule()), NOW)).toHaveLength(1);
    // Ticked is the default: a rule that never said is ticked.
    expect(cancellationChecks([fire()], rules(rule({ undo_on_cancellation: true })), NOW)).toHaveLength(1);
    expect(cancellationChecks([fire({ applied_at: NOW })], rules(rule()), NOW)).toHaveLength(0);
    expect(cancellationChecks([fire()], rules(rule({ version: 2 })), NOW)).toHaveLength(0);
    expect(cancellationChecks([fire()], new Map(), NOW)).toHaveLength(0);
    expect(cancellationChecks([fire()], rules(rule({ signal_room_type_ids: [] })), NOW)).toHaveLength(0);
    expect(cancellationChecks([fire()], rules(rule({ signal_room_type_ids: ["rt1", "rt2"] })), NOW)).toHaveLength(0);
  });

  it("never an unticked rule's, raise or cut", () => {
    expect(cancellationChecks([fire()], rules(rule({ undo_on_cancellation: false })), NOW)).toHaveLength(0);
    const cut = rule({
      action_direction: "decrease",
      undo_on_cancellation: false,
      condition: { occupancy_operator: "gt", occupancy_threshold: 0.2 },
    });
    expect(cancellationChecks([fire({ action_direction: "decrease" })], rules(cut), NOW)).toHaveLength(0);
  });

  it("never one whose rule only has conditions cancellations can't make false", () => {
    const slowCut = rule({
      action_direction: "decrease",
      condition: { booking_speed_operator: "at_most", booking_speed_level: "much_slower", booking_speed_window_days: 30 },
    });
    expect(cancellationChecks([fire({ action_direction: "decrease" })], rules(slowCut), NOW)).toHaveLength(0);
    const lowPickup = rule({ condition: { pickup_operator: "lt", pickup_threshold: 2, pickup_window_days: 7 } });
    expect(cancellationChecks([fire()], rules(lowPickup), NOW)).toHaveLength(0);
  });

  it("first reads each fire's own instant and the instant a pickup count opened, nothing more", () => {
    const speed = rule({ condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7 } });
    expect(cancellationReads([{ fire: fire(), rule: rule() }])).toEqual([
      { stayDate: NIGHT, at: FIRED },
      { stayDate: NIGHT, at: OPENED },
    ]);
    expect(cancellationReads([{ fire: fire(), rule: speed }])).toEqual([{ stayDate: NIGHT, at: FIRED }]);
    // A change whose numbers were taken again reads from then.
    expect(cancellationReads([{ fire: fire({ counted_at: "2026-07-28T09:00:00.000Z" }), rule: speed }])).toEqual([
      { stayDate: NIGHT, at: "2026-07-28T09:00:00.000Z" },
    ]);
  });

  it("reads a booking speed window again only once something the change saw has cancelled", () => {
    const speed = rule({ condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7 } });
    const f = fire({
      window_from: "2026-07-19",
      window_since: "2026-07-19T08:00:00.000Z",
      window_to: "2026-07-25",
      window_bookings_at_fire: 6,
      window_expected_at_fire: 2,
    });
    // Everything the change saw (6 room nights) is still booked: nothing more is read.
    expect(somethingCancelled(f, speed, booked({ [FIRED]: { rt1: 6 } }))).toBe(false);
    expect(somethingCancelled(f, speed, booked({ [FIRED]: { rt1: 5 } }))).toBe(true);
    // A night this run did not read says nothing.
    expect(somethingCancelled(f, speed, new Map())).toBe(false);
    // Then, without the bookings' keys, the window's bookings first seen after the change and after window_since.
    expect(recountReads([{ fire: f, rule: speed }])).toEqual({
      nights: [],
      splits: [
        { since: FIRED, stayDate: NIGHT, signalIds: ["rt1"] },
        { since: "2026-07-19T08:00:00.000Z", stayDate: NIGHT, signalIds: ["rt1"] },
      ],
    });
    // With them, the night's bookings now.
    expect(recountReads([{ fire: { ...f, window_booking_keys: ["700000001"] }, rule: speed }])).toEqual({
      nights: [NIGHT],
      splits: [],
    });
    // A pickup count needs nothing more.
    expect(recountReads([{ fire: fire(), rule: rule() }])).toEqual({ nights: [], splits: [] });
  });
});

describe("the one cancellation check (cancellationsUndo)", () => {
  it("does nothing until something booked at the change has cancelled", () => {
    // Occupancy now is under any bar, but everything the raise saw is still booked.
    const occ = rule({ condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 } });
    expect(cancellationsUndo(fire(), occ, input({ occupancyNow: () => 0.1 }))).toBe(false);
    // A night this run could not read says nothing.
    expect(cancellationsUndo(fire(), occ, input({ booked: new Map(), occupancyNow: () => 0.1 }))).toBe(false);
  });

  it("pickup: undoes a raise once cancellations take its count to the threshold, not before", () => {
    // One of the five that came in cancels: net 4, not more than 4.
    expect(cancellationsUndo(fire(), rule(), input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }) }))).toBe(true);
    // Against "more than 3" the same cancellation leaves it true.
    const three = rule({ condition: { pickup_operator: "gt", pickup_threshold: 3, pickup_window_days: 7 } });
    expect(cancellationsUndo(fire(), three, input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }) }))).toBe(false);
  });

  it("pickup: an older booking cancelling, a long time later, doesn't touch the count", () => {
    // The one booked before the count opened cancels: its five are all still there.
    expect(cancellationsUndo(fire(), rule(), input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 0 } }) }))).toBe(false);
  });

  it("pickup: bookings made after the change never prop it up", () => {
    // New bookings are first seen after the fire, so they are not in what the fire saw.
    const i = input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }) });
    expect(cancellationsUndo(fire(), rule(), i)).toBe(true);
  });

  it("pickup: an older booking that cancelled inside the window before the change still counts against it", () => {
    // Opened at 2, six came in and one of the two older ones cancelled before the fire: 7 booked, net 5, 6 arrived.
    const f = fire({ signal_booked_units_start: 2, signal_booked_units_end: 7, pickup_units_arrived_at_fire: 6 });
    // One of the six cancels later: 5 of them left, less the 1 older cancellation, net 4.
    expect(cancellationsUndo(f, rule(), input({ booked: booked({ [FIRED]: { rt1: 6 }, [OPENED]: { rt1: 1 } }) }))).toBe(true);
    // A fire from before the arrivals were stored takes that as none, which keeps the change on.
    const old = { ...f, cancel_check: "net_units" as const, pickup_units_arrived_at_fire: null };
    expect(cancellationsUndo(old, rule(), input({ booked: booked({ [FIRED]: { rt1: 6 }, [OPENED]: { rt1: 1 } }) }))).toBe(false);
  });

  it("pickup: with nothing of its own cancelled, the count is exactly what the change judged", () => {
    // The snapshot its count opened on was a little older than the instant
    // it stood for, and one booking came in between: the change judged net
    // 6 while only 5 were first seen inside its window. An older booking
    // cancelling opens the check; the count stays at 6, more than 5.
    const f = fire({ signal_booked_units_start: 1, signal_booked_units_end: 7, pickup_units_arrived_at_fire: 5 });
    const five = rule({ condition: { pickup_operator: "gt", pickup_threshold: 5, pickup_window_days: 7, pickup_metric: "room_nights" } });
    expect(cancellationsUndo(f, five, input({ booked: booked({ [FIRED]: { rt1: 6 }, [OPENED]: { rt1: 1 } }) }))).toBe(false);
    // Instead one of its own five cancels: 5, not more than 5.
    expect(cancellationsUndo(f, five, input({ booked: booked({ [FIRED]: { rt1: 6 }, [OPENED]: { rt1: 2 } }) }))).toBe(true);
  });

  it("pickup on revenue counts revenue the same way", () => {
    const rev = rule({ condition: { pickup_operator: "gt", pickup_threshold: 450, pickup_window_days: 7, pickup_metric: "revenue" } });
    expect(cancellationsUndo(fire(), rev, input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }) }))).toBe(true);
    const low = rule({ condition: { pickup_operator: "gt", pickup_threshold: 350, pickup_window_days: 7, pickup_metric: "revenue" } });
    expect(cancellationsUndo(fire(), low, input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }) }))).toBe(false);
  });

  it("pickup on revenue: a rate changed on a booking still there never moves the count", () => {
    const rev = rule({ condition: { pickup_operator: "gt", pickup_threshold: 400, pickup_window_days: 7, pickup_metric: "revenue" } });
    const at = (fired: BookedCount, opened: BookedCount) =>
      new Map([
        [bookedBeforeKey(NIGHT, FIRED), new Map([["rt1", fired]])],
        [bookedBeforeKey(NIGHT, OPENED), new Map([["rt1", opened]])],
      ]);
    // Five came in at 100 each: net 500. One of them is re-rated to 0 in the
    // PMS and the one booking from before the count cancels. All five are
    // still booked, so the count is still 500.
    expect(cancellationFinding(fire(), rev, input({ booked: at({ units: 5, revenue: 400 }, { units: 0, revenue: 0 }) }))).toBeNull();
    // One of the five cancelling takes out what each came to at the change, 100: net 400.
    expect(cancellationFinding(fire(), rev, input({ booked: at({ units: 5, revenue: 500 }, { units: 1, revenue: 100 }) }))).toEqual({
      part: "pickup",
      net: 400,
      threshold: 400,
      metric: "revenue",
    });
  });

  it("sums every room type the rule measures", () => {
    const two = rule({ signal_room_type_ids: ["rt1", "rt2"] });
    const f = fire({ signal_set_key: "rt1,rt2" });
    // The rt1 cancellation is made up by an rt2 booking the raise already counted.
    const i = input({ booked: booked({ [FIRED]: { rt1: 3, rt2: 3 }, [OPENED]: { rt1: 1, rt2: 0 } }) });
    expect(cancellationsUndo(f, two, i)).toBe(false);
  });

  it("occupancy more than: reads the night's sellable occupancy now once a cancellation has happened", () => {
    const occ = rule({ condition: { occupancy_operator: "gt", occupancy_threshold: 0.7 } });
    const cancelled = booked({ [FIRED]: { rt1: 5 } });
    expect(cancellationsUndo(fire(), occ, input({ booked: cancelled, occupancyNow: () => 0.65 }))).toBe(true);
    // New bookings since kept it over the bar.
    expect(cancellationsUndo(fire(), occ, input({ booked: cancelled, occupancyNow: () => 0.75 }))).toBe(false);
    // Nothing to sell on the night: nothing is said.
    expect(cancellationsUndo(fire(), occ, input({ booked: cancelled, occupancyNow: () => null }))).toBe(false);
  });

  it("a cut is undone the same way, when a bar it has goes", () => {
    const cut = rule({
      action_direction: "decrease",
      condition: {
        occupancy_operator: "gt",
        occupancy_threshold: 0.2,
        booking_speed_operator: "at_most",
        booking_speed_level: "slower",
        booking_speed_window_days: 30,
      },
    });
    const f = fire({ action_direction: "decrease" });
    const cancelled = booked({ [FIRED]: { rt1: 5 } });
    expect(cancellationsUndo(f, cut, input({ booked: cancelled, occupancyNow: () => 0.18 }))).toBe(true);
    // Slower still never undoes it.
    expect(cancellationsUndo(f, cut, input({ booked: cancelled, occupancyNow: () => 0.25 }))).toBe(false);
  });
});

/** A booking made `lead` days before the night, first seen at `seen`. */
function row(lead: number, seen: string): SlimReservationRow {
  return { stay_date: NIGHT, booking_date: addDays(NIGHT, -lead), booking_window_days: lead, created_at: seen };
}

/** A booking speed context over hand-made rows, with the split at `splits` loaded. */
function context(rows: SlimReservationRow[], splits: string[] = [FIRED]): BookingSpeedContext {
  return {
    asOf: "2026-08-01",
    windowsByDate: indexBookingRows(rows),
    seasonModel: detectSeasons([]),
    dailyDemand: [],
    historyStart: "2023-01-01",
    historyEnd: "2026-07-31",
    isExcluded: () => false,
    selectionCache: new Map(),
    observationCache: new Map(),
    splitWindows: new Map(splits.map((since) => [splitKey(since, ""), indexBookingRows(rows, since)])),
  };
}

describe("booking speed: the bookings the raise counted, still booked, against the usual frozen at the raise", () => {
  // A raise on 6 bookings made 38 to 44 days out (Jul 19 to 25), where 2 is usual: much faster.
  const speed = (level: string, operator: "at_least" | "is" = "at_least") =>
    rule({ condition: { booking_speed_operator: operator, booking_speed_level: level, booking_speed_window_days: 7 } });
  const f = fire({
    window_from: "2026-07-19",
    window_to: "2026-07-25",
    window_bookings_at_fire: 6,
    window_expected_at_fire: 2,
  });
  const seen = "2026-07-24T10:00:00.000Z";
  const six = [38, 39, 40, 41, 42, 43].map((lead) => row(lead, seen));
  const check = (r: EngineRule, rows: SlimReservationRow[]) =>
    cancellationsUndo(f, r, input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }), bsCtx: context(rows) }));

  it("keeps a raise while what is left still reads the rule's pace", () => {
    expect(check(speed("faster"), six.slice(0, 5))).toBe(false);
    expect(check(speed("much_faster"), six.slice(0, 5))).toBe(false);
  });

  it("undoes it once cancellations take what is left under the rule's pace", () => {
    expect(check(speed("much_faster"), six.slice(0, 4))).toBe(true);
    expect(check(speed("faster"), six.slice(0, 3))).toBe(true);
    // Exactly a pace, for a raise: slower than it is no longer it.
    expect(check(speed("much_faster", "is"), six.slice(0, 4))).toBe(true);
  });

  it("only the stored window is recounted: later bookings, and older ones cancelling, change nothing", () => {
    // Three of the six cancel, but three later bookings (after the raise, some inside its window's days) came in.
    const later = [37, 36, 38].map((lead) => row(lead, "2026-07-30T10:00:00.000Z"));
    expect(check(speed("faster"), [...six.slice(0, 3), ...later])).toBe(true);
    // A booking made long before the window cancels: the six are all still there.
    expect(check(speed("much_faster"), six)).toBe(false);
  });

  it("a raise from before the check whose window was recorded in rooms keeps that part as it was", () => {
    const legacy = { ...f, cancel_check: "none" as const };
    const r = rule({
      condition: {
        booking_speed_operator: "at_least",
        booking_speed_level: "much_faster",
        booking_speed_window_days: 7,
        occupancy_operator: "gt",
        occupancy_threshold: 0.5,
      },
    });
    const i = input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }), bsCtx: context(six.slice(0, 2)), occupancyNow: () => 0.6 });
    expect(cancellationsUndo(legacy, r, i)).toBe(false);
    // The old window test trusted "window_bookings": that one is recounted.
    expect(cancellationsUndo({ ...f, cancel_check: "window_bookings" }, r, i)).toBe(true);
  });

  it("booking speed and occupancy together: a cancellation that takes occupancy under the bar undoes it, pace or not", () => {
    const r = rule({
      condition: {
        booking_speed_operator: "at_least",
        booking_speed_level: "faster",
        booking_speed_window_days: 7,
        occupancy_operator: "gt",
        occupancy_threshold: 0.7,
      },
    });
    const i = (occ: number) =>
      input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }), bsCtx: context(six.slice(0, 5)), occupancyNow: () => occ });
    expect(cancellationsUndo(f, r, i(0.72))).toBe(false);
    expect(cancellationsUndo(f, r, i(0.68))).toBe(true);
  });

  it("says what it found no longer true, with the numbers it judged, for the change log", () => {
    // Three of the six cancel: 3 left where 2 is usual no longer reads faster.
    expect(
      cancellationFinding(f, speed("faster"), input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }), bsCtx: context(six.slice(0, 3)) })),
    ).toEqual({ part: "booking_speed", left: 3, counted: 6, expected: 2, level: "faster" });
    // Occupancy is judged first when both went.
    const both = rule({
      condition: { booking_speed_operator: "at_least", booking_speed_level: "faster", booking_speed_window_days: 7, occupancy_operator: "gt", occupancy_threshold: 0.7 },
    });
    expect(
      cancellationFinding(f, both, input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }), bsCtx: context(six.slice(0, 3)), occupancyNow: () => 0.65 })),
    ).toEqual({ part: "occupancy", occupancy: 0.65, threshold: 0.7 });
    // Revenue pickup says so.
    const rev = rule({ condition: { pickup_operator: "gt", pickup_threshold: 450, pickup_window_days: 7, pickup_metric: "revenue" } });
    expect(cancellationFinding(fire(), rev, input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }) }))).toEqual({
      part: "pickup",
      net: 400,
      threshold: 450,
      metric: "revenue",
    });
    // Still true: nothing found.
    expect(cancellationFinding(f, speed("faster"), input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }), bsCtx: context(six.slice(0, 5)) }))).toBeNull();
  });

  it("with the bookings' keys, recounts exactly the bookings it counted: a group is one of them until its last room there cancels", () => {
    // Five where 2 is usual: four single rooms and a group whose first rooms were booked in the window.
    const singles = ["700000001", "700000002", "700000003", "700000004"];
    const g = fire({
      window_from: "2026-07-19",
      window_to: "2026-07-25",
      window_bookings_at_fire: 5,
      window_expected_at_fire: 2,
      window_booking_keys: ["6364686337417", ...singles],
    });
    const night = (rows: [string, string][]) =>
      new Map([[NIGHT, rows.map(([key, created_at]): NightBookingRow => ({ key, room_type_id: "rt1", bw: 40, created_at }))]]);
    const left = (rows: [string, string][]) =>
      cancellationFinding(
        g,
        speed("much_faster"),
        input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }), bsCtx: context([]), nightRows: night(rows) }),
      );
    const four = singles.map((k): [string, string] => [k, seen]);
    const later = "2026-07-30T10:00:00.000Z";
    // The group's first rooms cancelled, and a room it added after the change is still there: all five are still booked.
    expect(left([...four, ["6364686337417", later]])).toBeNull();
    // Its last room goes: four left no longer read much faster.
    expect(left(four)).toEqual({ part: "booking_speed", left: 4, counted: 5, expected: 2, level: "much_faster" });
    // A booking it didn't count never props it up.
    expect(left([...four, ["700000009", later]])).toEqual({ part: "booking_speed", left: 4, counted: 5, expected: 2, level: "much_faster" });
    // Without the night's bookings read, nothing is said.
    expect(
      cancellationFinding(g, speed("much_faster"), input({ booked: booked({ [FIRED]: { rt1: 5 } }), bsCtx: context([]), nightRows: new Map() })),
    ).toBeNull();
  });

  it("with no history loaded for the night, nothing is said", () => {
    expect(cancellationsUndo(f, speed("faster"), input({ booked: booked({ [FIRED]: { rt1: 5 } }), bsCtx: null }))).toBe(false);
    expect(cancellationsUndo(f, speed("faster"), input({ booked: booked({ [FIRED]: { rt1: 5 } }), bsCtx: context(six.slice(0, 2), []) }))).toBe(false);
  });
});

describe("the bookings a booking speed window counted, by key (windowBookingKeys)", () => {
  const r = (key: string, bw: number | null, created_at: string, room_type_id: string | null = "rt1"): NightBookingRow => ({
    key,
    room_type_id,
    bw,
    created_at,
  });
  // Night 2026-09-01, window Jul 19 to 25: booked 38 to 44 days out.
  const keys = (rows: NightBookingRow[], since: string | null = null, ctx: BookingSpeedContext = context([])) =>
    windowBookingKeys(ctx, rows, NIGHT, "2026-07-19", "2026-07-25", ["rt1"], since);

  it("the bookings booked in the window, each once, a group at its earliest booking date and first row", () => {
    const rows = [
      r("a", 38, "2026-07-25T09:00:00.000Z"),
      // A group: its first room booked 44 days out, one added later from 30 out.
      r("g", 44, "2026-07-19T09:00:00.000Z"),
      r("g", 30, "2026-08-02T09:00:00.000Z"),
      // Booked before the window, and after it.
      r("old", 50, "2026-07-13T09:00:00.000Z"),
      r("new", 37, "2026-07-26T09:00:00.000Z"),
      // No booking date: not counted.
      r("undated", null, "2026-07-20T09:00:00.000Z"),
    ];
    expect(keys(rows)).toEqual(["a", "g"]);
  });

  it("on a split first day, only the bookings first seen after the split", () => {
    const rows = [r("before", 44, "2026-07-19T07:00:00.000Z"), r("after", 44, "2026-07-19T09:00:00.000Z"), r("mid", 40, "2026-07-21T09:00:00.000Z")];
    expect(keys(rows, "2026-07-19T08:00:00.000Z")).toEqual(["after", "mid"]);
  });

  it("only the room types the rule measures, when that is not the whole hotel's", () => {
    const ctx: BookingSpeedContext = { ...context([]), hotelSetKey: signalSetKey(["rt1", "rt2"]) };
    const rows = [r("a", 40, "2026-07-21T09:00:00.000Z"), r("b", 40, "2026-07-21T09:00:00.000Z", "rt2"), r("c", 40, "2026-07-21T09:00:00.000Z", null)];
    expect(keys(rows, null, ctx)).toEqual(["a"]);
    expect([...bookingKeysOnNight(ctx, rows, ["rt1"])]).toEqual(["a"]);
    // Measuring every room type reads every row, one with no room type included.
    expect(keys(rows, null, { ...ctx, hotelSetKey: signalSetKey(["rt1"]) })).toEqual(["a", "b", "c"]);
  });
});

describe("the second half: the rule counted the way it would count once the change is off (cancellablePartsHold)", () => {
  const metrics = (over: Partial<RuleMetrics> = {}): RuleMetrics =>
    ({ occupancy: 0.6, dta: 30, net_pickup_units: 5, net_pickup_revenue: 500, booking_speed: null, ...over }) as RuleMetrics;
  const bs = (rank: number) => ({ speed: "x", rank, label: "x", recent: 9, expected: 2, window_days: 7, method: "x" });

  it("holds while every part cancellations can make false still holds", () => {
    // Pickup more than 4: 5 counted.
    expect(cancellablePartsHold(rule(), metrics())).toBe(true);
    expect(cancellablePartsHold(rule(), metrics({ net_pickup_units: 4 }))).toBe(false);
    expect(cancellablePartsHold(rule(), metrics({ pickup_block_reason: "stale_baseline_snapshot" }))).toBe(false);
    const occ = rule({ condition: { occupancy_operator: "gt", occupancy_threshold: 0.5 } });
    expect(cancellablePartsHold(occ, metrics())).toBe(true);
    expect(cancellablePartsHold(occ, metrics({ occupancy: 0.5 }))).toBe(false);
    expect(cancellablePartsHold(occ, metrics({ occupancy: null }))).toBe(false);
  });

  it("reads a pace of at least, or exactly for a raise, as at least the level", () => {
    const at = (operator: "at_least" | "is", level: string) =>
      rule({ condition: { booking_speed_operator: operator, booking_speed_level: level, booking_speed_window_days: 7 } });
    const muchFaster = 2;
    expect(cancellablePartsHold(at("at_least", "much_faster"), metrics({ booking_speed: bs(muchFaster) }))).toBe(true);
    expect(cancellablePartsHold(at("at_least", "much_faster"), metrics({ booking_speed: bs(muchFaster + 1) }))).toBe(true);
    expect(cancellablePartsHold(at("is", "much_faster"), metrics({ booking_speed: bs(muchFaster + 1) }))).toBe(true);
    expect(cancellablePartsHold(at("at_least", "much_faster"), metrics({ booking_speed: bs(muchFaster - 1) }))).toBe(false);
    expect(cancellablePartsHold(at("at_least", "much_faster"), metrics({ booking_speed: null }))).toBe(false);
  });

  it("leaves out what cancellations only make truer", () => {
    const quiet = rule({
      action_direction: "decrease",
      condition: { occupancy_operator: "lt", occupancy_threshold: 0.3, dta_operator: "lt", dta_threshold_days: 10 },
    });
    expect(cancellablePartsHold(quiet, metrics({ occupancy: 0.9, dta: 40 }))).toBe(true);
  });
});

describe("firesCancelled", () => {
  it("names each checked fire that has gone false, and only those", () => {
    const fires = [fire(), fire({ id: "e2", stay_date: addDays(NIGHT, 1) }), fire({ id: "e3", applied_at: NOW })];
    const out = firesCancelled(fires, {
      ...input({
        booked: new Map([
          ...booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }),
          ...booked({ [FIRED]: { rt1: 6 }, [OPENED]: { rt1: 1 } }, addDays(NIGHT, 1)),
        ]),
      }),
      rules: new Map([["r1", rule()]]),
      now: NOW,
    });
    // With what was found no longer true: one of the five cancelled, net 4, not more than 4.
    expect(out).toEqual(new Map([["e1", { part: "pickup", net: 4, threshold: 4, metric: "room_nights" }]]));
    // Unticked, the same cancellations take nothing off.
    expect(
      firesCancelled(fires, {
        ...input({ booked: booked({ [FIRED]: { rt1: 5 }, [OPENED]: { rt1: 1 } }) }),
        rules: new Map([["r1", rule({ undo_on_cancellation: false })]]),
        now: NOW,
      }).size,
    ).toBe(0);
  });
});

describe("retireFires", () => {
  const openFire = (id: string, over: Partial<FakeRow> = {}): FakeRow => ({
    id,
    hotel_id: "h1",
    rule_id: "r1",
    rule_version: 1,
    stay_date: NIGHT,
    affected_room_type_id: "rt1",
    applied_at: "2026-07-25T00:00:00Z",
    fire_seq: 1,
    action_kind: "percent",
    action_direction: "increase",
    action_value: 10,
    cancel_check: "recount",
    baseline_start_ts: "2026-07-18T12:00:00Z",
    signal_booked_units_start: 1,
    signal_booked_units_end: 6,
    signal_set_key: "rt1",
    retired_at: null,
    retired_reason: null,
    ...over,
  });

  it("stamps each fire with its reason, in chunks of at most 200 ids", async () => {
    const fires = Array.from({ length: 450 }, (_, i) => openFire(`e${String(i).padStart(4, "0")}`));
    const { client, tables, calls } = sharedFake({ pickup_event: fires }, { maxRows: 1000 });
    const reasons = new Map(fires.map((f, i) => [String(f.id), i % 2 ? "bookings_cancelled" : "manual_price"] as const));
    const retired = await retireFires(client, "h1", reasons, NOW);
    expect(retired.size).toBe(450);
    expect(tables.pickup_event.filter((e) => e.retired_reason === "manual_price")).toHaveLength(225);
    expect(tables.pickup_event.every((e) => e.retired_at === NOW)).toBe(true);
    const updates = calls.filter((c) => c.table === "pickup_event" && c.op === "update");
    for (const u of updates) {
      expect((u.filters.find((f) => f.col === "id")?.value as string[]).length).toBeLessThanOrEqual(200);
    }
  });

  it("leaves a fire whose write failed open, so the next run tries again", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, tables } = sharedFake(
      { pickup_event: [openFire("e1")] },
      { fault: (c) => (c.op === "update" ? { message: "timeout" } : null) },
    );
    const retired = await retireFires(client, "h1", new Map([["e1", "bookings_cancelled"]]), NOW);
    expect(retired.size).toBe(0);
    expect(tables.pickup_event[0].retired_at).toBeNull();
    spy.mockRestore();
  });

  it("reads every open fire on the horizon past the 1,000-row page, in the order they apply", async () => {
    const fires: FakeRow[] = [];
    for (let i = 0; i < 1200; i++) {
      const night = addDays(NIGHT, i % 40);
      fires.push(
        openFire(`e${String(i).padStart(5, "0")}`, {
          stay_date: night,
          applied_at: new Date(Date.parse(NOW) - i * 60_000).toISOString(),
          fire_seq: 1 + Math.floor(i / 40),
          retired_at: i % 7 === 0 ? NOW : null,
          retired_reason: i % 7 === 0 ? "night_passed" : null,
        }),
      );
    }
    const { client } = sharedFake({ pickup_event: fires }, { maxRows: 1000 });
    const open = await loadOpenPickupFires(client, "h1", ["rt1"], NIGHT, addDays(NIGHT, 39));
    expect(open).toHaveLength(fires.filter((f) => f.retired_at == null).length);
    const onOneNight = open.filter((f) => f.stay_date === NIGHT).map((f) => f.applied_at);
    expect([...onOneNight].sort()).toEqual(onOneNight);
  });

  it("throws rather than pricing a night without its fires", async () => {
    const { client } = sharedFake({}, { fault: (c) => (c.table === "pickup_event" ? { message: "timeout" } : null) });
    await expect(loadOpenPickupFires(client, "h1", ["rt1"], NIGHT, NIGHT)).rejects.toThrow(/timeout/);
  });

  it("takes every fire on a night that is over off as night_passed", async () => {
    const { client, tables } = sharedFake({
      pickup_event: [openFire("old", { stay_date: "2026-07-31" }), openFire("today", { stay_date: "2026-08-01" })],
    });
    await retirePassedNights(client, "h1", "2026-08-01", NOW);
    expect(tables.pickup_event.map((e) => [e.id, e.retired_reason])).toEqual([
      ["old", "night_passed"],
      ["today", null],
    ]);
  });
});

describe("a whole run after the bookings behind a pickup increase cancel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("takes the increase off in the same run, not the one after, and says why", async () => {
    resetBookingSpeedLogOnce();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const TODAY = "2026-09-16";
    const RT = "a0000000-0000-4000-8000-0000000000a1";
    const NIGHT_OF = addDays(TODAY, 5);
    const HORIZON = 10;
    const t0 = Date.parse(`${TODAY}T12:00:00.000Z`);
    let n = 0;
    const booking = (stay: string, lead: number, bookedOn = addDays(stay, -lead)): FakeRow => ({
      id: `f0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      hotel_id: "h1",
      stay_date: stay,
      room_type_id: RT,
      booking_date: bookedOn,
      booking_window_days: lead,
      current_rate: 100,
      base_rate: 100,
      created_at: `${bookedOn}T10:00:00Z`,
    });
    // One booking a night from long ago; the baseline three days back saw one on NIGHT.
    const reservations = Array.from({ length: HORIZON }, (_, i) => booking(addDays(TODAY, i), 40));
    const baselineTs = new Date(t0 - 73 * 3_600_000).toISOString();
    const stay_date_snapshot = reservations.map((r) => ({
      hotel_id: "h1",
      snapshot_ts: baselineTs,
      stay_date: r.stay_date,
      room_type_id: RT,
      sellable_units: 20,
      booked_units: 1,
      booked_revenue: 100,
    }));
    // Then four arrive today.
    const surge = [0, 1, 2, 3].map(() => booking(NIGHT_OF, 5, TODAY));
    const { client, tables } = sharedFake({
      hotels: [{ id: "h1", timezone: "UTC" }],
      room_types: [{ id: RT, hotel_id: "h1", name: "Standard", is_active: true, total_rooms: 20, floor_price: 10, ceiling_price: 5000, counts_as_room: true }],
      reservations: [...reservations, ...surge],
      base_rate_calendar: Array.from({ length: HORIZON }, (_, i) => ({ hotel_id: "h1", stay_date: addDays(TODAY, i), room_type_id: RT, price: 100 })),
      pricing_rules: [
        {
          id: "r-surge",
          hotel_id: "h1",
          name: "Surge",
          is_active: true,
          version: 1,
          priority: 100,
          start_date: null,
          end_date: null,
          is_annual: false,
          dow_mask: 127,
          action_type: "percent",
          action_direction: "increase",
          action_value: 15,
          is_pickup_rule: true,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          rule_condition: [{ pickup_operator: "gt", pickup_threshold: 3, pickup_window_days: 3, pickup_metric: "units" }],
          rule_signal_room_type: [{ room_type_id: RT }],
          rule_affected_room_type: [{ room_type_id: RT }],
        },
      ],
      stay_date_snapshot,
    });
    const priceOnNight = () => Number(tables.published_price.find((p) => p.stay_date === NIGHT_OF && p.room_type_id === RT)?.price);
    const runAt = (minutes: number) => {
      const at = new Date(t0 + minutes * 60_000).toISOString();
      vi.setSystemTime(new Date(at));
      return evaluateHotel(client, "h1", at, HORIZON).then(() => at);
    };

    await runAt(0);
    expect(priceOnNight()).toBe(115);
    // Priced in the run that fired it, before anything could take it off.
    expect(tables.pickup_event.filter((e) => e.stay_date === NIGHT_OF)).toEqual([
      expect.objectContaining({
        signal_booked_units_start: 1,
        retired_at: null,
        fire_seq: 1,
        cancel_check: "recount",
        signal_set_key: RT,
        // The four that came in during its count.
        pickup_units_arrived_at_fire: 4,
      }),
    ]);

    // All four cancel before the next run.
    const gone = new Set(surge.map((b) => b.id));
    tables.reservations = tables.reservations.filter((r) => !gone.has(r.id));
    const second = await runAt(5);

    expect(priceOnNight()).toBe(100);
    expect(tables.pickup_event.filter((e) => e.stay_date === NIGHT_OF)).toEqual([
      expect.objectContaining({ retired_at: second, retired_reason: "bookings_cancelled" }),
    ]);
    // And the change is explained on the cell it moved.
    const audit = tables.evaluation_audit.filter((a) => a.stay_date === NIGHT_OF && a.evaluated_at === second);
    expect((audit[0].details as { retired_pickup_effects?: unknown[] }).retired_pickup_effects).toEqual([
      expect.objectContaining({ reason: "bookings_cancelled", delta: "+15%", fire_seq: 1 }),
    ]);
  }, 60_000);
});

describe("signalSetKey", () => {
  it("is the same for the same room types in any order, and names what was measured", () => {
    expect(signalSetKey(["rt2", "rt1"])).toBe("rt1,rt2");
    expect(signalSetKey([])).toBe("");
  });
});
