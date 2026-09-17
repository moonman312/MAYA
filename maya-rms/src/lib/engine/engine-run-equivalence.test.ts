/**
 * Whole-run equivalence for the evaluation engine.
 *
 * A seeded hotel is evaluated eight times over seventeen days while bookings
 * arrive and cancel, a manual price is typed, and a publish, a ladder event
 * insert and an audit insert fail. After every run the engine's tables are
 * normalized (generated ids and run ids replaced with stable keys), hashed,
 * and compared with the hashes the engine produced BEFORE the batching and
 * preload changes. So these assertions are old code against new code: any
 * difference in a published price, a ladder state or transition, a pickup
 * event, an audit row or a run's counts fails here.
 *
 * The pickup_event hashes, and the audit and price hashes of the cells those
 * fires touch, were rewritten a fourth time for stacking. Every difference was
 * read row by row against a dump of the previous engine first:
 *   - A Suite raise on a night already published at its 169.50 ceiling no
 *     longer fires (it could not move the price), and starts no wait, so the
 *     rule keeps measuring that night. Those nights' prices are unchanged
 *     while the ceiling holds; Suite 2026-06-25 reads 168.00 from run 6,
 *     where the old blocked raise had held it at the ceiling.
 *   - A pickup count rule now waits its own window before firing again, so
 *     the 1-day KING rule does not fire a second time the next morning:
 *     2026-06-27 and 2026-06-29 publish 3% lower from runs 3 and 4.
 *   - A Booking Speed rule measures no pickup window, so its fires record
 *     this run's booked units as both start and end, and baseline_start_ts
 *     as now minus its 30-day window (informational).
 *   - Every fire carries fire_seq, cancel_check, signal_set_key, its frozen
 *     window and retired_reason (null while it is open), every retirement
 *     carries a reason (night_passed here),
 *     and audit details carry applied_at and fire_seq per effect plus
 *     event_id on the fire that won.
 *   - Fewer audit rows in the later runs: a cell whose fire never happened
 *     has nothing new to record. The 30-day observation now appears on
 *     nights the rule is no longer waiting on.
 *
 * The golden file was written by this same test at commit 4ef5d65 with
 * MAYA_WRITE_ENGINE_GOLDEN=1. Its ladder_rule_state hashes were rewritten
 * once, leaving out last_evaluated_at, from an engine that still matched the
 * original golden file in full (commit e6c532b), before that column stopped
 * being touched. Its ladder_transition_event hashes and sizes were rewritten
 * a second time when a ladder row that stays unwritten started failing the
 * run: the injected event-insert failure became one the row-by-row retry
 * recovers from, which adds exactly that event row to every run, and every
 * other count, size and hash was checked unchanged before the rewrite. Its
 * pickup_event hashes for runs 6 and 7 were rewritten a third time when
 * cancelled-pickup retirement moved ahead of the pickup pass: one decrease
 * event that run 6 fired used to be retired by that same run, and is now left
 * open until run 7 retires it (its night is over by then). Rows, counts,
 * prices and audits were checked unchanged in every run before the rewrite.
 * Every other hash is unchanged from 4ef5d65. Setting MAYA_ENGINE_DUMP=<dir> writes the full
 * normalized tables per run for diffing.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { evaluateHotel } from "./evaluate";
import {
  FakeRpcError,
  callTouchesColumn,
  fakeSupabase,
  missingColumn,
  missingFunction,
  type FakeCall,
  type FakeError,
  type FakeRow,
} from "./fake-supabase.test";
import { resetBookingSpeedLogOnce } from "./booking-speed-provider";

const GOLDEN = resolve(__dirname, "__fixtures__/engine-run-golden.json");
const WRITE = process.env.MAYA_WRITE_ENGINE_GOLDEN === "1";
const DUMP = process.env.MAYA_ENGINE_DUMP;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = "2026-06-10T13:00:00.000Z";
const LOCAL0 = "2026-06-10";
const HORIZON = 21;

const ROOM_TYPES = [
  { id: "a0000000-0000-4000-8000-000000000001", hotel_id: "h1", name: "King", is_active: true, total_rooms: 20, floor_price: 80, ceiling_price: 400, counts_as_room: true },
  { id: "a0000000-0000-4000-8000-000000000002", hotel_id: "h1", name: "Queen", is_active: true, total_rooms: 15, floor_price: 70, ceiling_price: 300, counts_as_room: true },
  { id: "a0000000-0000-4000-8000-000000000003", hotel_id: "h1", name: "Suite", is_active: true, total_rooms: 5, floor_price: 150, ceiling_price: 169.5, counts_as_room: null },
  { id: "a0000000-0000-4000-8000-000000000004", hotel_id: "h1", name: "Court", is_active: true, total_rooms: 6, floor_price: 20, ceiling_price: 60, counts_as_room: false },
];
const [KING, QUEEN, SUITE, COURT] = ROOM_TYPES.map((r) => r.id);

function rule(
  id: string,
  over: Partial<FakeRow> & { cond: FakeRow; signals: string[]; affected: string[] },
): FakeRow {
  const { cond, signals, affected, ...rest } = over;
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
    is_pickup_rule: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    rule_condition: [cond],
    rule_signal_room_type: signals.map((room_type_id) => ({ room_type_id })),
    rule_affected_room_type: affected.map((room_type_id) => ({ room_type_id })),
    ...rest,
  };
}

const RULES: FakeRow[] = [
  rule("b1000000-0000-4000-8000-000000000001", { cond: { occupancy_operator: "gt", occupancy_threshold: 0.55 }, signals: [KING, QUEEN], affected: [KING, QUEEN] }),
  rule("b1000000-0000-4000-8000-000000000002", { action_type: "fixed", action_direction: "decrease", action_value: 5, cond: { occupancy_operator: "lt", occupancy_threshold: 0.35 }, signals: [SUITE], affected: [SUITE] }),
  rule("b1000000-0000-4000-8000-000000000003", { priority: 50, action_value: 5, dow_mask: 0b0111110, cond: { occupancy_operator: "gt", occupancy_threshold: 0.4, dta_operator: "lt", dta_threshold_days: 9 }, signals: [KING, QUEEN, SUITE], affected: [KING, QUEEN, SUITE] }),
  // Every signal is a court: emptied by the room flag, still priced.
  rule("b1000000-0000-4000-8000-000000000004", { action_type: "fixed", action_value: 3, cond: { occupancy_operator: "lt", occupancy_threshold: 0.9 }, signals: [COURT], affected: [COURT] }),
  rule("b1000000-0000-4000-8000-000000000005", { start_date: addDays(LOCAL0, 5), end_date: addDays(LOCAL0, 15), created_at: "2026-06-12T00:00:00Z", cond: { occupancy_operator: "gt", occupancy_threshold: 0.3 }, signals: [KING], affected: [KING] }),
  // Pickup rules, windows 1/3/7, units and revenue.
  rule("c1000000-0000-4000-8000-000000000001", { is_pickup_rule: true, action_value: 3, cond: { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "units" }, signals: [KING], affected: [KING] }),
  rule("c1000000-0000-4000-8000-000000000002", { is_pickup_rule: true, priority: 120, action_type: "fixed", action_value: 2, cond: { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "units" }, signals: [KING, QUEEN], affected: [KING, QUEEN] }),
  rule("c1000000-0000-4000-8000-000000000003", { is_pickup_rule: true, action_direction: "decrease", action_value: 4, cond: { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 7, pickup_metric: "units" }, signals: [SUITE], affected: [SUITE] }),
  rule("c1000000-0000-4000-8000-000000000004", { is_pickup_rule: true, action_value: 1, cond: { pickup_operator: "gt", pickup_threshold: 150, pickup_window_days: 3, pickup_metric: "revenue" }, signals: [QUEEN], affected: [QUEEN, KING] }),
  // Booking speed: a ladder and an event-style rule with a cooldown.
  rule("d1000000-0000-4000-8000-000000000001", { action_value: 4, cond: { booking_speed_operator: "at_least", booking_speed_level: "normal", booking_speed_window_days: 7 }, signals: [KING, QUEEN, SUITE], affected: [KING, QUEEN] }),
  rule("d1000000-0000-4000-8000-000000000002", { is_pickup_rule: true, action_value: 2, cond: { booking_speed_operator: "at_most", booking_speed_level: "normal", booking_speed_window_days: 30, booking_speed_cooldown_days: 3 }, signals: [KING, QUEEN, SUITE], affected: [SUITE] }),
  // Switched on before run 4, after a price was typed on one of its cells.
  rule("b1000000-0000-4000-8000-000000000006", { is_active: false, action_type: "fixed", action_value: 6, cond: { occupancy_operator: "gt", occupancy_threshold: 0.05 }, signals: [KING], affected: [KING] }),
  // Paused: its live effect must stay frozen in the price.
  rule("e1000000-0000-4000-8000-000000000001", { is_active: false, cond: { occupancy_operator: "gt", occupancy_threshold: 0.1 }, signals: [KING], affected: [KING] }),
];

let resId = 0;
function booking(r: () => number, stay: string, rt: string, bookedOn: string, rate: number, createdAt: string): FakeRow {
  return {
    id: `f0000000-0000-4000-8000-${String(++resId).padStart(12, "0")}`,
    hotel_id: "h1",
    external_reservation_id: `ext-${resId}`,
    stay_date: stay,
    room_type_id: rt,
    booking_date: r() < 0.1 ? null : bookedOn,
    booking_window_days: Math.max(0, Math.round((Date.parse(stay) - Date.parse(bookedOn)) / 86_400_000)),
    current_rate: rate,
    base_rate: r() < 0.15 ? null : Math.round((rate - 10) * 100) / 100,
    created_at: createdAt,
  };
}

function seed(): Record<string, FakeRow[]> {
  resId = 0;
  const r = rng(42);
  const reservations: FakeRow[] = [];
  // Three years of history so booking speed has comparables.
  for (let off = -3 * 366; off < HORIZON + 5; off++) {
    const stay = addDays(LOCAL0, off);
    for (const rt of ROOM_TYPES) {
      const cap = rt.total_rooms;
      const fill = off < 0 ? 0.35 + 0.4 * r() : Math.max(0, 0.6 - off * 0.02) * r() + 0.1;
      const n = Math.floor(cap * fill);
      for (let k = 0; k < n; k++) {
        const lead = Math.floor(r() * 60);
        const bookedOn = addDays(stay, -lead) > LOCAL0 ? LOCAL0 : addDays(stay, -lead);
        reservations.push(booking(r, stay, rt.id, bookedOn, 90 + Math.round(r() * 12000) / 100, `${bookedOn}T0${k % 10}:00:00Z`));
      }
    }
  }
  return {
    hotels: [{ id: "h1", timezone: "America/New_York" }],
    room_types: ROOM_TYPES,
    pricing_rules: RULES,
    reservations,
    base_rate_calendar: Array.from({ length: HORIZON }, (_, i) => ({
      hotel_id: "h1", stay_date: addDays(LOCAL0, i), room_type_id: SUITE, price: 160 + (i % 4) * 5,
    })),
    published_price: [
      // Remembered base for the court, which has no base_rate anywhere else.
      ...Array.from({ length: HORIZON }, (_, i) => ({
        hotel_id: "h1", stay_date: addDays(LOCAL0, i), room_type_id: COURT, price: 40, base_price: 35, computed_at: "2026-06-01T00:00:00Z",
      })),
    ],
    ladder_rule_state: [
      { rule_id: "e1000000-0000-4000-8000-000000000001", rule_version: 1, stay_date: addDays(LOCAL0, 3), room_type_id: KING, is_active: true,
        activated_at: "2026-06-01T00:00:00Z", deactivated_at: null, last_evaluated_at: "2026-06-01T00:00:00Z",
        action_kind: "fixed", action_direction: "increase", action_value: 7 },
      // Stamped by the manual price route: still active, no longer moving the price.
      { rule_id: "e1000000-0000-4000-8000-000000000001", rule_version: 1, stay_date: addDays(LOCAL0, 4), room_type_id: KING, is_active: true,
        activated_at: "2026-06-01T00:00:00Z", deactivated_at: null, last_evaluated_at: "2026-06-01T00:00:00Z", suppressed_at: "2026-06-02T00:00:00Z",
        action_kind: "percent", action_direction: "increase", action_value: 9 },
    ],
    manual_price: [],
    hotel_closed_periods: [],
    assumption_challenges: [],
    room_type_out_of_service: [
      { id: "o1", hotel_id: "h1", room_type_id: QUEEN, start_date: addDays(LOCAL0, 2), end_date: addDays(LOCAL0, 6), units: 4, cleared_at: null },
    ],
  };
}

/** Between runs: new bookings land and some cancel. */
function churn(tables: Record<string, FakeRow[]>, step: number, nowIso: string): void {
  const r = rng(1000 + step);
  const local = nowIso.slice(0, 10);
  const res = tables.reservations;
  for (let i = res.length - 1; i >= 0; i--) {
    const stay = String(res[i].stay_date);
    if (stay >= local && r() < 0.03) res.splice(i, 1);
  }
  const adds = 25 + Math.floor(r() * 40);
  for (let k = 0; k < adds; k++) {
    const stay = addDays(local, Math.floor(r() * HORIZON));
    const rt = ROOM_TYPES[Math.floor(r() * 3)].id;
    res.push(booking(r, stay, rt, local, 100 + Math.round(r() * 9000) / 100, nowIso));
  }
  // A burst on one date so pickup rules fire.
  const burst = addDays(local, 4 + (step % 5));
  for (let k = 0; k < 4; k++) res.push(booking(r, burst, KING, local, 150, nowIso));
}

