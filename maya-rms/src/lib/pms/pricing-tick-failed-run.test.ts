/**
 * A pricing run that fails, inside the scheduled tick.
 *
 * The engine stops before it publishes when a read it prices from fails
 * (engine/failed-reads.test.ts). Here the whole tick runs around it, on a
 * live hotel with the daily cadence and a PMS to send to: nothing is
 * published or sent for the run that failed, its nights stay on the work
 * list and the day's pass stays where it was, and the next tick prices the
 * same nights and sends them. While every run keeps failing, the alert
 * channel is told once no run has finished for fifteen minutes, or at the
 * third failed run in a row, whichever comes first; the database counts the
 * streak (pricing_run_failed) and a run that prices ends it.
 *
 * Each case runs the app's engine and the edge functions' copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateHotel as edgeEvaluateHotel } from "../../../supabase/functions/_shared/engine/evaluate";
import type { Alert } from "../../../supabase/functions/_shared/pms/alerting";
import type { CadenceConfig } from "../../../supabase/functions/_shared/pms/pricing-plan";
import {
  alertPricingFailing,
  PRICING_FAILING_ALERT_AFTER_MS,
  PRICING_FAILURES_BEFORE_ALERT,
  resetCadenceMissingSeen,
  runPricingTick,
} from "../../../supabase/functions/_shared/pms/pricing-tick";
import type { CellPushResult, PmsRatePushAdapter, RateCell } from "../../../supabase/functions/_shared/pms/rate-push";
import { cadenceRpc, markNights } from "../engine/cadence-rpc-model.test";
import { evaluateHotel as appEvaluateHotel } from "../engine/evaluate";
import { FakeRpcError, fakeSupabase, type FakeCall, type FakeError, type FakeRow } from "../engine/fake-supabase.test";

const ENGINES = [
  { name: "app engine", evaluateHotel: appEvaluateHotel },
  { name: "edge engine", evaluateHotel: edgeEvaluateHotel },
];
type Engine = (typeof ENGINES)[number];

const H = "h1";
const RT = "a0000000-0000-4000-8000-000000000001";
const MIN = 60_000;
const HORIZON = 30;
const LOCAL0 = "2026-10-06";
const TIMEOUT: FakeError = { code: "57014", message: "canceling statement due to statement timeout" };
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();
/** 10:00 in New York on the story's first day. */
const T0 = Date.parse(`${LOCAL0}T14:00:00Z`);

const WHOLE_PASS: CadenceConfig = { chunkNights: 132, runMaxNights: 264, tickPassNights: 100_000, passMinTimeMs: 0, passMaxLagMinutes: 120 };

function rule(id: string, name: string, condition: FakeRow, value: number): FakeRow {
  return {
    id,
    hotel_id: H,
    name,
    is_active: true,
    version: 1,
    priority: 100,
    start_date: null,
    end_date: null,
    is_annual: false,
    dow_mask: 127,
    action_type: "percent",
    action_direction: "increase",
    action_value: value,
    is_pickup_rule: false,
    undo_on_cancellation: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    rule_condition: [condition],
    rule_signal_room_type: [{ room_type_id: RT }],
    rule_affected_room_type: [{ room_type_id: RT }],
  };
}

