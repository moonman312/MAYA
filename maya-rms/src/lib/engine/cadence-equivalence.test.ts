/**
 * The pricing cadence against pricing every night every tick.
 *
 * Jake's rule (2026-09-17, made exact 2026-09-28): time alone never moves
 * a price in the middle of the day. Pickup count windows and rule waits
 * count whole hotel days, cut rules judge complete days ending yesterday
 * and raise rules count today so far. So pricing every night once a hotel
 * day plus, every tick, the nights whose inputs changed (and the nights a
 * run changed a rule's state on, and the nights that lean on a changed
 * neighbour) gives the prices that pricing every night every tick would.
 * Here the two run side by side on two copies of one hotel:
 *
 *   A  evaluateHotel over the whole window at every tick (the old cadence);
 *   B  runPricingTick with the daily cadence: pricing_work, the planner, the
 *      engine over the planned nights, pricing_run_done, all against the
 *      fake's model of the cadence functions (cadence-rpc-model.test.ts),
 *      with the database triggers emulated where the test changes a table
 *      they watch.
 *
 * Both see the same ticks and the same changes between them: bookings made,
 * cancelled, moved, re-rated and moved between room types; typed prices set
 * and cleared (with the save's own run); a rule edited, paused and switched
 * back on; rooms taken out of service and back; a closed period; base rates
 * moving; the owner answering the three-changes alert; the time zone
 * changing; a hotel midnight every day and the end of daylight saving time.
 * After every tick every published price, ladder state and change, rule
 * change (pickup_event), audit row and repeat-alert row must be the same.
 * Snapshots and the run log are not compared: B writes fewer of them, which
 * is the point.
 *
 * The hand-written cases pin the moments that used to move a price with
 * the clock and now wait for the hotel's midnight: a rule's wait ending
 * with the rule still true, a booking leaving a pickup window, a "fewer
 * than" pickup rule able to judge a whole window again, a typed price's
 * wait ending; and a momentum night moved by a booking on a neighbour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/observations/calendar";
import { runPricingTick } from "../../../supabase/functions/_shared/pms/pricing-tick";
import type { CadenceConfig } from "../../../supabase/functions/_shared/pms/pricing-plan";
import { resetBookingSpeedLogOnce } from "./booking-speed-provider";
import { cadenceRpc, markBookingChanges, markHotel, markNights, markRange } from "./cadence-rpc-model.test";
import { evaluateHotel, type EvaluateOptions } from "./evaluate";
import { fakeSupabase, type FakeRow } from "./fake-supabase.test";
import type { SupabaseClient } from "@supabase/supabase-js";

type Tables = Record<string, FakeRow[]>;
type Fake = ReturnType<typeof fakeSupabase>;

const H = "h1";
const DAY = 86_400_000;
const MIN = 60_000;

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

const ROOM_TYPES = [
  { id: "a0000000-0000-4000-8000-000000000001", hotel_id: H, name: "King", is_active: true, total_rooms: 12, floor_price: 80, ceiling_price: 400, counts_as_room: true },
  { id: "a0000000-0000-4000-8000-000000000002", hotel_id: H, name: "Queen", is_active: true, total_rooms: 10, floor_price: 70, ceiling_price: 300, counts_as_room: true },
  { id: "a0000000-0000-4000-8000-000000000003", hotel_id: H, name: "Suite", is_active: true, total_rooms: 4, floor_price: 150, ceiling_price: 260, counts_as_room: null },
];
const [KING, QUEEN, SUITE] = ROOM_TYPES.map((r) => r.id);

function rule(id: string, over: Partial<FakeRow> & { cond: FakeRow; signals: string[]; affected: string[] }): FakeRow {
  const { cond, signals, affected, ...rest } = over;
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
    is_pickup_rule: false,
    undo_on_cancellation: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    rule_condition: [cond],
    rule_signal_room_type: signals.map((room_type_id) => ({ room_type_id })),
    rule_affected_room_type: affected.map((room_type_id) => ({ room_type_id })),
    ...rest,
  };
}

/** Every kind of rule, and every clock the engine reads: pickup windows of 1, 3 and 7 days, counts from a change, and waits. */
export const RULES: FakeRow[] = [
  rule("b1000000-0000-4000-8000-000000000001", { cond: { occupancy_operator: "gt", occupancy_threshold: 0.55 }, signals: [KING, QUEEN], affected: [KING, QUEEN] }),
  rule("b1000000-0000-4000-8000-000000000002", { action_type: "fixed", action_direction: "decrease", action_value: 5, cond: { occupancy_operator: "lt", occupancy_threshold: 0.3 }, signals: [SUITE], affected: [SUITE] }),
  rule("b1000000-0000-4000-8000-000000000003", { priority: 50, action_value: 5, dow_mask: 0b0111110, cond: { occupancy_operator: "gt", occupancy_threshold: 0.35, dta_operator: "lt", dta_threshold_days: 9 }, signals: [KING, QUEEN, SUITE], affected: [KING, QUEEN, SUITE] }),
  // Pickup count rules: 1, 3 and 7 days, units and revenue, "more than" and "fewer than".
  rule("c1000000-0000-4000-8000-000000000001", { is_pickup_rule: true, action_value: 3, cond: { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "units" }, signals: [KING], affected: [KING] }),
  rule("c1000000-0000-4000-8000-000000000002", { is_pickup_rule: true, priority: 120, action_type: "fixed", action_value: 2, cond: { pickup_operator: "gt", pickup_threshold: 1, pickup_window_days: 3, pickup_metric: "units", pickup_cooldown_days: 1 }, signals: [KING, QUEEN], affected: [KING, QUEEN] }),
  rule("c1000000-0000-4000-8000-000000000003", { is_pickup_rule: true, action_direction: "decrease", action_value: 4, cond: { pickup_operator: "lt", pickup_threshold: 1, pickup_window_days: 1, pickup_metric: "units" }, signals: [SUITE], affected: [SUITE] }),
  rule("c1000000-0000-4000-8000-000000000004", { is_pickup_rule: true, action_value: 1, cond: { pickup_operator: "gt", pickup_threshold: 150, pickup_window_days: 3, pickup_metric: "revenue" }, signals: [QUEEN], affected: [QUEEN, KING] }),
  // Fires on every hot night every day: three changes file the night for the owner.
  rule("c1000000-0000-4000-8000-000000000005", { is_pickup_rule: true, priority: 10, action_value: 1, cond: { pickup_operator: "gt", pickup_threshold: 0, pickup_window_days: 1, pickup_metric: "units", pickup_cooldown_days: 1 }, signals: [QUEEN], affected: [QUEEN] }),
  // Booking speed: a ladder, a raise counting today so far, a cut on complete days.
  rule("d1000000-0000-4000-8000-000000000001", { action_value: 4, cond: { booking_speed_operator: "at_least", booking_speed_level: "normal", booking_speed_window_days: 7 }, signals: [KING, QUEEN, SUITE], affected: [KING, QUEEN] }),
  rule("d1000000-0000-4000-8000-000000000002", { is_pickup_rule: true, action_value: 2, cond: { booking_speed_operator: "at_most", booking_speed_level: "normal", booking_speed_window_days: 30, booking_speed_cooldown_days: 3 }, signals: [KING, QUEEN, SUITE], affected: [SUITE] }),
  rule("d1000000-0000-4000-8000-000000000003", { is_pickup_rule: true, action_direction: "decrease", action_value: 5, cond: { booking_speed_operator: "at_most", booking_speed_level: "slow", booking_speed_window_days: 7, booking_speed_cooldown_days: 1 }, signals: [KING, QUEEN, SUITE], affected: [KING] }),
  rule("d1000000-0000-4000-8000-000000000004", { is_pickup_rule: true, action_value: 6, cond: { booking_speed_operator: "at_least", booking_speed_level: "fast", booking_speed_window_days: 1, booking_speed_cooldown_days: 1 }, signals: [KING, QUEEN, SUITE], affected: [QUEEN] }),
  // Paused with a live effect: frozen in the price.
  rule("e1000000-0000-4000-8000-000000000001", { is_active: false, cond: { occupancy_operator: "gt", occupancy_threshold: 0.1 }, signals: [KING], affected: [KING] }),
];