const RUNS: { at: string; horizon: number; before?: (t: Record<string, FakeRow[]>) => void }[] = [
  { at: T0, horizon: HORIZON },
  { at: "2026-06-10T13:05:00.000Z", horizon: HORIZON },
  { at: "2026-06-11T13:00:00.000Z", horizon: HORIZON },
  {
    at: "2026-06-12T09:00:00.000Z",
    horizon: HORIZON,
    before: (t) => {
      // Typed prices: one on a cell a ladder already holds, one on a cell no
      // rule has touched yet, so the first-activation probe runs.
      t.manual_price.push(
        { id: "m1", hotel_id: "h1", stay_date: addDays(LOCAL0, 8), room_type_id: KING, price: 199, set_by: "u1", set_at: "2026-06-11T13:00:00.000Z", cleared_at: null },
        { id: "m2", hotel_id: "h1", stay_date: addDays(LOCAL0, 12), room_type_id: SUITE, price: 165, set_by: "u1", set_at: "2026-06-11T13:00:00.000Z", cleared_at: null },
      );
      const late = t.pricing_rules.find((x) => x.id === "b1000000-0000-4000-8000-000000000006")!;
      late.is_active = true;
    },
  },
  { at: "2026-06-12T09:05:00.000Z", horizon: HORIZON },
  { at: "2026-06-14T09:00:00.000Z", horizon: HORIZON },
  { at: "2026-06-19T09:00:00.000Z", horizon: 9 },
  // Far enough on that the oldest snapshots, audits and run logs age out.
  { at: "2026-06-27T09:00:00.000Z", horizon: 9 },
];