/** A live hotel whose own rate is 150 every night. */
function hotel(rules: FakeRow[], extra: Record<string, FakeRow[]> = {}) {
  let failing: ((c: FakeCall) => boolean) | null = null;
  const fake = fakeSupabase(
    {
      hotels: [{ id: H, timezone: "America/New_York" }],
      hotel_settings: [{ hotel_id: H, simulation_mode: false }],
      room_types: [
        { id: RT, hotel_id: H, name: "King", external_room_type_id: "CB-KING", is_active: true, total_rooms: 10, floor_price: 1, ceiling_price: 99999.99, counts_as_room: true },
      ],
      pms_connections: [{ id: "conn-1", hotel_id: H, pms_type: "cloudbeds", base_rates_refreshed_at: null, push_rate_targets: null }],
      pricing_rules: rules,
      reservations: [],
      base_rate_calendar: [],
      published_price: [],
      rate_updates: [],
      ladder_rule_state: [],
      manual_price: [],
      hotel_closed_periods: [],
      assumption_challenges: [],
      room_type_out_of_service: [],
      pickup_event: [],
      rule_repeat_alerts: [],
      rule_repeat_alert_nights: [],
      evaluation_run_log: [],
      ...extra,
    },
    {
      fault: (c) => (failing?.(c) ? TIMEOUT : null),
      rpc: (fn, args, tables) => {
        if (failing?.({ table: `rpc:${fn}`, op: "select", columns: "", filters: [], payload: args as FakeRow })) return new FakeRpcError(TIMEOUT);
        return cadenceRpc(fn, args, tables);
      },
    },
  );
  // What the PMS holds: the hotel's own 150, or what MAYA last sent.
  const inPms = new Map<string, number>();
  const sends: { stayDate: string; price: number }[][] = [];
  const adapter: PmsRatePushAdapter = {
    pmsType: "cloudbeds",
    async resolveRateTargets() {
      return { "CB-KING": "base-1" };
    },
    async readBaseRateCalendar(start, end) {
      const entries = [];
      for (let d = start; d <= end; d = addDays(d, 1)) entries.push({ stayDate: d, externalRoomTypeId: "CB-KING", price: inPms.get(d) ?? 150 });
      return { targets: { "CB-KING": "base-1" }, entries };
    },
    async pushCells(cells: Array<RateCell & { externalRateId: string }>): Promise<CellPushResult[]> {
      sends.push(cells.map((c) => ({ stayDate: c.stayDate, price: c.price })));
      for (const c of cells) inPms.set(c.stayDate, c.price);
      return cells.map((cell) => ({ cell, ok: true, jobReference: "accepted:202" }));
    },
  };
  const alerts: Alert[] = [];
  return {
    ...fake,
    sends,
    alerts,
    /** Make the reads `match` finds fail until `heal`. */
    fail(match: (c: FakeCall) => boolean) {
      failing = (c) => c.op === "select" && match(c);
    },
    heal() {
      failing = null;
    },
    priceOf: (night: string) => Number(fake.tables.published_price.find((p) => p.stay_date === night && p.room_type_id === RT)?.price),
    marked: () => (fake.tables.pricing_dirty_nights ?? []).map((d) => String(d.stay_date)).sort(),
    state: () => ({ ...((fake.tables.hotel_pricing_state ?? [])[0] ?? {}) }),
    async tick(engine: Engine, atMs: number, extra: { passBudget?: { remaining: number } } = {}) {
      vi.setSystemTime(new Date(atMs));
      return runPricingTick(
        fake.client,
        H,
        {
          horizonDays: HORIZON,
          adapter,
          runEvaluate: true,
          pushEnabled: true,
          evaluateBy: atMs + 10 * MIN,
          pushDeadlineAt: atMs + 10 * MIN,
          read: "ok",
          cadence: "daily",
          cadenceConfig: WHOLE_PASS,
          ...extra,
        },
        {
          evaluate: engine.evaluateHotel,
          now: () => atMs,
          alert: async (_s: SupabaseClient, alert: Alert) => {
            alerts.push(alert);
            return { sent: true };
          },
        },
      );
    },
  };
}

