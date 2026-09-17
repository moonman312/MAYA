/**
 * Which open fires a run takes off before anything fires, and why: a raise
 * whose bookings cancelled, a fire older than the price someone set on its
 * cell, and a fire of a rule version that has been edited away. Cuts are
 * never taken off for cancellations, and a fire this run made is never taken
 * off by the run that made it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import type { EngineRule } from "@/types/domain";
import { indexBookingRows } from "@/lib/observations/booking-rows";
import { detectSeasons } from "@/lib/observations/seasons";
import { resetBookingSpeedLogOnce, signalSetKey, type BookingSpeedContext } from "./booking-speed-provider";
import { evaluateHotel } from "./evaluate";
import { fakeSupabase as sharedFake, type FakeRow } from "./fake-supabase.test";
import {
  cancellationCrossed,
  firesToRetire,
  loadOpenPickupFires,
  retireFires,
  retirePassedNights,
  type OpenPickupFire,
} from "./pickup";

const NOW = "2026-08-01T00:00:00Z";
const NIGHT = "2026-09-01";

function rule(over: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "r1",
    version: 1,
    action_direction: "increase",
    signal_room_type_ids: ["rt1"],
    affected_room_type_ids: ["rt1"],
    condition: {},
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  } as unknown as EngineRule;
}

function fire(over: Partial<OpenPickupFire> = {}): OpenPickupFire {
  return {
    id: "e1",
    rule_id: "r1",
    rule_version: 1,
    stay_date: NIGHT,
    affected_room_type_id: "rt1",
    applied_at: "2026-07-25T00:00:00Z",
    fire_seq: 1,
    action_kind: "percent",
    action_direction: "increase",
    action_value: 10,
    cancel_check: "net_units",
    signal_booked_units_start: 1,
    window_from: null,
    window_to: null,
    window_expected_at_fire: null,
    signal_set_key: "rt1",
    ...over,
  };
}

const none = new Map<string, string>();

function retireInput(over: Partial<Parameters<typeof firesToRetire>[1]> = {}) {
  return {
    rules: new Map([["r1", rule()]]),
    manualSetAtByCell: none,
    bookedByCell: new Map([[`${NIGHT}|rt1`, 1]]),
    bsCtx: null,
    now: NOW,
    ...over,
  };
}

/** A booking speed context over hand-made rows, as booking-speed-provider.test builds one. */
function context(windows: number[]): BookingSpeedContext {
  return {
    asOf: "2026-08-01",
    windowsByDate: indexBookingRows(windows.map((w) => ({ stay_date: NIGHT, booking_window_days: w }))),
    seasonModel: detectSeasons([]),
    dailyDemand: [],
    historyStart: "2023-01-01",
    historyEnd: "2026-07-31",
    isExcluded: () => false,
    selectionCache: new Map(),
    observationCache: new Map(),
  };
}