let resId = 0;
function booking(r: () => number, stay: string, rt: string, bookedOn: string, rate: number, createdAt: string): FakeRow {
  return {
    id: `f0000000-0000-4000-8000-${String(++resId).padStart(12, "0")}`,
    hotel_id: H,
    external_reservation_id: `ext-${resId}`,
    stay_date: stay,
    room_type_id: rt,
    booking_date: bookedOn,
    booking_window_days: Math.max(0, Math.round((Date.parse(stay) - Date.parse(bookedOn)) / DAY)),
    current_rate: rate,
    base_rate: Math.round((rate - 10) * 100) / 100,
    created_at: createdAt,
  };
}

/**
 * A hotel with two years of history. No past Tuesday has a booking, so a
 * Tuesday's comparable nights have no history and its Booking Speed reading
 * falls back to momentum: how the nights around it are selling now.
 */
export function seedHotel(local0: string, horizon: number): Tables {
  resId = 0;
  const r = rng(42);
  const reservations: FakeRow[] = [];
  for (let off = -2 * 366; off < horizon + 12; off++) {
    const stay = addDays(local0, off);
    const tuesday = new Date(`${stay}T00:00:00Z`).getUTCDay() === 2;
    if (off < 0 && tuesday) continue;
    for (const rt of ROOM_TYPES) {
      const fill = off < 0 ? 0.35 + 0.4 * r() : Math.max(0, 0.55 - off * 0.012) * r() + 0.08;
      const n = Math.floor(rt.total_rooms * fill);
      for (let k = 0; k < n; k++) {
        const lead = Math.floor(r() * 60);
        const bookedOn = addDays(stay, -lead) > local0 ? addDays(local0, -1) : addDays(stay, -lead);
        reservations.push(booking(r, stay, rt.id, bookedOn, 90 + Math.round(r() * 12000) / 100, `${bookedOn}T0${k % 10}:00:00Z`));
      }
    }
  }
  return {
    hotels: [{ id: H, timezone: "America/New_York" }],
    hotel_settings: [{ hotel_id: H, simulation_mode: true }],
    room_types: ROOM_TYPES.map((rt) => ({ ...rt })),
    pricing_rules: structuredClone(RULES),
    reservations,
    base_rate_calendar: Array.from({ length: horizon + 40 }, (_, i) =>
      ROOM_TYPES.map((rt, j) => ({ hotel_id: H, stay_date: addDays(local0, i - 2), room_type_id: rt.id, price: 120 + j * 25 + (i % 5) * 4 })),
    ).flat(),
    published_price: [],
    ladder_rule_state: [
      {
        rule_id: "e1000000-0000-4000-8000-000000000001", rule_version: 1, stay_date: addDays(local0, 3), room_type_id: KING,
        is_active: true, activated_at: "2026-06-01T00:00:00Z", deactivated_at: null, last_evaluated_at: "2026-06-01T00:00:00Z",
        action_kind: "fixed", action_direction: "increase", action_value: 7,
      },
    ],
    manual_price: [],
    hotel_closed_periods: [],
    assumption_challenges: [],
    room_type_out_of_service: [],
    pickup_event: [],
    rule_repeat_alerts: [],
    rule_repeat_alert_nights: [],
  };
}