/** Writes that fail, the way a transient error or a bad row would. */
function faults(extra: (c: FakeCall) => FakeError | null) {
  const hits = (c: FakeCall, pred: (p: FakeRow) => boolean) => {
    const list = Array.isArray(c.payload) ? c.payload : c.payload ? [c.payload] : [];
    return list.some(pred);
  };
  return (c: FakeCall): FakeError | null => {
    if (c.table === "published_price" && c.op === "upsert" && hits(c, (p) => p.stay_date === addDays(LOCAL0, 9) && p.room_type_id === QUEEN)) {
      return { code: "57014", message: "canceling statement due to statement timeout" };
    }
    // Fails the chunk it is in, once: the row lands on the row-by-row retry.
    // A ladder row that stays failed now fails the run before it publishes
    // (see LadderPassBatch), which engine-guardrails.test.ts covers.
    if (
      c.table === "ladder_transition_event" &&
      c.op === "insert" &&
      Array.isArray(c.payload) &&
      c.payload.length > 1 &&
      hits(c, (p) => p.stay_date === addDays(LOCAL0, 11) && p.room_type_id === QUEEN)
    ) {
      return { code: "08006", message: "connection failure" };
    }
    if (c.table === "evaluation_audit" && c.op === "insert" && hits(c, (p) => p.stay_date === addDays(LOCAL0, 13) && p.room_type_id === KING)) {
      return { code: "08006", message: "connection failure" };
    }
    return extra(c);
  };
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function normalizeTables(tables: Record<string, FakeRow[]>) {
  const eventKey = new Map<string, string>();
  for (const e of tables.pickup_event ?? []) {
    eventKey.set(String(e.id), `${e.rule_id}|${e.stay_date}|${e.affected_room_type_id}|${e.applied_at}`);
  }
  const swapEventIds = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith("pickup:") && eventKey.has(v.slice(7))) return `pickup:${eventKey.get(v.slice(7))}`;
      return eventKey.get(v) ?? v;
    }
    if (Array.isArray(v)) return v.map(swapEventIds);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = swapEventIds(x);
      return out;
    }
    return v;
  };
  const rows = (name: string, drop: string[] = []) =>
    (tables[name] ?? [])
      .map((r) => {
        const copy: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(r)) if (!drop.includes(k)) copy[k] = swapEventIds(x);
        return JSON.stringify(canonical(copy));
      })
      .sort();
  // Tables keyed by their natural key carry no meaningful id; the fake
  // numbers every row it writes, in write order.
  return {
    published_price: rows("published_price", ["id"]),
    // last_evaluated_at is left out: the engine stopped rewriting it on every
    // tick for rows whose state did not change, and nothing prices off it.
    ladder_rule_state: rows("ladder_rule_state", ["id", "last_evaluated_at"]),
    ladder_transition_event: rows("ladder_transition_event", ["id"]),
    pickup_event: rows("pickup_event", ["id"]),
    evaluation_audit: rows("evaluation_audit", ["id", "evaluation_run_id"]),
    // The nights a run priced are logged since the push guardrails; the
    // pre-batching engine had no such columns, and every other one is compared.
    evaluation_run_log: rows("evaluation_run_log", ["id", "evaluation_run_id", "first_stay_date", "last_stay_date"]),
    stay_date_snapshot: rows("stay_date_snapshot", ["id"]),
  };
}

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