beforeEach(() => {
  resetCadenceMissingSeen();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.MAYA_ALERT_WEBHOOK;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(ENGINES)("$name: a run that fails inside the tick", (engine) => {
  it("typed prices that can't be read: the typed price stays published and in the PMS, the night stays on the list, and the next tick prices it", async () => {
    const night = addDays(LOCAL0, 5);
    const w = hotel([rule("b1000000-0000-4000-8000-000000000001", "Any booking", { occupancy_operator: "gt", occupancy_threshold: 0.05 }, 10)], {
      reservations: [
        { id: "f0000000-0000-4000-8000-000000000001", hotel_id: H, external_reservation_id: "e1", stay_date: night, room_type_id: RT, booking_date: addDays(LOCAL0, -3), booking_window_days: 8, current_rate: 200, base_rate: 200, created_at: `${addDays(LOCAL0, -3)}T10:00:00Z` },
      ],
      // The owner typed 400 for the night two days ago.
      manual_price: [{ id: "m1", hotel_id: H, stay_date: night, room_type_id: RT, price: 400, set_by: "u1", set_at: `${addDays(LOCAL0, -2)}T12:00:00Z`, cleared_at: null, source: "maya", pms_type: null }],
    });

    const first = await w.tick(engine, T0);
    expect(first.evaluate).not.toHaveProperty("error");
    // The day's pass changes rules' state, so the nights it did that on come round once more.
    await w.tick(engine, T0 + 5 * MIN);
    expect(w.priceOf(night)).toBe(440);
    expect(w.sends.flat().filter((s) => s.stayDate === night)).toEqual([{ stayDate: night, price: 440 }]);
    expect(w.marked()).toEqual([]);
    // Apart from the failure streak, which the failed tick records.
    const { failed_runs: _f, last_failed_at: _a, last_error: _e, ...settled } = w.state();

    // A booking lands on the night, so it is priced again; the read of typed prices times out.
    w.tables.reservations.push({ id: "f0000000-0000-4000-8000-000000000002", hotel_id: H, external_reservation_id: "e2", stay_date: night, room_type_id: RT, booking_date: LOCAL0, booking_window_days: 5, current_rate: 440, base_rate: 440, created_at: iso(T0 + 9 * MIN) });
    markNights(w.tables, H, [night], "booking", iso(T0 + 9 * MIN));
    const sentBefore = w.sends.length;
    const publishedBefore = structuredClone(w.tables.published_price);
    w.fail((c) => c.table === "manual_price");
    const failed = await w.tick(engine, T0 + 10 * MIN);
    w.heal();

    expect(failed.evaluate).toEqual({ error: expect.stringMatching(/Failed to load typed prices: canceling statement/) });
    // Nothing published, nothing sent, nothing marked done.
    expect(w.tables.published_price).toEqual(publishedBefore);
    expect(w.priceOf(night)).toBe(440);
    expect(w.sends.length).toBe(sentBefore);
    expect(w.marked()).toEqual([night]);
    expect(w.state()).toEqual({ ...settled, failed_runs: 1, last_failed_at: expect.any(String), last_error: expect.stringContaining("Failed to load typed prices") });
    expect(failed.passWorkLeft).toBe(true);
    // One failed run, five minutes after a good one: nobody is told yet.
    expect(failed).not.toHaveProperty("pricingAlert");
    expect(w.alerts).toEqual([]);

    const next = await w.tick(engine, T0 + 15 * MIN);
    expect(next.evaluate).not.toHaveProperty("error");
    expect(next.cadence).toMatchObject({ touched: 1 });
    expect(w.priceOf(night)).toBe(440);
    expect(w.marked()).toEqual([]);
    expect(Date.parse(String(w.state().last_ok_run_at))).toBe(T0 + 15 * MIN);
  }, 120_000);

  it("the hotel's own rates that can't be read: no booked night is priced on what its guest paid", async () => {
    const nights = [3, 4, 5].map((n) => addDays(LOCAL0, n));
    const w = hotel([], {
      reservations: nights.map((stay, i) => ({
        id: `f0000000-0000-4000-8000-00000000000${i + 1}`, hotel_id: H, external_reservation_id: `e${i}`, stay_date: stay, room_type_id: RT,
        booking_date: addDays(LOCAL0, -3), booking_window_days: 8, current_rate: 260, base_rate: 260, created_at: `${addDays(LOCAL0, -3)}T10:00:00Z`,
      })),
    });
    await w.tick(engine, T0);
    expect(nights.map(w.priceOf)).toEqual([150, 150, 150]);
    const publishedBefore = structuredClone(w.tables.published_price);

    markNights(w.tables, H, nights, "booking", iso(T0 + 4 * MIN));
    w.fail((c) => c.table === "base_rate_calendar" && c.columns === "stay_date, room_type_id, price");
    const failed = await w.tick(engine, T0 + 5 * MIN);
    w.heal();
    expect(failed.evaluate).toEqual({ error: expect.stringMatching(/Failed to load the hotel's own rates/) });
    expect(w.tables.published_price).toEqual(publishedBefore);
    expect(w.marked()).toEqual(nights);

    await w.tick(engine, T0 + 10 * MIN);
    expect(nights.map(w.priceOf)).toEqual([150, 150, 150]);
    expect(w.marked()).toEqual([]);
    // The PMS only ever got the hotel's own rate.
    expect(new Set(w.sends.flat().map((s) => s.price))).toEqual(new Set([150]));
  }, 120_000);

  it("room types that can't be read on the day's pass: the pass is not recorded as done, and the next tick makes the change the day brings", async () => {
    // 6 days out today, 5 tomorrow: the rule comes on with tomorrow's pass.
    const night = addDays(LOCAL0, 6);
    const w = hotel([rule("b1000000-0000-4000-8000-000000000001", "Last minute", { dta_operator: "lt", dta_threshold_days: 6 }, 20)]);
    await w.tick(engine, T0);
    await w.tick(engine, T0 + 5 * MIN);
    expect(w.priceOf(night)).toBe(150);
    const { failed_runs: _f, last_failed_at: _a, last_error: _e, ...yesterday } = w.state();
    expect(yesterday.pass_date).toBe(LOCAL0);

    // Ten past midnight in New York: the new day's pass is due.
    const t1 = Date.parse(`${addDays(LOCAL0, 1)}T04:10:00Z`);
    w.fail((c) => c.table === "room_types" && c.columns.includes("total_rooms"));
    const failed = await w.tick(engine, t1);
    w.heal();
    expect(failed.evaluate).toEqual({ error: expect.stringMatching(/Failed to load room types/) });
    expect(w.priceOf(night)).toBe(150);
    // Still yesterday's pass: today's has not started, let alone finished.
    expect(w.state()).toEqual({ ...yesterday, failed_runs: 1, last_failed_at: expect.any(String), last_error: expect.stringContaining("Failed to load room types") });
    expect(failed.passWorkLeft).toBe(true);
    expect(w.tables.evaluation_run_log.filter((r) => Date.parse(String(r.evaluated_at)) === t1)).toEqual([]);

    const next = await w.tick(engine, t1 + 5 * MIN);
    expect(next.evaluate).not.toHaveProperty("error");
    expect(next.cadence).toMatchObject({ passStarted: expect.any(String) });
    expect(w.state().pass_date).toBe(addDays(LOCAL0, 1));
    expect(w.priceOf(night)).toBe(180);
    await w.tick(engine, t1 + 10 * MIN);
    expect(w.sends.flat().filter((s) => s.stayDate === night).map((s) => s.price)).toEqual([150, 180]);
  }, 120_000);

  it("while every run keeps failing, the alert channel is told once no run has priced anything for fifteen minutes", async () => {
    const night = addDays(LOCAL0, 5);
    const w = hotel([rule("b1000000-0000-4000-8000-000000000001", "Any booking", { occupancy_operator: "gt", occupancy_threshold: 0.05 }, 10)]);
    await w.tick(engine, T0);
    await w.tick(engine, T0 + 5 * MIN);
    markNights(w.tables, H, [night], "booking", iso(T0 + 6 * MIN));

    // The last run that priced anything was the first, at T0; the tick at
    // T0 + 5 had nothing to price (its heartbeat is not a run that priced).
    // Fifteen minutes on from T0 is T0 + 15.
    const lastPriced = w.tables.evaluation_run_log.filter((r) => r.run_kind !== "idle").map((r) => Date.parse(String(r.evaluated_at)));
    expect(Math.max(...lastPriced)).toBe(T0);
    expect(Date.parse(String(w.state().last_ok_run_at))).toBe(T0 + 5 * MIN);
    w.fail((c) => c.table === "manual_price");
    const results = [];
    for (const minutes of [10, 15, 20, 25]) results.push(await w.tick(engine, T0 + minutes * MIN));
    expect(results.map((r) => "error" in r.evaluate)).toEqual([true, true, true, true]);
    expect(results.map((r) => r.pricingAlert ?? null)).toEqual([null, { sent: true }, { sent: true }, { sent: true }]);
    expect(w.alerts).toHaveLength(3);
    expect(w.alerts[0]).toMatchObject({ severity: "critical", key: `pricing-failing:${H}`, title: "Pricing keeps failing", hotelId: H });
    expect(w.alerts[0].detail).toContain(`No pricing run has priced anything since ${iso(T0)} (15 minutes).`);
    expect(w.alerts[0].detail).toContain("Failed to load typed prices");
    expect(w.marked()).toEqual([night]);

    w.heal();
    const healed = await w.tick(engine, T0 + 30 * MIN);
    expect(healed.evaluate).not.toHaveProperty("error");
    expect(healed).not.toHaveProperty("pricingAlert");
    expect(w.alerts).toHaveLength(3);
    expect(w.marked()).toEqual([]);
  }, 120_000);

  it("three failed runs in a row are told at once, whatever the clock says, and a run that prices ends the streak", async () => {
    const night = addDays(LOCAL0, 5);
    const w = hotel([rule("b1000000-0000-4000-8000-000000000001", "Any booking", { occupancy_operator: "gt", occupancy_threshold: 0.05 }, 10)]);
    await w.tick(engine, T0);
    markNights(w.tables, H, [night], "booking", iso(T0 + 1 * MIN));
    expect(Number(w.state().failed_runs)).toBe(0);

    // A minute apart: the clock says nothing, the count does.
    w.fail((c) => c.table === "manual_price");
    const results = [];
    const streak = [];
    for (const minutes of [1, 2, 3, 4]) {
      results.push(await w.tick(engine, T0 + minutes * MIN));
      streak.push(Number(w.state().failed_runs));
    }
    expect(results.map((r) => "error" in r.evaluate)).toEqual([true, true, true, true]);
    expect(streak).toEqual([1, 2, 3, 4]);
    expect(String(w.state().last_error)).toContain("evaluate: Failed to load typed prices");
    expect(results.map((r) => r.pricingAlert ?? null)).toEqual([null, null, { sent: true }, { sent: true }]);
    expect(w.alerts[0]).toMatchObject({ severity: "critical", key: `pricing-failing:${H}`, title: "Pricing keeps failing", hotelId: H });
    expect(w.alerts[0].detail).toContain(`${PRICING_FAILURES_BEFORE_ALERT} runs in a row have failed. No pricing run has priced anything since ${iso(T0)} (3 minutes).`);

    w.heal();
    const healed = await w.tick(engine, T0 + 5 * MIN);
    expect(healed.evaluate).not.toHaveProperty("error");
    expect(healed).not.toHaveProperty("pricingAlert");
    expect(Number(w.state().failed_runs)).toBe(0);
    expect(w.marked()).toEqual([]);
  }, 120_000);
});

describe.each(ENGINES)("$name: the alert clock and ticks with nothing to price", (engine) => {
  it("is not put off by idle ticks: a pass that fails whenever the fleet's budget reaches the hotel, and idles when it does not", async () => {
    // A fleet shares its daily pass budget (MAYA_TICK_PASS_NIGHTS). A hotel
    // that gets budget on every other tick prices its pass chunk then, and
    // has nothing to do in between. When the chunk fails every time, the
    // idle ticks in between still write their heartbeat and move the work
    // list's last_ok_run_at, so a clock built on that never reaches fifteen
    // minutes, although no night has been priced since yesterday.
    const w = hotel([rule("b1000000-0000-4000-8000-000000000001", "Last minute", { dta_operator: "lt", dta_threshold_days: 6 }, 20)]);
    await w.tick(engine, T0);
    await w.tick(engine, T0 + 5 * MIN);
    const priced = () => Math.max(...w.tables.evaluation_run_log.filter((r) => r.run_kind !== "idle").map((r) => Date.parse(String(r.evaluated_at))));
    const lastPricedAt = priced();

    // Ten past midnight in New York: the new day's pass is due, and its room types read fails.
    const t1 = Date.parse(`${addDays(LOCAL0, 1)}T04:10:00Z`);
    w.fail((c) => c.table === "room_types" && c.columns.includes("total_rooms"));
    const results = [];
    const streak = [];
    for (const [i, minutes] of [0, 5, 10, 15, 20, 25].entries()) {
      results.push(await w.tick(engine, t1 + minutes * MIN, { passBudget: { remaining: i % 2 === 0 ? 1000 : 0 } }));
      streak.push(Number(w.state().failed_runs));
    }
    expect(results.map((r) => ("error" in r.evaluate ? "failed" : "idle" in r.evaluate ? "idle" : "priced"))).toEqual([
      "failed", "idle", "failed", "idle", "failed", "idle",
    ]);
    // The idle ticks do not end the streak either.
    expect(streak).toEqual([1, 1, 2, 2, 3, 3]);
    // The idle ticks moved the work list's word and wrote their heartbeats...
    expect(Date.parse(String(w.state().last_ok_run_at))).toBe(t1 + 25 * MIN);
    expect(w.tables.evaluation_run_log.filter((r) => r.run_kind === "idle" && Date.parse(String(r.evaluated_at)) >= t1)).toHaveLength(3);
    // ...but nothing has been priced since yesterday, and every failed tick says so.
    expect(priced()).toBe(lastPricedAt);
    expect(results.map((r) => r.pricingAlert ?? null)).toEqual([{ sent: true }, null, { sent: true }, null, { sent: true }, null]);
    expect(w.alerts[0].detail).toContain(`No pricing run has priced anything since ${iso(lastPricedAt)}`);
    expect(w.alerts[0].detail).toContain("Failed to load room types");

    // A tick that prices again ends it.
    w.heal();
    const healed = await w.tick(engine, t1 + 30 * MIN, { passBudget: { remaining: 1000 } });
    expect(healed.evaluate).not.toHaveProperty("error");
    expect(healed).not.toHaveProperty("pricingAlert");
    expect(priced()).toBe(t1 + 30 * MIN);
    expect(Number(w.state().failed_runs)).toBe(0);
  }, 120_000);
});

describe("alertPricingFailing", () => {
  const failure = { step: "evaluate" as const, error: "Failed to load room types: connection failure" };
  const collect = () => {
    const alerts: Alert[] = [];
    return { alerts, alert: async (_s: SupabaseClient, a: Alert) => (alerts.push(a), { sent: true }) };
  };

  it("three failed runs in a row are told whatever the clock says; two are not", async () => {
    const { client } = fakeSupabase({ evaluation_run_log: [{ hotel_id: H, evaluated_at: iso(T0 - 1 * MIN), run_kind: "nights" }] });
    const failure = { step: "evaluate" as const, error: "Failed to load typed prices: timeout" };
    const c = collect();
    expect(await alertPricingFailing(client, H, failure, { lastOkRunAt: iso(T0 - 1 * MIN), failedRuns: 2, nowMs: T0, mayStart: true, alert: c.alert })).toBeNull();
    expect(await alertPricingFailing(client, H, failure, { lastOkRunAt: iso(T0 - 1 * MIN), failedRuns: null, nowMs: T0, mayStart: true, alert: c.alert })).toBeNull();
    expect(c.alerts).toEqual([]);
    expect(await alertPricingFailing(client, H, failure, { lastOkRunAt: iso(T0 - 1 * MIN), failedRuns: 3, nowMs: T0, mayStart: true, alert: c.alert })).toEqual({ sent: true });
    expect(c.alerts[0].detail).toBe(
      `3 runs in a row have failed. No pricing run has priced anything since ${iso(T0 - 1 * MIN)} (1 minutes). ` +
        "The latest run stopped before it published anything, so no new price is published or sent until a run finishes. Error: Failed to load typed prices: timeout",
    );
  });

  it("says nothing while a run priced nights in the last fifteen minutes", async () => {
    const { client } = fakeSupabase({
      evaluation_run_log: [{ hotel_id: H, evaluated_at: iso(T0 - PRICING_FAILING_ALERT_AFTER_MS + 1), run_kind: "nights" }],
    });
    const c = collect();
    const told = await alertPricingFailing(client, H, failure, { lastOkRunAt: iso(T0 - 60 * MIN), nowMs: T0, mayStart: true, alert: c.alert });
    expect(told).toBeNull();
    expect(c.alerts).toEqual([]);
  });

  it("goes by the newest run that priced nights, not by an idle tick's heartbeat or the work list's word", async () => {
    // Priced an hour ago; idle heartbeats since, the last a minute ago, which
    // also moved the work list's last_ok_run_at.
    const { client } = fakeSupabase({
      evaluation_run_log: [
        { hotel_id: H, evaluated_at: iso(T0 - 60 * MIN), run_kind: "window" },
        { hotel_id: H, evaluated_at: iso(T0 - 6 * MIN), run_kind: "idle" },
        { hotel_id: H, evaluated_at: iso(T0 - 1 * MIN), run_kind: "idle" },
        { hotel_id: "other", evaluated_at: iso(T0), run_kind: "nights" },
      ],
    });
    const c = collect();
    expect(await alertPricingFailing(client, H, failure, { lastOkRunAt: iso(T0 - 1 * MIN), nowMs: T0, mayStart: true, alert: c.alert })).toEqual({ sent: true });
    expect(c.alerts[0].detail).toContain(`No pricing run has priced anything since ${iso(T0 - 60 * MIN)} (60 minutes)`);
    // A typed price's own run counts: it priced nights.
    const saved = fakeSupabase({
      evaluation_run_log: [
        { hotel_id: H, evaluated_at: iso(T0 - 60 * MIN), run_kind: "window" },
        { hotel_id: H, evaluated_at: iso(T0 - 3 * MIN), run_kind: "save" },
      ],
    });
    const d = collect();
    expect(await alertPricingFailing(saved.client, H, failure, { lastOkRunAt: null, nowMs: T0, mayStart: true, alert: d.alert })).toBeNull();
  });

  it("before the cadence migration, when the run log has no kinds, goes by its newest run", async () => {
    const withoutKinds = fakeSupabase(
      { evaluation_run_log: [{ hotel_id: H, evaluated_at: iso(T0 - 60 * MIN) }, { hotel_id: H, evaluated_at: iso(T0 - 5 * MIN) }] },
      { fault: (c) => (c.table === "evaluation_run_log" && c.filters.some((f) => String(f.value).includes("run_kind")) ? { code: "42703", message: "column evaluation_run_log.run_kind does not exist" } : null) },
    );
    const c = collect();
    expect(await alertPricingFailing(withoutKinds.client, H, failure, { lastOkRunAt: null, nowMs: T0, mayStart: true, alert: c.alert })).toBeNull();
    expect(withoutKinds.calls.filter((call) => call.table === "evaluation_run_log")).toHaveLength(2);
  });

  it("goes by the newest run on the run log whether or not the work list said anything", async () => {
    const recent = fakeSupabase({ evaluation_run_log: [{ hotel_id: H, evaluated_at: iso(T0 - 60 * MIN) }, { hotel_id: H, evaluated_at: iso(T0 - 5 * MIN) }, { hotel_id: "other", evaluated_at: iso(T0) }] });
    const a = collect();
    expect(await alertPricingFailing(recent.client, H, failure, { lastOkRunAt: undefined, nowMs: T0, mayStart: true, alert: a.alert })).toBeNull();

    const old = fakeSupabase({ evaluation_run_log: [{ hotel_id: H, evaluated_at: iso(T0 - 60 * MIN) }, { hotel_id: "other", evaluated_at: iso(T0) }] });
    const b = collect();
    expect(await alertPricingFailing(old.client, H, failure, { lastOkRunAt: null, nowMs: T0, mayStart: true, alert: b.alert })).toEqual({ sent: true });
    expect(b.alerts[0].detail).toContain(`since ${iso(T0 - 60 * MIN)} (60 minutes)`);
  });

  it("tells someone when no run has ever finished, or the run log can't be read either", async () => {
    const never = fakeSupabase({ evaluation_run_log: [] });
    const a = collect();
    expect(await alertPricingFailing(never.client, H, failure, { lastOkRunAt: null, nowMs: T0, mayStart: true, alert: a.alert })).toEqual({ sent: true });
    expect(a.alerts[0].detail).toContain("No pricing run has priced anything for this hotel.");

    const down = fakeSupabase({}, { fault: () => TIMEOUT });
    const b = collect();
    expect(await alertPricingFailing(down.client, H, failure, { lastOkRunAt: undefined, nowMs: T0, mayStart: true, alert: b.alert })).toEqual({ sent: true });
  });

  it("a run that priced but could not be recorded is told the same way, by the work list's word alone", async () => {
    // The engine's own heartbeat is on the run log: it says nothing about the record.
    const { client } = fakeSupabase({ evaluation_run_log: [{ hotel_id: H, evaluated_at: iso(T0) }] });
    const c = collect();
    const told = await alertPricingFailing(client, H, { step: "record", error: "Failed to record the pricing run: connection failure" }, {
      lastOkRunAt: iso(T0 - 20 * MIN),
      nowMs: T0,
      mayStart: true,
      alert: c.alert,
    });
    expect(told).toEqual({ sent: true });
    expect(c.alerts[0].detail).toContain("could not be recorded");
    const d = collect();
    expect(
      await alertPricingFailing(client, H, { step: "record", error: "x" }, { lastOkRunAt: null, nowMs: T0, mayStart: true, alert: d.alert }),
    ).toEqual({ sent: true });
  });

  it("does not start an alert its timeout would carry past the tick, and never throws", async () => {
    const { client } = fakeSupabase({});
    const c = collect();
    expect(await alertPricingFailing(client, H, failure, { lastOkRunAt: iso(T0 - 60 * MIN), nowMs: T0, mayStart: false, alert: c.alert })).toEqual({
      sent: false,
      reason: "out_of_time",
    });
    expect(c.alerts).toEqual([]);
    const broken = async () => {
      throw new Error("webhook exploded");
    };
    expect(await alertPricingFailing(client, H, failure, { lastOkRunAt: iso(T0 - 60 * MIN), nowMs: T0, mayStart: true, alert: broken })).toEqual({
      sent: false,
      reason: "send_failed",
    });
  });

  it("goes out through the alert webhook as a critical alert", async () => {
    process.env.MAYA_ALERT_WEBHOOK = "https://hooks.example.com/abc";
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("ok", { status: 200 });
    });
    const w = fakeSupabase({ platform_audit_events: [] }, { rpc: () => null });
    const res = await runPricingTick(
      w.client,
      H,
      { horizonDays: HORIZON, adapter: null, runEvaluate: true, pushEnabled: false, evaluateBy: T0 + 10 * MIN, pushDeadlineAt: T0 + 10 * MIN, read: "ok" },
      {
        evaluate: async () => {
          throw new Error("Failed to load typed prices: connection failure");
        },
        now: () => T0,
      },
    );
    expect(res.pricingAlert).toEqual({ sent: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://hooks.example.com/abc");
    expect(posts[0].body).toMatchObject({ severity: "critical", key: `pricing-failing:${H}`, hotelId: H });
    expect(String(posts[0].body.text)).toContain("Pricing keeps failing");
  });
});