/** Tables to compare, rows as sorted JSON without the ids each fake numbers on its own. */
export function normalize(tables: Tables): Record<string, string[]> {
  const eventKey = new Map<string, string>();
  for (const e of tables.pickup_event ?? []) {
    eventKey.set(String(e.id), `${e.rule_id}|${e.stay_date}|${e.affected_room_type_id}|${e.fire_seq}|${e.applied_at}`);
  }
  const alertKey = new Map<string, string>();
  for (const a of tables.rule_repeat_alerts ?? []) alertKey.set(String(a.id), `${a.rule_id}|${a.rule_version}|${a.opened_at}`);
  const swap = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith("pickup:") && eventKey.has(v.slice(7))) return `pickup:${eventKey.get(v.slice(7))}`;
      return eventKey.get(v) ?? alertKey.get(v) ?? v;
    }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = swap((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  const rows = (name: string, drop: string[] = []) =>
    (tables[name] ?? [])
      .map((r) => {
        const copy: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(r)) if (!drop.includes(k)) copy[k] = x;
        return JSON.stringify(swap(copy));
      })
      .sort();
  return {
    published_price: rows("published_price", ["id"]),
    ladder_rule_state: rows("ladder_rule_state", ["id", "last_evaluated_at"]),
    ladder_transition_event: rows("ladder_transition_event", ["id"]),
    pickup_event: rows("pickup_event", ["id"]),
    evaluation_audit: rows("evaluation_audit", ["id", "evaluation_run_id"]),
    rule_repeat_alerts: rows("rule_repeat_alerts", ["id"]),
    rule_repeat_alert_nights: rows("rule_repeat_alert_nights", ["id"]),
  };
}