type Variant = { name: string; fault: (c: FakeCall) => FakeError | null; rpc?: (fn: string) => unknown };

const VARIANTS: Variant[] = [
  { name: "migrated, suppression supported", fault: faults(() => null) },
  {
    name: "pre-migration, no suppressed_at column",
    fault: faults((c) =>
      c.table === "ladder_rule_state" && callTouchesColumn(c, "suppressed_at") ? missingColumn("ladder_rule_state", "suppressed_at") : null,
    ),
    // Every function of the large property migration is missing, so each
    // caller takes its old path. pickup_fire_heads is not one of those: the
    // stacking migration has no pre-migration path (a run with no fire
    // history would stack on every tick), so it answers here.
    rpc: (fn) => (fn === "pickup_fire_heads" ? undefined : new FakeRpcError(missingFunction(fn))),
  },
];

beforeEach(() => {
  resetBookingSpeedLogOnce();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("evaluation run equivalence against the pre-batching engine", () => {
  const golden: Record<string, unknown> = WRITE ? {} : JSON.parse(readFileSync(GOLDEN, "utf8"));

  it.each(VARIANTS)("$name", async (variant) => {
    const { client, tables, calls } = fakeSupabase(seed(), {
      fault: variant.fault,
      ...(variant.rpc ? { rpc: variant.rpc } : {}),
    });
    const perRun: unknown[] = [];
    for (const [i, run] of RUNS.entries()) {
      vi.setSystemTime(new Date(run.at));
      if (i > 0) churn(tables, i, run.at);
      run.before?.(tables);
      const callsBefore = calls.length;
      const result = await evaluateHotel(client, "h1", run.at, run.horizon);
      if (process.env.MAYA_ENGINE_CALLS) {
        const byTable: Record<string, number> = {};
        for (const c of calls.slice(callsBefore)) byTable[`${c.table}:${c.op}`] = (byTable[`${c.table}:${c.op}`] ?? 0) + 1;
        process.stdout.write(`CALLS ${variant.name} run${i} total=${calls.length - callsBefore} ${JSON.stringify(byTable)}\n`);
      }
      const normalized = normalizeTables(tables);
      const { run_id: _runId, ...counts } = result;
      void _runId;
      if (DUMP) {
        mkdirSync(DUMP, { recursive: true });
        writeFileSync(resolve(DUMP, `${variant.name.replace(/\W+/g, "_")}-run${i}.json`), JSON.stringify({ counts, normalized }, null, 1));
      }
      perRun.push({
        counts,
        sizes: Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, v.length])),
        hashes: Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, sha(v)])),
      });
    }
    if (WRITE) {
      golden[variant.name] = perRun;
      mkdirSync(resolve(__dirname, "__fixtures__"), { recursive: true });
      const existing = (() => {
        try {
          return JSON.parse(readFileSync(GOLDEN, "utf8"));
        } catch {
          return {};
        }
      })();
      writeFileSync(GOLDEN, JSON.stringify({ ...existing, ...golden }, null, 2) + "\n");
      return;
    }
    expect(perRun).toEqual((golden as Record<string, unknown>)[variant.name]);
  }, 120_000);
});

