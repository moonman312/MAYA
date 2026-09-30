/**
 * A read that fails is not "nothing there".
 *
 * The engine used to carry on from a failed read of the typed prices, the
 * hotel's own rates, the room types, the closed periods, the dates flagged
 * as no fair comparison, a snapshot or the bookings a change counted, as if
 * the answer were empty, and published what it then worked out as a good
 * run: a night priced without the price typed for it, on what its latest
 * guest paid, or compared with the months the hotel was shut. Now only a
 * table, column or function no migration has created yet is read that way
 * (code deployed ahead of its migration prices as it did before it). Any
 * other failure stops the run before it publishes anything, so the next run
 * prices the same nights again.
 *
 * Here a small hotel runs a story with every kind of rule on the app's
 * engine and on the edge functions' copy. Each read is failed by name, and
 * then every read of a run is failed in turn, whatever it is: the run
 * either stops with nothing published, or (where a failed read is read
 * again another way) publishes exactly what the healthy run does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EngineRule } from "@/types/domain";
import { addDays, daysBetween } from "@/lib/observations/calendar";
import { resetBookingSpeedLogOnce as edgeResetLog } from "../../../supabase/functions/_shared/engine/booking-speed-provider";
import { evaluateHotel as edgeEvaluateHotel } from "../../../supabase/functions/_shared/engine/evaluate";
import { evaluateLadderTriple as edgeLadderTriple } from "../../../supabase/functions/_shared/engine/ladder";
import { computeRuleMetrics as edgeRuleMetrics } from "../../../supabase/functions/_shared/engine/metrics";
import {
  findSnapshotAt as edgeFindSnapshotAt,
  isSchemaGapError as edgeIsSchemaGapError,
  loadRunGaps as edgeLoadRunGaps,
  resetRunGapsLogOnce as edgeResetRunGaps,
} from "../../../supabase/functions/_shared/engine/snapshots";
import { resetBookingSpeedLogOnce as appResetLog } from "./booking-speed-provider";
import { evaluateHotel as appEvaluateHotel } from "./evaluate";
import {
  FakeRpcError,
  fakeSupabase,
  missingColumn,
  missingFunction,
  missingRelation,
  missingRelationPg,
  type FakeCall,
  type FakeError,
  type FakeRow,
} from "./fake-supabase.test";
import { evaluateLadderTriple as appLadderTriple } from "./ladder";
import { computeRuleMetrics as appRuleMetrics } from "./metrics";
import {
  findSnapshotAt as appFindSnapshotAt,
  isSchemaGapError as appIsSchemaGapError,
  loadRunGaps as appLoadRunGaps,
  resetRunGapsLogOnce as appResetRunGaps,
} from "./snapshots";

const ENGINES = [
  {
    name: "app engine",
    evaluateHotel: appEvaluateHotel,
    evaluateLadderTriple: appLadderTriple,
    computeRuleMetrics: appRuleMetrics,
    findSnapshotAt: appFindSnapshotAt,
    loadRunGaps: appLoadRunGaps,
    isSchemaGapError: appIsSchemaGapError,
  },
  {
    name: "edge engine",
    evaluateHotel: edgeEvaluateHotel,
    evaluateLadderTriple: edgeLadderTriple,
    computeRuleMetrics: edgeRuleMetrics,
    findSnapshotAt: edgeFindSnapshotAt,
    loadRunGaps: edgeLoadRunGaps,
    isSchemaGapError: edgeIsSchemaGapError,
  },
];
type Engine = (typeof ENGINES)[number];

const H = "h1";
const D0 = "2026-09-16";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T00 = Date.parse(`${D0}T00:00:00.000Z`);
const STD = "a0000000-0000-4000-8000-0000000000a1";
const ROOMS = 40;
/** The night a booking speed rule raises. */
const FAST = addDays(D0, 40);
/** The night a pickup count rule raises. */
const BUSY = addDays(D0, 38);
/** The night the owner typed a price for. */
const TYPED = addDays(D0, 20);
const LAST = addDays(D0, 41);
const iso = (ms: number) => new Date(ms).toISOString();
/** Day `day` of the story at hh:mm UTC (the hotel's time zone). */
const at = (day: number, h: number, m = 0) => T00 + day * DAY + h * HOUR + m * MIN;

/** What a database that is there, and not answering, says. */
const TIMEOUT: FakeError = { code: "57014", message: "canceling statement due to statement timeout" };