/** The daily cadence with a pass chunk covering the whole window unless a case says otherwise. */
const WHOLE_PASS: CadenceConfig = {
  chunkNights: 132,
  runMaxNights: 264,
  tickPassNights: 100_000,
  passMinTimeMs: 0,
  passMaxLagMinutes: 120,
};

export type World = {
  a: Fake;
  b: Fake;
  horizon: number;
  /** Nights B priced at each tick. */
  priced: Map<string, string[]>;
  /** Apply one change to both copies, with the marks the triggers would write in B. */
  change: (atMs: number, op: (t: Tables) => void, marks?: (t: Tables, now: string) => void) => void;
  /** One tick at `atMs`: A over the window, B by the cadence. */
  tick: (atMs: number, opts?: { failRecord?: boolean; skip?: boolean }) => Promise<void>;
  /** A typed price's own run in both, at `atMs`, over the nights typed. */
  save: (atMs: number, nights: string[]) => Promise<void>;
};

export function world(seed: Tables, horizon: number, config: CadenceConfig = WHOLE_PASS): World {
  const a = fakeSupabase(seed);
  const b = fakeSupabase(structuredClone(seed), { rpc: (fn, args, tables) => cadenceRpc(fn, args, tables) });
  const priced = new Map<string, string[]>();
  let failRecord = false;
  const bClient = new Proxy(b.client, {
    get(target, prop) {
      if (prop !== "rpc") return (target as unknown as Record<string | symbol, unknown>)[prop];
      return (fn: string, args: unknown) => {
        if (fn === "pricing_run_done" && failRecord) {
          failRecord = false;
          return {
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "08006", message: "connection failure" } }).then(res),
          };
        }
        return (target as unknown as { rpc: (f: string, a: unknown) => unknown }).rpc(fn, args);
      };
    },
  }) as SupabaseClient;
  return {
    a,
    b,
    horizon,
    priced,
    change(atMs, op, marks) {
      const now = iso(atMs);
      const before = b.tables.reservations.map((r) => ({ ...r }));
      op(a.tables);
      op(b.tables);
      markBookingChanges(b.tables, before, b.tables.reservations, now);
      marks?.(b.tables, now);
    },
    async tick(atMs, opts = {}) {
      vi.setSystemTime(new Date(atMs));
      const at = iso(atMs);
      if (opts.skip) return;
      await evaluateHotel(a.client, H, at, horizon);
      failRecord = opts.failRecord ?? false;
      let nights: string[] = [];
      const res = await runPricingTick(
        bClient,
        H,
        {
          horizonDays: horizon,
          adapter: null,
          noAdapter: { skipped: "disabled" },
          runEvaluate: true,
          pushEnabled: false,
          evaluateBy: atMs + 10 * MIN,
          pushDeadlineAt: atMs + 10 * MIN,
          read: "ok",
          cadence: "daily",
          cadenceConfig: config,
        },
        {
          evaluate: async (s: SupabaseClient, h: string, evalTs: string | undefined, hz: number, o?: EvaluateOptions) => {
            nights = o?.nights ? [...o.nights] : ["(window)"];
            return evaluateHotel(s, h, evalTs, hz, o);
          },
          now: () => atMs,
        },
      );
      if ("error" in res.evaluate) throw new Error(`B's tick failed at ${at}: ${res.evaluate.error}`);
      priced.set(at, nights);
    },
    async save(atMs, nights) {
      vi.setSystemTime(new Date(atMs));
      for (const f of [a, b]) await evaluateHotel(f.client, H, iso(atMs), horizon, { nights, runKind: "save" });
    },
  };
}

export function expectSame(w: World, at: string): void {
  const na = normalize(w.a.tables);
  const nb = normalize(w.b.tables);
  for (const table of Object.keys(na)) {
    const onlyA = na[table].filter((x) => !nb[table].includes(x));
    const onlyB = nb[table].filter((x) => !na[table].includes(x));
    if (onlyA.length > 0 || onlyB.length > 0) {
      throw new Error(
        `${table} differs after the tick at ${at}:\n  only pricing every night: ${onlyA.slice(0, 3).join("\n    ")}\n  only the cadence: ${onlyB.slice(0, 3).join("\n    ")}`,
      );
    }
  }
}