describe("a Booking Speed rule measuring only some room types", () => {
  // The golden rules share objects with seed(), and run 4 switches one on.
  // Each run here starts from its own copy with that rule off again.
  const freshSeed = (extra: FakeRow[]) => {
    const tables = seed();
    tables.pricing_rules = structuredClone(RULES).map((r) =>
      r.id === "b1000000-0000-4000-8000-000000000006" ? { ...r, is_active: false } : r,
    );
    tables.pricing_rules.push(...extra);
    return tables;
  };
  const SUITE_ONLY = rule("d1000000-0000-4000-8000-000000000009", {
    priority: 90,
    action_value: 7,
    cond: { booking_speed_operator: "at_least", booking_speed_level: "stalled", booking_speed_window_days: 7 },
    signals: [SUITE],
    affected: [SUITE],
  });

  async function runAll(variant: Variant, extra: FakeRow[]) {
    const { client, tables } = fakeSupabase(freshSeed(extra), {
      fault: variant.fault,
      ...(variant.rpc ? { rpc: variant.rpc } : {}),
    });
    const perRun: ReturnType<typeof normalizeTables>[] = [];
    for (const [i, run] of RUNS.entries()) {
      vi.setSystemTime(new Date(run.at));
      if (i > 0) churn(tables, i, run.at);
      run.before?.(tables);
      await evaluateHotel(client, "h1", run.at, run.horizon);
      perRun.push(normalizeTables(tables));
    }
    return perRun;
  }

  const notSuite = (rows: string[], col = "room_type_id") =>
    rows.filter((r) => (JSON.parse(r) as Record<string, unknown>)[col] !== SUITE);

  const withoutObservations = (rows: string[]) =>
    rows.map((r) => {
      const row = JSON.parse(r) as Record<string, unknown>;
      const details = { ...(row.details as Record<string, unknown>) };
      delete details.booking_speed_observations;
      return JSON.stringify({ ...row, details });
    });

  it.each(VARIANTS)("$name: every other room type's prices, ladders, events and audits are unchanged", async (variant) => {
    const before = await runAll(variant, []);
    const after = await runAll(variant, [SUITE_ONLY]);
    let suiteObservations = 0;
    for (const [i, a] of after.entries()) {
      const b = before[i];
      expect(notSuite(a.published_price)).toEqual(notSuite(b.published_price));
      expect(notSuite(a.ladder_rule_state)).toEqual(notSuite(b.ladder_rule_state));
      expect(notSuite(a.ladder_transition_event)).toEqual(notSuite(b.ladder_transition_event));
      expect(notSuite(a.pickup_event, "affected_room_type_id")).toEqual(notSuite(b.pickup_event, "affected_room_type_id"));
      // Everything a room's audit row says about its own price: identical.
      //
      // Not the hotel-wide Booking Speed observations it also carries. A run
      // records every observation it made for the night on every cell of that
      // night, and the Suite rule moves the Suite's price, which decides
      // whether the Suite's own event rule may fire there — and so whether
      // its 30-day observation was made at all. That list changing on a King
      // row is this run consulting a different window, not the King being
      // priced differently.
      expect(withoutObservations(notSuite(a.evaluation_audit))).toEqual(
        withoutObservations(notSuite(b.evaluation_audit)),
      );
      expect(a.stay_date_snapshot).toEqual(b.stay_date_snapshot);
      for (const row of a.evaluation_audit.map((r) => JSON.parse(r) as FakeRow)) {
        const observations = ((row.details as FakeRow).booking_speed_observations ?? []) as FakeRow[];
        const measured = observations.filter((o) => o.measuredRoomTypeIds);
        if (row.room_type_id !== SUITE) expect(measured).toEqual([]);
        for (const o of measured) expect(o.measuredRoomTypeIds).toEqual([SUITE]);
        suiteObservations += measured.length;
      }
    }
    expect(suiteObservations).toBeGreaterThan(0);
    // It really did something to the Suites.
    expect(after.some((a, i) => a.ladder_rule_state.length !== before[i].ladder_rule_state.length)).toBe(true);
  }, 240_000);
});