function rule(id: string, condition: FakeRow, over: Partial<FakeRow> = {}): FakeRow {
  return {
    id,
    hotel_id: H,
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

/** Every kind of rule, each on a night of its own so each one acts. */
const RULES: FakeRow[] = [
  // Much faster than usual in a day: +10% on FAST.
  rule(
    "Fast day",
    { booking_speed_operator: "at_least", booking_speed_level: "much_faster", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 },
    { start_date: FAST, end_date: FAST },
  ),
  // More than 4 room nights in 3 days: +10% on BUSY.
  rule(
    "Pickup count",
    { pickup_operator: "gt", pickup_threshold: 4, pickup_window_days: 3, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
    { start_date: BUSY, end_date: BUSY },
  ),
  // Fewer than 1 room night in a complete day: -4%, on the week before FAST.
  rule(
    "Quiet day",
    { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
    { action_direction: "decrease", action_value: 4, start_date: addDays(D0, 30), end_date: addDays(D0, 33) },
  ),
  // More than half full: +5%, every night.
  rule("Half full", { occupancy_operator: "gt", occupancy_threshold: 0.5 }, { is_pickup_rule: false, action_value: 5 }),
  // More than 30 room nights in 3 days, on every night: never true here, and measured on all 42 nights at once.
  rule(
    "Rush",
    { pickup_operator: "gt", pickup_threshold: 30, pickup_window_days: 3, pickup_metric: "room_nights", pickup_cooldown_days: 1 },
    { priority: 50, action_value: 15 },
  ),
];

let resId = 0;
function booking(stay: string, bookedOn: string, firstSeen: number | string): FakeRow {
  resId++;
  return {
    id: `f0000000-0000-4000-8000-${String(resId).padStart(12, "0")}`,
    hotel_id: H,
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
const burst = (stay: string, n: number, ms: number) => Array.from({ length: n }, () => booking(stay, dayOf(ms), ms));

/**
 * Every night books one room a day from 49 to 30 days out: 20 of its 40
 * rooms by 30 days out, which is not more than half. FAST and BUSY have
 * nothing of their own in the story's days.
 */
function history(): FakeRow[] {
  const out: FakeRow[] = [];
  for (let stay = addDays(D0, -220); stay <= LAST; stay = addDays(stay, 1)) {
    for (let lead = 30; lead <= 49; lead++) {
      if ((stay === FAST || stay === BUSY) && lead <= 41) continue;
      const on = addDays(stay, -lead);
      out.push(booking(stay, on, `${on}T03:00:00.000Z`));
    }
  }
  return out;
}

type Tables = Record<string, FakeRow[]>;

/** The story's moves, in order: each changes the tables the way the app or a sync does, then runs the engine. */
type Step = { name: string; at: number; nights?: string[]; before?: (t: Tables, waiting: FakeRow[]) => void };

function story() {
  resId = 0;
  const fastFive = burst(FAST, 5, at(0, 10));
  const busyFive = burst(BUSY, 5, at(0, 10));
  const typedTwo = burst(TYPED, 2, at(1, 9));
  const busyAgain = burst(BUSY, 5, at(2, 9));
  const busyMore = burst(BUSY, 5, at(3, 9));
  const rows = [...history(), ...fastFive, ...busyFive, ...typedTwo, ...busyAgain, ...busyMore];
  const nights: string[] = [];
  for (let d = D0; d <= LAST; d = addDays(d, 1)) nights.push(d);
  // Six-hourly snapshots over the four days before the story, for a pickup count to open on.
  const snapshots: FakeRow[] = [];
  for (let h = 4 * 24; h > 0; h -= 6) {
    const ts = T00 - h * HOUR;
    for (const stay of nights) {
      const seen = rows.filter((r) => r.stay_date === stay && Date.parse(String(r.created_at)) <= ts);
      snapshots.push({ hotel_id: H, snapshot_ts: iso(ts), stay_date: stay, room_type_id: STD, sellable_units: ROOMS, booked_units: seen.length, booked_revenue: seen.length * 100 });
    }
  }
  const seed: Tables = {
    hotels: [{ id: H, timezone: "UTC" }],
    room_types: [{ id: STD, hotel_id: H, name: "Standard", is_active: true, total_rooms: ROOMS, floor_price: 10, ceiling_price: 99999, counts_as_room: true }],
    reservations: [],
    base_rate_calendar: nights.map((stay) => ({ hotel_id: H, stay_date: stay, room_type_id: STD, price: 200 })),
    pricing_rules: RULES,
    stay_date_snapshot: snapshots,
    manual_price: [],
    pickup_event: [],
    published_price: [],
    ladder_rule_state: [],
    // The hotel was shut for a fortnight last spring, and the owner flagged one night.
    hotel_closed_periods: [{ id: "c1", hotel_id: H, room_type_id: null, start_date: addDays(D0, -150), end_date: addDays(D0, -136), source: "manual" }],
    assumption_challenges: [
      { id: "ch1", hotel_id: H, challenged_date: addDays(D0, -60), reason_key: "event", scope: "only_this_date", created_at: `${addDays(D0, -10)}T09:00:00.000Z` },
    ],
    room_type_out_of_service: [],
    rule_repeat_alerts: [],
    rule_repeat_alert_nights: [],
    rule_skip_hold: [],
    evaluation_run_log: [],
  };
  const steps: Step[] = [
    // Five bookings each on FAST and BUSY reached MAYA at 10:00: both event rules raise.
    { name: "the bookings arrive", at: at(0, 10, 5) },
    // The owner types 300 for TYPED at noon, and the save prices that night.
    {
      name: "a price is typed",
      at: at(0, 12),
      nights: [TYPED],
      before: (t) => {
        t.manual_price.push({ id: "m1", hotel_id: H, stay_date: TYPED, room_type_id: STD, price: 300, set_by: "u1", set_at: iso(at(0, 12)), cleared_at: null, source: "maya", pms_type: null });
      },
    },
    // Next morning four of FAST's five and two of BUSY's have cancelled, and TYPED has two more rooms booked (22 of 40).
    {
      name: "cancellations, and the typed night fills",
      at: at(1, 10, 5),
      before: (t) => {
        const gone = new Set([...fastFive.slice(0, 4), ...busyFive.slice(0, 2)].map((r) => r.id));
        t.reservations = t.reservations.filter((r) => !gone.has(r.id));
      },
    },
    // Five more book BUSY the day after: the pickup count rule is true again over its three days, and raises again.
    { name: "BUSY picks up again", at: at(2, 10, 5) },
    // And five more the day after that: it counts from its own raise, which is still on the night.
    { name: "BUSY picks up once more", at: at(3, 10, 5) },
  ];
  return { seed, rows, steps };
}

/** Whether a call reads: a select, or a function that only reads. */
const isRead = (c: FakeCall) => (c.table.startsWith("rpc:") ? c.table !== "rpc:booking_history_cache_put" : c.op === "select");

type Fault = (call: FakeCall, index: number) => FakeError | null;

/**
 * The story up to `upTo` (that step's changes made, its run not yet), on a
 * fresh fake, and that step's run with `fault` deciding which of its calls
 * fail. Earlier steps run healthy.
 */
async function play(engine: Engine, upTo: number, fault: Fault = () => null, tweak?: (seed: Tables) => void) {
  const { seed, rows, steps } = story();
  tweak?.(seed);
  let armed = false;
  let index = 0;
  const calls: FakeCall[] = [];
  const decide = (call: FakeCall): FakeError | null => {
    if (!armed) return null;
    calls.push(call);
    return fault(call, index++);
  };
  const fake = fakeSupabase(seed, {
    fault: (call) => decide(call),
    rpc: (fn, args) => {
      const error = decide({ table: `rpc:${fn}`, op: "select", columns: "", filters: [], payload: args as FakeRow });
      return error ? new FakeRpcError(error) : undefined;
    },
  });
  const waiting = [...rows].sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)));
  let lastRun: number | null = null;
  const prepare = (step: Step) => {
    while (waiting.length > 0 && Date.parse(String(waiting[waiting.length - 1].created_at)) <= step.at) {
      fake.tables.reservations.push(waiting.pop()!);
    }
    step.before?.(fake.tables, waiting);
    // The scheduled ticks in between found nothing to price and logged a heartbeat each hour.
    for (let t = (lastRun ?? step.at) + HOUR; t < step.at; t += HOUR) {
      fake.tables.evaluation_run_log.push({ hotel_id: H, evaluation_run_id: `idle-${t}`, evaluated_at: iso(t), cells_checked: 0, cells_changed: 0, run_kind: "idle", nights_priced: 0 });
    }
    lastRun = step.at;
    vi.setSystemTime(new Date(step.at));
  };
  const run = (step: Step) =>
    engine.evaluateHotel(fake.client, H, iso(step.at), daysBetween(dayOf(step.at), LAST) + 1, step.nights ? { nights: step.nights, runKind: "save" } : {});
  for (const step of steps.slice(0, upTo)) {
    prepare(step);
    await run(step);
  }
  const step = steps[upTo];
  prepare(step);
  const before = facts(fake.tables);
  armed = true;
  let error: Error | null = null;
  try {
    await run(step);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  armed = false;
  return { fake, calls, error, before, after: facts(fake.tables), step };
}

/** What a run leaves for the hotel to see and the push to send, and what says a run happened. */
function facts(t: Tables) {
  const sorted = (rows: string[]) => rows.sort();
  return {
    published: sorted((t.published_price ?? []).map((p) => `${p.stay_date}|${p.room_type_id}|${Number(p.price)}|${p.base_price == null ? "" : Number(p.base_price)}|${p.computed_at}`)),
    audits: (t.evaluation_audit ?? []).length,
    runs: (t.evaluation_run_log ?? []).length,
    fires: sorted((t.pickup_event ?? []).map((e) => `${e.rule_id}|${e.stay_date}|${e.fire_seq}|${e.retired_reason ?? ""}`)),
    ladder: sorted((t.ladder_rule_state ?? []).map((r) => `${r.rule_id}|${r.stay_date}|${r.is_active}|${r.suppressed_at ?? ""}`)),
  };
}

const priceOf = (t: Tables, night: string) => Number((t.published_price ?? []).find((p) => p.stay_date === night && p.room_type_id === STD)?.price);

beforeEach(() => {
  appResetLog();
  edgeResetLog();
  appResetRunGaps();
  edgeResetRunGaps();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The reads a run prices from, by name. `in` is the step of the story whose
 * run makes the read; `match` finds it among that run's calls.
 */
const READS: { name: string; in: number; match: (c: FakeCall) => boolean; error: RegExp }[] = [
  { name: "the hotel's time zone", in: 0, match: (c) => c.table === "hotels", error: /Failed to read hotel timezone/ },
  { name: "the room types", in: 0, match: (c) => c.table === "room_types", error: /Failed to load room types/ },
  { name: "the rules", in: 0, match: (c) => c.table === "pricing_rules" && c.filters.some((f) => f.col === "is_active" && f.value === true), error: /Failed to load pricing rules/ },
  { name: "the paused rules", in: 0, match: (c) => c.table === "pricing_rules" && c.filters.some((f) => f.col === "is_active" && f.value === false), error: /Failed to load paused rules/ },
  { name: "the bookings on the nights priced (engine_reservation_cells)", in: 0, match: (c) => c.table === "rpc:engine_reservation_cells", error: /Failed to load reservation cells/ },
  { name: "the rooms out of service", in: 0, match: (c) => c.table === "room_type_out_of_service", error: /Failed to load rooms out of service/ },
  { name: "the hotel's own rates (base_rate_calendar)", in: 0, match: (c) => c.table === "base_rate_calendar", error: /Failed to load the hotel's own rates/ },
  { name: "the typed prices (manual_price)", in: 2, match: (c) => c.table === "manual_price", error: /Failed to load typed prices/ },
  { name: "the base remembered for each night (published_price)", in: 2, match: (c) => c.table === "published_price" && c.columns.includes("base_price") && !c.columns.includes(" price"), error: /statement timeout/ },
  { name: "the closed periods", in: 0, match: (c) => c.table === "hotel_closed_periods", error: /Failed to load closed periods/ },
  { name: "the dates flagged as no fair comparison (assumption_challenges)", in: 0, match: (c) => c.table === "assumption_challenges", error: /Failed to load the dates flagged as no fair comparison/ },
  { name: "the booking history (booking_speed_history_summary)", in: 0, match: (c) => c.table === "rpc:booking_speed_history_summary", error: /Failed to load booking history/ },
  { name: "the booking windows compared with (booking_speed_windows)", in: 0, match: (c) => c.table === "rpc:booking_speed_windows", error: /Failed to load booking history/ },
  { name: "when pricing ran (engine_run_gaps)", in: 0, match: (c) => c.table === "rpc:engine_run_gaps", error: /Failed to load when pricing ran/ },
  { name: "the rules' changes and their state (ladder_rule_state)", in: 2, match: (c) => c.table === "ladder_rule_state" && c.columns.includes("rule_version"), error: /statement timeout/ },
  { name: "the rules' changes on the price (ladder_rule_state)", in: 2, match: (c) => c.table === "ladder_rule_state" && c.columns.includes("action_kind") && !c.columns.includes("rule_version"), error: /Failed to load ladder effects/ },
  { name: "the booking speed and pickup changes still on (pickup_event)", in: 2, match: (c) => c.table === "pickup_event" && c.op === "select", error: /Failed to load pickup effects/ },
  { name: "each rule's changes so far (pickup_fire_heads)", in: 2, match: (c) => c.table === "rpc:pickup_fire_heads", error: /Failed to load rule fire history/ },
  { name: "the owner's answers to the three-changes alert", in: 2, match: (c) => c.table === "rule_repeat_alert_nights" && c.columns.includes("choice") && c.filters.some((f) => f.kind === "in" && f.col === "rule_id"), error: /Failed to load rule alert answers/ },
  { name: "a snapshot, one night and room type at a time", in: 2, match: (c) => c.table === "stay_date_snapshot" && c.columns === "booked_units, booked_revenue, snapshot_ts", error: /Failed to load snapshots/ },
  { name: "the rooms to sell when a price was typed", in: 2, match: (c) => c.table === "stay_date_snapshot" && c.columns === "sellable_units", error: /Failed to load snapshots/ },
  { name: "the bookings first seen by an instant (engine_booked_before), wherever the run asks", in: 2, match: (c) => c.table === "rpc:engine_booked_before", error: /Failed to recount bookings for cancellations/ },
  { name: "what came in during a count, recorded on a change about to be made", in: 0, match: (c) => c.table === "rpc:engine_booked_before", error: /Failed to recount bookings for cancellations/ },
  { name: "the bookings on a night a change is checked on", in: 2, match: (c) => c.table === "reservations" && c.columns.includes("external_reservation_id") && c.columns.includes("created_at"), error: /Failed to load the nights' bookings/ },
  { name: "the bookings a booking speed window held, recorded on a change about to be made", in: 0, match: (c) => c.table === "reservations" && c.columns.includes("external_reservation_id") && c.columns.includes("created_at"), error: /Failed to load the nights' bookings/ },
  { name: "the last record of each night (audit_last_signatures)", in: 2, match: (c) => c.table === "rpc:audit_last_signatures", error: /Failed to load prior audit signatures/ },
];

describe.each(ENGINES)("$name: a read that fails", (engine) => {
  it("the story, healthy: both event rules raise, the typed price holds, cancellations take the raises off", async () => {
    const first = await play(engine, 0);
    expect(first.error).toBeNull();
    expect(priceOf(first.fake.tables, FAST)).toBe(220);
    expect(priceOf(first.fake.tables, BUSY)).toBe(220);
    expect(first.after.fires).toEqual([`Fast day|${FAST}|1|`, `Pickup count|${BUSY}|1|`]);

    const typed = await play(engine, 1);
    expect(typed.error).toBeNull();
    // 20 of 40 is not more than half: the typed price stands alone.
    expect(priceOf(typed.fake.tables, TYPED)).toBe(300);

    const last = await play(engine, 2);
    expect(last.error).toBeNull();
    // One of FAST's five is left and three of BUSY's: neither rule is true any more.
    expect(priceOf(last.fake.tables, FAST)).toBe(200);
    expect(priceOf(last.fake.tables, BUSY)).toBe(200);
    expect(last.after.fires).toEqual([`Fast day|${FAST}|1|bookings_cancelled`, `Pickup count|${BUSY}|1|bookings_cancelled`]);
    // 22 of 40: the rule became true after the price was typed, so it goes on top of it.
    expect(priceOf(last.fake.tables, TYPED)).toBe(315);

    const again = await play(engine, 3);
    expect(again.error).toBeNull();
    expect(priceOf(again.fake.tables, BUSY)).toBe(220);
    const more = await play(engine, 4);
    expect(more.error).toBeNull();
    // Two raises, and by now more than half its rooms are booked: 200 x 1.1 x 1.1 x 1.05.
    expect(priceOf(more.fake.tables, BUSY)).toBe(254.1);
    expect(more.after.fires.filter((f) => !f.startsWith("Quiet day"))).toEqual([
      `Fast day|${FAST}|1|bookings_cancelled`,
      `Pickup count|${BUSY}|1|bookings_cancelled`,
      `Pickup count|${BUSY}|2|`,
      `Pickup count|${BUSY}|3|`,
    ]);
    // The quiet nights were cut meanwhile.
    expect(more.after.fires.some((f) => f.startsWith("Quiet day"))).toBe(true);
    // Both ways of reading many snapshots at once are part of the story.
    expect(first.calls.some((c) => c.table === "rpc:snapshot_cells_at")).toBe(true);
    expect(more.calls.some((c) => c.table === "stay_date_snapshot" && c.filters.some((f) => f.kind === "or"))).toBe(true);
  }, 120_000);

  it.each(READS)("$name: the run stops and publishes nothing", async (read) => {
    const healthy = await play(engine, read.in);
    expect(healthy.error).toBeNull();
    const asked = healthy.calls.map((c, i) => (isRead(c) && read.match(c) ? i : -1)).filter((i) => i >= 0);
    // The story makes this read, or the test proves nothing.
    expect(asked.length).toBeGreaterThan(0);
    for (const index of asked) {
      const failed = await play(engine, read.in, (_c, i) => (i === index ? TIMEOUT : null));
      expect(failed.error?.message ?? "the run finished").toMatch(read.error);
      expect(failed.after.published).toEqual(failed.before.published);
      expect(failed.after.audits).toBe(failed.before.audits);
      // No heartbeat either: nothing may read the run as one that priced its nights.
      expect(failed.after.runs).toBe(failed.before.runs);
    }
  }, 300_000);

  it.each([0, 1, 2, 3, 4])("whichever read of run %i fails, it publishes nothing, or exactly what the healthy run does", async (upTo) => {
    const healthy = await play(engine, upTo);
    expect(healthy.error).toBeNull();
    const reads = healthy.calls.map((c, i) => (isRead(c) ? i : -1)).filter((i) => i >= 0);
    expect(reads.length).toBeGreaterThan(20);
    const stopped: string[] = [];
    const finished: string[] = [];
    for (const index of reads) {
      const failed = await play(engine, upTo, (_c, i) => (i === index ? TIMEOUT : null));
      const what = `${healthy.calls[index].table} [${healthy.calls[index].columns.replace(/\s+/g, " ").trim().slice(0, 60)}]`;
      if (failed.error) {
        stopped.push(what);
        expect(failed.after.published, `${what} failed and the run stopped`).toEqual(failed.before.published);
        expect(failed.after.audits, what).toBe(failed.before.audits);
        expect(failed.after.runs, what).toBe(failed.before.runs);
      } else {
        finished.push(what);
        expect(failed.after.published, `${what} failed and the run finished`).toEqual(healthy.after.published);
        expect(failed.after.fires, what).toEqual(healthy.after.fires);
        expect(failed.after.ladder, what).toEqual(healthy.after.ladder);
      }
    }
    if (process.env.MAYA_FAILED_READS) {
      process.stdout.write(`READS ${engine.name} run ${upTo}: ${reads.length} reads, ${stopped.length} stop the run\n`);
      for (const w of [...new Set(finished)]) process.stdout.write(`READS   finishes: ${w}\n`);
      for (const w of [...new Set(stopped)]) process.stdout.write(`READS   stops: ${w}\n`);
    }
    // Most reads are ones the prices are made from.
    expect(stopped.length).toBeGreaterThan(finished.length);
  }, 600_000);
});

/**
 * Code deployed ahead of its migration: what each of these reads asks for
 * is not there yet, and the run prices the way it did before it.
 */
describe.each(ENGINES)("$name: a table or function no migration has created yet", (engine) => {
  const logged = () =>
    vi.mocked(console.error).mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

  it("no base_rate_calendar: no night is priced (never on what its guest paid), the typed price still is, and the log names the migration", async () => {
    const run = await play(engine, 0, (c) => (c.table === "base_rate_calendar" ? missingRelation("base_rate_calendar") : null));
    expect(run.error).toBeNull();
    // No rate on record for any night: nothing published, whatever the guests paid.
    expect(Number.isNaN(priceOf(run.fake.tables, FAST))).toBe(true);
    expect(run.fake.tables.published_price ?? []).toEqual([]);
    const lines = logged().filter((l) => l.step === "base_rate_calendar");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ degradedToEmpty: true, schema: "pre-migration", migration: "99_supabase_migration_base_rate_calendar_v1.sql" });

    // With a typed price on the table, that night is priced on the typed
    // price. The prices the healthy first run published stay as they were:
    // no night is priced again on what its guest paid.
    const typed = await play(engine, 1, (c) => (c.table === "base_rate_calendar" ? missingRelation("base_rate_calendar") : null));
    expect(typed.error).toBeNull();
    expect(priceOf(typed.fake.tables, TYPED)).toBe(300);
    expect(priceOf(typed.fake.tables, FAST)).toBe(220);
    expect(typed.after.published.filter((row) => !row.startsWith(TYPED))).toEqual(typed.before.published.filter((row) => !row.startsWith(TYPED)));
  }, 120_000);

  it.each([
    ["as PostgREST words it", missingRelation("manual_price")],
    ["as Postgres words it", missingRelationPg("manual_price")],
  ])("no manual_price (%s): no typed price applies, and the log names the migration", async (_name, gap) => {
    const run = await play(engine, 2, (c) => (c.table === "manual_price" ? gap : null));
    expect(run.error).toBeNull();
    // The hotel's own rate, and the rule on it.
    expect(priceOf(run.fake.tables, TYPED)).toBe(210);
    const lines = logged().filter((l) => l.step === "manual_price");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ degradedToEmpty: true, schema: "pre-migration", migration: "99_supabase_migration_manual_price_v1.sql" });
  }, 120_000);

  it("manual_price without where a price came from: read again without it, and the typed price holds", async () => {
    const run = await play(engine, 2, (c) =>
      c.table === "manual_price" && c.columns.includes("source") ? missingColumn("manual_price", "source") : null,
    );
    expect(run.error).toBeNull();
    expect(priceOf(run.fake.tables, TYPED)).toBe(315);
  }, 120_000);

  it.each([
    ["hotel_closed_periods", "99_supabase_migration_onboarding_v1.sql"],
    ["assumption_challenges", "99_supabase_migration_assumption_challenges_v1.sql"],
  ])("no %s: nothing is left out of the comparison, as for a hotel with none, and the log names the migration", async (table, migration) => {
    const run = await play(engine, 0, (c) => (c.table === table ? missingRelation(table) : null));
    expect(run.error).toBeNull();
    const lines = logged().filter((l) => l.step === table);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ schema: "pre-migration", migration });
    const none = await play(engine, 0, () => null, (seed) => {
      seed[table] = [];
    });
    expect(none.error).toBeNull();
    expect(run.after.published).toEqual(none.after.published);
    expect(run.after.fires).toEqual(none.after.fires);
  }, 120_000);

  it.each(["engine_run_gaps", "engine_booked_before", "engine_reservation_cells", "audit_last_signatures"])(
    "no %s: the run reads what it needs the older way and prices the same",
    async (fn) => {
      const healthy = await play(engine, 2);
      const run = await play(engine, 2, (c) => (c.table === `rpc:${fn}` ? missingFunction(fn) : null));
      expect(run.error).toBeNull();
      expect(run.calls.some((c) => c.table === `rpc:${fn}`)).toBe(true);
      expect(run.after.published.map((p) => p.split("|").slice(0, 3))).toEqual(healthy.after.published.map((p) => p.split("|").slice(0, 3)));
      expect(run.after.fires).toEqual(healthy.after.fires);
    },
    120_000,
  );

  it("a cancellation check that reads a column not there yet leaves every change where it is", async () => {
    const run = await play(engine, 2, (c) =>
      c.table === "reservations" && c.columns.includes("external_reservation_id") && c.columns.includes("created_at")
        ? missingColumn("reservations", "created_at")
        : null,
    );
    expect(run.error).toBeNull();
    // Not judged, so still on; the pickup count's check reads no bookings by row and is judged.
    expect(run.after.fires).toContain(`Fast day|${FAST}|1|`);
    expect(priceOf(run.fake.tables, FAST)).toBe(220);
    expect(logged().some((l) => l.step === "cancellation_check")).toBe(true);
  }, 120_000);
});

/** The same reads where a caller makes them one at a time, outside a run's batches. */
describe.each(ENGINES)("$name: the reads made one at a time", (engine) => {
  const halfFull: EngineRule = {
    id: "Half full",
    hotel_id: H,
    name: "Half full",
    is_active: true,
    version: 1,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: 5,
    priority: 100,
    is_pickup_rule: false,
    condition: { occupancy_operator: "gt", occupancy_threshold: 0.5 },
    signal_room_type_ids: [STD],
    affected_room_type_ids: [STD],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const NOW = iso(at(0, 10, 5));
  const snapshot = { hotel_id: H, snapshot_ts: NOW, stay_date: TYPED, room_type_id: STD, sellable_units: ROOMS, booked_units: 30, booked_revenue: 3000 };
  const failing = (table: string, columns?: string) => (c: FakeCall) =>
    c.table === table && c.op === "select" && (columns === undefined || c.columns === columns) ? TIMEOUT : null;

  it("a rule's state on a night: never read as no change yet", async () => {
    const { client, tables } = fakeSupabase(
      { ladder_rule_state: [{ rule_id: halfFull.id, rule_version: 1, stay_date: TYPED, room_type_id: STD, is_active: true }] },
      { fault: failing("ladder_rule_state") },
    );
    const metrics = { occupancy: 0.75, dta: 20, net_pickup_units: null, net_pickup_revenue: null };
    await expect(engine.evaluateLadderTriple(client, halfFull, H, TYPED, STD, metrics, NOW)).rejects.toThrow(/Failed to load the rule's changes/);
    expect(tables.ladder_transition_event ?? []).toEqual([]);
  });

  it("a snapshot: never read as a night with nothing booked", async () => {
    const { client } = fakeSupabase({ stay_date_snapshot: [snapshot] }, { fault: failing("stay_date_snapshot", "booked_units, booked_revenue, snapshot_ts") });
    await expect(engine.findSnapshotAt(client, H, TYPED, [STD], NOW)).rejects.toThrow(/Failed to load snapshots/);
    await expect(engine.computeRuleMetrics(client, halfFull, H, TYPED, NOW, D0, NOW, null)).rejects.toThrow(/Failed to load snapshots/);
  });

  it("the rooms to sell: never read as none", async () => {
    const { client } = fakeSupabase({ stay_date_snapshot: [snapshot] }, { fault: failing("stay_date_snapshot", "sellable_units") });
    await expect(engine.computeRuleMetrics(client, halfFull, H, TYPED, NOW, D0, NOW, null)).rejects.toThrow(/Failed to load snapshots/);
    const healthy = fakeSupabase({ stay_date_snapshot: [snapshot] });
    expect((await engine.computeRuleMetrics(healthy.client, halfFull, H, TYPED, NOW, D0, NOW, null)).occupancy).toBe(0.75);
  });

  it("when pricing ran: null only before its migration", async () => {
    const down = fakeSupabase({}, { rpc: () => new FakeRpcError(TIMEOUT) });
    await expect(engine.loadRunGaps(down.client, H, iso(at(-3, 0)), NOW)).rejects.toThrow(/Failed to load when pricing ran/);
    const before = fakeSupabase({}, { rpc: (fn) => new FakeRpcError(missingFunction(fn)) });
    expect(await engine.loadRunGaps(before.client, H, iso(at(-3, 0)), NOW)).toBeNull();
    const there = fakeSupabase({ evaluation_run_log: [] });
    expect(Array.isArray(await engine.loadRunGaps(there.client as SupabaseClient, H, iso(at(-3, 0)), NOW))).toBe(true);
  });

  it("only a table, column or function that is not there yet is a gap in the schema", () => {
    for (const gap of [
      missingRelation("manual_price"),
      missingRelationPg("manual_price"),
      missingColumn("manual_price", "source"),
      missingFunction("engine_run_gaps"),
      new Error("Failed to load the nights' bookings: column reservations.created_at does not exist"),
    ]) {
      expect(engine.isSchemaGapError(gap)).toBe(true);
    }
    for (const outage of [
      TIMEOUT,
      { code: "42501", message: "permission denied for table manual_price" },
      { code: "08006", message: "connection failure" },
      { message: "TypeError: fetch failed" },
      new Error("Failed to recount bookings for cancellations: canceling statement due to statement timeout"),
      null,
      undefined,
    ]) {
      expect(engine.isSchemaGapError(outage)).toBe(false);
    }
  });
});