beforeEach(() => {
  resetBookingSpeedLogOnce();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Ticks for one UTC day: every five minutes through the busy hour (13:00 to
 * 14:00, when the changes arrive) and through the hours around the hotel's
 * midnight (03:30 to 05:30: 04:00 while New York is on daylight time, 05:00
 * after), and every two hours in between, so the hotel never goes 12 hours
 * without a run. A change at a busy tick leaves a 1, 3 or 7 day window at a
 * busy tick, and a wait from a busy or midnight tick ends at one.
 */
export function ticksFor(dayStartMs: number): number[] {
  const out = new Set<number>();
  for (let m = 13 * 60; m <= 14 * 60; m += 5) out.add(dayStartMs + m * MIN);
  for (let m = 3 * 60 + 30; m <= 5 * 60 + 30; m += 5) out.add(dayStartMs + m * MIN);
  for (const h of [0, 2, 7, 9, 11, 16, 18, 20, 22]) out.add(dayStartMs + h * 60 * MIN);
  return [...out].sort((x, y) => x - y);
}

describe("the daily pass plus touched nights prices every night the way pricing every night every tick does", () => {
  it("over eight days of changes, a daylight saving change and a time zone change", async () => {
    const LOCAL0 = "2026-10-28";
    const HORIZON = 30;
    const w = world(seedHotel(LOCAL0, HORIZON), HORIZON);
    const start = Date.parse("2026-10-28T00:00:00Z");
    const r = rng(7);
    let ticks = 0;
    let midnightFires = 0;
    let momentumPriced = 0;
    let alertsAnswered = 0;
    let pricedByB = 0;
    let pricedByA = 0;

    const days = Number(process.env.MAYA_CADENCE_DAYS ?? 8);
    for (let day = 0; day < days; day++) {
      for (const atMs of ticksFor(start + day * DAY)) {
        const at = iso(atMs);
        const minute = new Date(atMs).getUTCHours() * 60 + new Date(atMs).getUTCMinutes();
        const busy = minute >= 13 * 60 && minute <= 14 * 60;
        const tz = String(w.a.tables.hotels[0].timezone);
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(atMs));
        if (busy) {
          // Bookings: new ones, a cancellation, a move, a room type change, a
          // new rate. Chosen once, from A's copy (the reservations are the
          // same in both), and applied to both by id.
          const g = rng(1000 + ticks);
          const adds: FakeRow[] = [];
          for (let k = Math.floor(g() * 4); k > 0; k--) {
            const stay = addDays(today, Math.floor(g() * HORIZON));
            adds.push(booking(g, stay, ROOM_TYPES[Math.floor(g() * 3)].id, today, 100 + Math.round(g() * 9000) / 100, at));
          }
          // A night that keeps selling, so a rule fires on it three times.
          if (minute === 13 * 60 + 5) adds.push(booking(g, addDays(today, 6), QUEEN, today, 140, at));
          const future = w.a.tables.reservations.filter((x) => String(x.stay_date) >= today);
          const pick = () => String(future[Math.floor(g() * future.length)].id);
          const cancel = g() < 0.5 ? pick() : null;
          const move = g() < 0.2 ? { id: pick(), to: addDays(today, 1 + Math.floor(g() * (HORIZON - 2))) } : null;
          const retype = g() < 0.2 ? { id: pick(), to: ROOM_TYPES[Math.floor(g() * 3)].id } : null;
          const rerate = g() < 0.2 ? { id: pick(), to: 95 + Math.round(g() * 5000) / 100 } : null;
          w.change(atMs, (t) => {
            const res = t.reservations;
            for (const row of adds) res.push({ ...row });
            const byId = (id: string) => res.find((x) => x.id === id);
            if (cancel) res.splice(res.indexOf(byId(cancel)!), 1);
            if (move && byId(move.id)) byId(move.id)!.stay_date = move.to;
            if (retype && byId(retype.id)) byId(retype.id)!.room_type_id = retype.to;
            if (rerate && byId(rerate.id)) byId(rerate.id)!.current_rate = rerate.to;
          });
        }
        // Owner edits, once each, at set moments.
        const stamp = `${day}@${minute}`;
        if (stamp === "1@790") {
          // A typed price on two nights, with its own run just before the tick.
          const nights = [addDays(today, 4), addDays(today, 5)];
          w.change(atMs - 2 * MIN, (t) => {
            for (const n of nights) {
              t.manual_price.push({ hotel_id: H, stay_date: n, room_type_id: KING, price: 222, set_by: "u1", set_at: iso(atMs - 2 * MIN), cleared_at: null });
            }
          }, (t, now) => markNights(t, H, nights, "manual_price", now));
          await w.save(atMs - 2 * MIN, nights);
        }
        if (stamp === "3@785") {
          const n = addDays(today, 3);
          w.change(atMs, (t) => {
            for (const m of t.manual_price) if (String(m.stay_date) <= n) m.cleared_at = at;
          }, (t, now) => markNights(t, H, t.manual_price.map((m) => String(m.stay_date)), "manual_price", now));
        }
        if (stamp === "2@800") {
          // A rule edited: new version, new threshold.
          w.change(atMs, (t) => {
            const edit = t.pricing_rules.find((x) => x.id === "b1000000-0000-4000-8000-000000000001")!;
            edit.version = 2;
            edit.updated_at = at;
            (edit.rule_condition as FakeRow[])[0].occupancy_threshold = 0.5;
          }, (t, now) => markHotel(t, H, now));
        }
        if (stamp === "4@790") {
          // Paused, then on again two days later.
          w.change(atMs, (t) => {
            t.pricing_rules.find((x) => x.id === "c1000000-0000-4000-8000-000000000002")!.is_active = false;
          }, (t, now) => markHotel(t, H, now));
        }
        if (stamp === "6@790") {
          w.change(atMs, (t) => {
            t.pricing_rules.find((x) => x.id === "c1000000-0000-4000-8000-000000000002")!.is_active = true;
          }, (t, now) => markHotel(t, H, now));
        }
        if (stamp === "2@795") {
          // Rooms out of service, then back.
          w.change(atMs, (t) => {
            t.room_type_out_of_service.push({ id: "o1", hotel_id: H, room_type_id: KING, start_date: addDays(today, 2), end_date: addDays(today, 9), units: 5, cleared_at: null });
          }, (t, now) => markRange(t, H, addDays(today, 2), addDays(today, 9), "out_of_service", now));
        }
        if (stamp === "5@795") {
          w.change(atMs, (t) => {
            t.room_type_out_of_service.find((x) => x.id === "o1")!.cleared_at = at;
          }, (t, now) => {
            const o = t.room_type_out_of_service.find((x) => x.id === "o1")!;
            markRange(t, H, String(o.start_date), String(o.end_date), "out_of_service", now);
          });
        }
        if (stamp === "3@800") {
          // A closed period: those nights stop being compared with others.
          w.change(atMs, (t) => {
            t.hotel_closed_periods.push({ hotel_id: H, start_date: "2025-12-20", end_date: "2025-12-31" });
          }, (t, now) => markHotel(t, H, now));
        }
        if (busy && day >= 1 && minute === 13 * 60 + 40) {
          // Base rates move on a few nights.
          const nights = [addDays(today, 7 + day), addDays(today, 11 + day)];
          w.change(atMs, (t) => {
            for (const c of t.base_rate_calendar) if (nights.includes(String(c.stay_date)) && c.room_type_id === SUITE) c.price = Number(c.price) + 9;
          }, (t, now) => markNights(t, H, nights, "base_rate", now));
        }
        if (busy && minute === 13 * 60 + 20) {
          // The owner answers any night the three-changes alert filed: stop
          // on the first, keep adjusting on the next, let the first run again later.
          const open = w.a.tables.rule_repeat_alert_nights.filter((n) => n.choice == null && n.closed_at == null);
          const stopped = w.a.tables.rule_repeat_alert_nights.filter((n) => n.choice === "stop");
          const target = open[0] ?? (day >= 6 ? stopped[0] : undefined);
          if (target) {
            const key = (n: FakeRow) => `${n.rule_id}|${n.stay_date}|${n.rule_version}`;
            const k = key(target);
            const choice = target.choice === "stop" ? null : alertsAnswered % 2 === 0 ? "stop" : "keep_adjusting";
            w.change(atMs, (t) => {
              for (const n of t.rule_repeat_alert_nights) {
                if (key(n) !== k) continue;
                if (choice === null) {
                  n.choice = null;
                  n.chosen_at = null;
                  n.closed_at = at;
                  n.closed_reason = "resumed";
                } else {
                  n.choice = choice;
                  n.chosen_at = at;
                }
              }
            }, (t, now) => markNights(t, H, [String(target.stay_date)], "alert_answer", now));
            alertsAnswered++;
          }
        }
        if (stamp === "7@785") {
          // The property moves west: its date goes back an hour or three.
          w.change(atMs, (t) => {
            t.hotels[0].timezone = "America/Los_Angeles";
          }, (t, now) => markHotel(t, H, now));
        }

        await w.tick(atMs, { failRecord: stamp === "5@800" });
        if (process.env.MAYA_CADENCE_DEBUG && at >= process.env.MAYA_CADENCE_DEBUG) {
          const n = process.env.MAYA_CADENCE_NIGHT ?? "2026-11-03";
          const pe = (t: Tables) => t.pickup_event.filter((e) => e.stay_date === n).map((e) => `${String(e.rule_id).slice(0, 8)} ${String(e.affected_room_type_id).slice(-1)} seq${e.fire_seq} ${e.applied_at} ${e.retired_at ?? "open"}`);
          process.stdout.write(`DBG ${at} priced=${JSON.stringify(w.priced.get(at))}\nA ${JSON.stringify(pe(w.a.tables))}\nB ${JSON.stringify(pe(w.b.tables))}\n`);
        }
        expectSame(w, at);
        ticks++;
        const nights = w.priced.get(at) ?? [];
        pricedByB += nights.length;
        pricedByA += HORIZON;
        const state = w.b.tables.hotel_pricing_state?.[0];
        // Changes made by the first run of a hotel day with nothing booked
        // since the last tick: what used to happen at the minute a wait or a
        // window ran out now happens at the midnight after.
        if (!busy) midnightFires += w.a.tables.pickup_event.filter((e) => e.applied_at === at).length;
        momentumPriced += nights.filter((n) => (state?.momentum_nights as string[] | undefined)?.includes(n)).length;
      }
    }

    // It ran long enough to matter, and B did much less work for the same prices.
    process.stdout.write(`CADENCE-EQUIVALENCE ticks=${ticks} nightsA=${pricedByA} nightsB=${pricedByB} fires=${w.a.tables.pickup_event.length} alerts=${alertsAnswered} momentum=${momentumPriced} midnightFires=${midnightFires}\n`);
    if (days < 8) return;
    expect(ticks).toBeGreaterThan(300);
    expect(midnightFires).toBeGreaterThan(0);
    expect(momentumPriced).toBeGreaterThan(0);
    expect(alertsAnswered).toBeGreaterThan(0);
    expect(w.a.tables.pickup_event.length).toBeGreaterThan(10);
    expect(pricedByB).toBeLessThan(pricedByA / 3);
  }, 900_000);
});

describe("the moments that used to move a price with the clock", () => {
  const LOCAL0 = "2026-10-28";
  const HORIZON = 12;
  const at = (day: number, hhmm: string) => Date.parse(`${addDays(LOCAL0, day)}T${hhmm}:00.000Z`);

  it("a wait ends as the hotel's day begins: both raise again at the first tick after midnight, and the cadence prices that night then and not before", async () => {
    // More than 0 new bookings in 3 days, +5%, waiting a day.
    const seed = seedHotel(LOCAL0, HORIZON);
    seed.pricing_rules = [
      rule("c9000000-0000-4000-8000-000000000001", {
        is_pickup_rule: true,
        action_value: 5,
        cond: { pickup_operator: "gt", pickup_threshold: 0, pickup_window_days: 3, pickup_metric: "units", pickup_cooldown_days: 1 },
        signals: [KING],
        affected: [KING],
      }),
    ];
    const w = world(seed, HORIZON);
    const night = addDays(LOCAL0, 6);
    const add = (atMs: number) => {
      const row = booking(rng(atMs), night, KING, LOCAL0, 150, iso(atMs));
      w.change(atMs, (t) => t.reservations.push({ ...row }));
    };
    const fires = (f: Fake) => f.tables.pickup_event.filter((e) => e.stay_date === night).map((e) => [e.fire_seq, e.applied_at]);

    // Three quiet days first, for the snapshots a pickup window opens on.
    for (let day = -3; day < 0; day++) {
      for (const atMs of ticksFor(Date.parse(`${addDays(LOCAL0, day)}T00:00:00.000Z`))) {
        await w.tick(atMs);
        expectSame(w, iso(atMs));
      }
    }
    w.priced.clear();
    for (const [atMs, book] of [
      [at(0, "12:00"), false],
      [at(0, "13:00"), true],
      [at(0, "13:30"), true],
      [at(0, "20:00"), false],
      [at(1, "03:55"), false],
      [at(1, "04:05"), false],
      [at(1, "09:00"), false],
    ] as const) {
      if (book) add(atMs);
      await w.tick(atMs);
      expectSame(w, iso(atMs));
    }
    // The raise at 13:00, and the next on the booking at 13:30 once the wait
    // is over: 00:05 in New York, not 13:00.
    expect(fires(w.a)).toEqual([
      [1, iso(at(0, "13:00"))],
      [2, iso(at(1, "04:05"))],
    ]);
    // The cadence priced the night in the day's pass (the first tick of
    // Oct 28 here is at 12:00), when it was booked, in the next day's pass,
    // and in the tick after each change a rule made on it (a follow-up that
    // found nothing new): never at 20:00 or 03:55, when nothing about it
    // changed.
    const pricedNight = [...w.priced.entries()].filter(([, n]) => n.includes(night)).map(([t]) => t);
    expect(pricedNight).toEqual([
      iso(at(0, "12:00")),
      iso(at(0, "13:00")),
      iso(at(0, "13:30")),
      iso(at(1, "04:05")),
      iso(at(1, "09:00")),
    ]);
  }, 120_000);

  it("a pass in chunks: nights it has not reached keep yesterday's reading for a few ticks, and match again once it has", async () => {
    // A night the pass reaches a tick or two after midnight is priced that
    // much later than pricing every night would price it, on the same hotel
    // day and the same bookings (none arrive between those ticks here). So
    // once the pass is done every price is the same, and so is every
    // change, ladder row and filed night, apart from the instants they were
    // written at.
    const instants = /"(computed_at|applied_at|baseline_start_ts|baseline_end_ts|retired_at|window_since|activated_at|deactivated_at|checked_at|last_fire_at|reached_at|updated_at|last_event_id)":("[^"]*"|null),?/g;
    const same = (at: string) => {
      const pick = (f: Fake) => {
        const n = normalize(f.tables);
        const strip = (rows: string[]) => rows.map((r) => r.replace(instants, "")).sort();
        return {
          published_price: strip(n.published_price),
          pickup_event: strip(n.pickup_event),
          ladder_rule_state: strip(n.ladder_rule_state),
          rule_repeat_alert_nights: strip(n.rule_repeat_alert_nights),
        };
      };
      expect(pick(w.b), `after the tick at ${at}`).toEqual(pick(w.a));
    };
    // The first pass whole, as a hotel priced every tick until the release
    // has every night priced; then chunks of 8 nights.
    const config: CadenceConfig = { ...WHOLE_PASS };
    const w = world(seedHotel(LOCAL0, 30), 30, config);
    await w.tick(at(-1, "22:00"));
    expectSame(w, iso(at(-1, "22:00")));
    Object.assign(config, { chunkNights: 8, runMaxNights: 16 });
    const ticks: number[] = [];
    // Never on the stroke of midnight: a night that comes into the window
    // then would have a snapshot at the very instant its pickup windows
    // open when priced every tick, and none a chunk later.
    for (let day = 0; day < 3; day++) for (const hhmm of ["03:50", "03:55", "04:02", "04:07", "04:12", "04:17", "13:05", "13:10", "13:15", "13:20"]) ticks.push(at(day, hhmm));
    let checked = 0;
    let behind = 0;
    for (const atMs of ticks) {
      const minute = new Date(atMs).getUTCHours() * 60 + new Date(atMs).getUTCMinutes();
      if (minute === 13 * 60 + 5) {
        const g = rng(atMs);
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(atMs));
        // Made once, applied to both copies.
        const rows = [0, 1, 2].map((k) => booking(g, addDays(today, Math.floor(g() * 30)), ROOM_TYPES[k].id, today, 120, iso(atMs)));
        w.change(atMs, (t) => {
          for (const row of rows) t.reservations.push({ ...row });
        });
      }
      await w.tick(atMs);
      const state = w.b.tables.hotel_pricing_state[0];
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(atMs));
      if (state.pass_date === today && state.pass_cursor === null) {
        same(iso(atMs));
        checked++;
      } else {
        behind++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(behind).toBeGreaterThan(0);
  }, 300_000);
});