describe("firesToRetire", () => {
  it("takes a raise off once bookings fall back to where its window opened", () => {
    // Fired at 4 booked, having started from 1. All four cancelled.
    expect(firesToRetire([fire()], retireInput())).toEqual(new Map([["e1", "bookings_cancelled"]]));
  });

  it("leaves a raise alone when only some of the surge cancelled", () => {
    // A cancellation or two out of a real surge is noise, not a reversal.
    expect(firesToRetire([fire()], retireInput({ bookedByCell: new Map([[`${NIGHT}|rt1`, 3]]) })).size).toBe(0);
  });

  it("sums across every room type the rule measures", () => {
    const r = rule({ signal_room_type_ids: ["rt1", "rt2"] });
    const booked = new Map([
      [`${NIGHT}|rt1`, 1],
      [`${NIGHT}|rt2`, 1],
    ]);
    expect(firesToRetire([fire()], retireInput({ rules: new Map([["r1", r]]), bookedByCell: booked })).size).toBe(0);
  });

  it("never takes a cut off, whatever the bookings do", () => {
    const cut = fire({ action_direction: "decrease", cancel_check: "none" });
    expect(firesToRetire([cut], retireInput({ bookedByCell: new Map([[`${NIGHT}|rt1`, 0]]) })).size).toBe(0);
  });

  it("never takes off a raise whose trigger was not bookings", () => {
    const held = fire({ cancel_check: "none" });
    expect(firesToRetire([held], retireInput({ bookedByCell: new Map([[`${NIGHT}|rt1`, 0]]) })).size).toBe(0);
  });

  it("leaves a fire alone when its rule is not loaded this run, or measures nothing", () => {
    expect(firesToRetire([fire()], retireInput({ rules: new Map() })).size).toBe(0);
    const empty = rule({ signal_room_type_ids: [] });
    expect(firesToRetire([fire()], retireInput({ rules: new Map([["r1", empty]]) })).size).toBe(0);
  });

  it("leaves a fire alone while the rule measures other room types than it did", () => {
    const moved = rule({ signal_room_type_ids: ["rt1", "rt2"] });
    const booked = new Map([[`${NIGHT}|rt1`, 1]]);
    expect(
      firesToRetire([fire({ signal_set_key: "rt1" })], retireInput({ rules: new Map([["r1", moved]]), bookedByCell: booked })).size,
    ).toBe(0);
  });

  it("does not act when this run has no numbers for the night", () => {
    expect(firesToRetire([fire()], retireInput({ bookedByCell: new Map() })).size).toBe(0);
  });

  it("never takes off a fire this run made", () => {
    expect(firesToRetire([fire({ applied_at: NOW })], retireInput()).size).toBe(0);
  });

  it("takes off a fire older than the price someone set on its cell", () => {
    const manual = new Map([[`${NIGHT}|rt1`, "2026-07-28T00:00:00Z"]]);
    expect(firesToRetire([fire()], retireInput({ manualSetAtByCell: manual }))).toEqual(
      new Map([["e1", "manual_price"]]),
    );
    // One made after the price stays.
    const later = fire({ applied_at: "2026-07-29T00:00:00Z" });
    expect(firesToRetire([later], retireInput({ manualSetAtByCell: manual, bookedByCell: new Map() })).size).toBe(0);
  });

  it("takes off a fire of a version the rule has moved on from", () => {
    const edited = new Map([["r1", rule({ version: 2 })]]);
    expect(firesToRetire([fire()], retireInput({ rules: edited, bookedByCell: new Map() }))).toEqual(
      new Map([["e1", "rule_edited"]]),
    );
  });

  it("tests a booking speed raise on the bookings left in its own frozen window", () => {
    // Fired on 4 bookings in the window against 2 expected.
    const bs = fire({
      cancel_check: "window_bookings",
      window_from: "2026-07-26",
      window_to: "2026-08-01",
      window_expected_at_fire: 2,
      signal_booked_units_start: 99,
    });
    const input = (windows: number[]) => retireInput({ bsCtx: context(windows), bookedByCell: new Map() });
    // Three of the four left: still ahead of the usual pace.
    expect(firesToRetire([bs], input([31, 32, 33])).size).toBe(0);
    // Two left: back to the usual pace.
    expect(firesToRetire([bs], input([31, 32]))).toEqual(new Map([["e1", "bookings_cancelled"]]));
    // Bookings outside the frozen window can't hold it up.
    expect(firesToRetire([bs], input([31, 32, 10, 10, 10]))).toEqual(new Map([["e1", "bookings_cancelled"]]));
    // No booking speed history this run: nothing is said, so nothing comes off.
    expect(firesToRetire([bs], retireInput({ bsCtx: null, bookedByCell: new Map() })).size).toBe(0);
  });

  it("a fire either test can take off comes off as soon as one of them says so", () => {
    const either = fire({
      cancel_check: "either",
      window_from: "2026-07-26",
      window_to: "2026-08-01",
      window_expected_at_fire: 2,
      signal_booked_units_start: 1,
    });
    // The window still looks busy, but the night's bookings are back to the start.
    expect(cancellationCrossed(either, rule(), new Map([[`${NIGHT}|rt1`, 1]]), context([31, 32, 33]))).toBe(true);
    // Neither line crossed.
    expect(cancellationCrossed(either, rule(), new Map([[`${NIGHT}|rt1`, 5]]), context([31, 32, 33]))).toBe(false);
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
    cancel_check: "net_units",
    signal_booked_units_start: 1,
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

describe("a whole run after a pickup increase's bookings cancel", () => {
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
      expect.objectContaining({ signal_booked_units_start: 1, retired_at: null, fire_seq: 1, cancel_check: "net_units", signal_set_key: RT }),
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
