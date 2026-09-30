/**
 * Which nights a scheduled tick prices (pricing-plan.ts), and the tick that
 * reads the list, prices and reports back (runPricingTick with the cadence
 * functions of 99_supabase_migration_pricing_cadence_v1.sql, as the fake
 * models them in cadence-rpc-model.test.ts; pricing-cadence-sql.test.ts
 * holds the SQL to the same contract).
 *
 * The daily pass: on the first cycle after the hotel's date changes, every
 * night of the window, in chunks, nearest first, with the cursor saved. Not
 * at a clock time, so daylight saving, a failed read after midnight, a crash
 * part way and a hotel connected mid-day all come to "compare dates, carry
 * on from the cursor". Touched nights every tick, before the pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  passReason,
  planPricingRun,
  planWholeWindow,
  unsettledNights,
  type CadenceConfig,
  type PricingState,
  type PricingWork,
} from "../../../supabase/functions/_shared/pms/pricing-plan";
import { resetCadenceMissingSeen, runPricingTick } from "../../../supabase/functions/_shared/pms/pricing-tick";
import type { CadenceReport, EvaluateOptions } from "../../../supabase/functions/_shared/engine/evaluate";
import { hotelDayStartIso } from "../../../supabase/functions/_shared/engine/timezone";
import { cadenceRpc, markBookingChanges, markHotel, markNights } from "../engine/cadence-rpc-model.test";
import { fakeSupabase, missingFunction, FakeRpcError, type FakeRow } from "../engine/fake-supabase.test";
import type { SupabaseClient } from "@supabase/supabase-js";

const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function state(over: Partial<PricingState> = {}): PricingState {
  return {
    pass_date: null,
    pass_cursor: null,
    pass_started_at: null,
    pass_completed_at: null,
    pass_reason: null,
    pass_horizon_days: null,
    pass_reprice_seq: null,
    full_reprice_seq: null,
    last_ok_run_at: null,
    failed_runs: null,
    momentum_nights: [],
    ...over,
  };
}

const CONFIG: Pick<CadenceConfig, "chunkNights" | "runMaxNights"> = { chunkNights: 132, runMaxNights: 264 };
const TODAY = "2026-10-01";
const LAST = addDays(TODAY, 395);

const dirty = (nights: string[], reasons: string[] = ["booking"], seq = 1) =>
  nights.map((stay_date, i) => ({ stay_date, mark_seq: seq + i, first_marked_at: "2026-10-01T12:00:00.000Z", reasons }));

const plan = (work: PricingWork, over: Partial<Parameters<typeof planPricingRun>[0]> = {}) =>
  planPricingRun({
    work,
    today: TODAY,
    lastNight: LAST,
    horizonDays: 396,
    config: CONFIG,
    passAllowed: true,
    passBudget: Number.POSITIVE_INFINITY,
    ...over,
  });

describe("when a new daily pass starts", () => {
  it("on the first run, a new hotel date (either way), an owner edit since the pass began, and a longer window; never otherwise", () => {
    expect(passReason(null, TODAY, 396)).toBe("first_run");
    expect(passReason(state(), TODAY, 396)).toBe("first_run");
    const today = state({ pass_date: TODAY, pass_horizon_days: 396, pass_reprice_seq: 7, full_reprice_seq: 7 });
    expect(passReason(today, TODAY, 396)).toBeNull();
    expect(passReason({ ...today, pass_date: addDays(TODAY, -1) }, TODAY, 396)).toBe("new_day");
    // The time zone moved west: the hotel's date went back.
    expect(passReason({ ...today, pass_date: addDays(TODAY, 1) }, TODAY, 396)).toBe("new_day");
    expect(passReason({ ...today, full_reprice_seq: 8 }, TODAY, 396)).toBe("owner_edit");
    expect(passReason({ ...today, pass_horizon_days: 60 }, TODAY, 396)).toBe("horizon");
    // A shorter window needs no new pass: the nights it keeps were priced today.
    expect(passReason(today, TODAY, 60)).toBeNull();
  });
});

describe("planPricingRun", () => {
  it("starts a pass with the nearest chunk, and prices the touched nights with it in one run", () => {
    const p = plan({ dirty: dirty([addDays(TODAY, 200), addDays(TODAY, 3)]), state: null });
    expect(p.pass).toEqual({
      date: TODAY,
      start: true,
      from: TODAY,
      next: addDays(TODAY, 132),
      horizon: 396,
      reason: "first_run",
      repriceSeq: null,
    });
    expect(p.nights[0]).toBe(TODAY);
    expect(p.nights).toContain(addDays(TODAY, 200));
    expect(p.nights).toHaveLength(133);
    expect(p.counts).toEqual({ touched: 2, momentum: 0, chunk: 132 });
    expect(p.dirtyRead.map((d) => d.stay_date).sort()).toEqual([addDays(TODAY, 3), addDays(TODAY, 200)]);
    expect(p.passWorkLeft).toBe(true);
  });

  it("carries on from the saved cursor, and ends the pass at the last night", () => {
    const mid = state({ pass_date: TODAY, pass_cursor: addDays(TODAY, 264), pass_horizon_days: 396 });
    const p = plan({ dirty: [], state: mid });
    expect(p.pass).toMatchObject({ start: false, from: addDays(TODAY, 264), next: null, reason: null });
    expect(p.nights[0]).toBe(addDays(TODAY, 264));
    expect(p.nights[p.nights.length - 1]).toBe(LAST);
    expect(p.passWorkLeft).toBe(false);
  });

  it("after a crash part way (nothing recorded), the same chunk again", () => {
    const mid = state({ pass_date: TODAY, pass_cursor: addDays(TODAY, 132), pass_horizon_days: 396 });
    const first = plan({ dirty: [], state: mid });
    const again = plan({ dirty: [], state: mid });
    expect(again.nights).toEqual(first.nights);
    expect(again.pass).toEqual(first.pass);
  });

  it("with the pass done for the day, prices only the touched nights, and nothing when nothing changed", () => {
    const done = state({ pass_date: TODAY, pass_cursor: null, pass_horizon_days: 396 });
    expect(plan({ dirty: dirty([addDays(TODAY, 9)]), state: done }).nights).toEqual([addDays(TODAY, 9)]);
    const idle = plan({ dirty: [], state: done });
    expect(idle.nights).toEqual([]);
    expect(idle.pass).toBeNull();
    expect(idle.passWorkLeft).toBe(false);
  });

  it("a new hotel day restarts the pass from tonight, whatever the old cursor said", () => {
    const yesterday = state({ pass_date: addDays(TODAY, -1), pass_cursor: addDays(TODAY, 100), pass_horizon_days: 396 });
    const p = plan({ dirty: [], state: yesterday });
    expect(p.pass).toMatchObject({ start: true, from: TODAY, reason: "new_day" });
    expect(p.nights[0]).toBe(TODAY);
  });

  it("an owner edit mid-pass starts it over from tonight, and records the edits it takes in", () => {
    const mid = state({ pass_date: TODAY, pass_cursor: addDays(TODAY, 132), pass_horizon_days: 396, pass_reprice_seq: 3, full_reprice_seq: 9 });
    const p = plan({ dirty: [], state: mid });
    expect(p.pass).toMatchObject({ start: true, from: TODAY, reason: "owner_edit", repriceSeq: 9 });
  });

  it("never defers a touched night for the pass: the chunk shrinks to fit the run's cap", () => {
    const touched = Array.from({ length: 200 }, (_, i) => addDays(TODAY, 150 + i));
    const p = plan({ dirty: dirty(touched), state: null }, { config: { chunkNights: 132, runMaxNights: 264 } });
    expect(p.counts.chunk).toBe(64);
    expect(p.nights).toHaveLength(264);
    for (const n of touched) expect(p.nights).toContain(n);
    expect(p.pass).toMatchObject({ start: true, next: addDays(TODAY, 64) });
  });

  it("takes the nearest touched nights when there are more than the cap, and no chunk that run", () => {
    const touched = Array.from({ length: 300 }, (_, i) => addDays(TODAY, i));
    const p = plan({ dirty: dirty(touched), state: state({ pass_date: TODAY, pass_horizon_days: 396 }) });
    expect(p.nights).toEqual(touched.slice(0, 264));
    expect(p.counts.chunk).toBe(0);
    // The marks it did not take are not in its read: they stay for the next tick.
    expect(p.dirtyRead).toHaveLength(264);
  });

  it("leaves the chunk for later when time or the invocation's budget is short, and says a pass is due", () => {
    const noTime = plan({ dirty: dirty([addDays(TODAY, 5)]), state: state({ pass_date: addDays(TODAY, -1), pass_horizon_days: 396 }) }, { passAllowed: false });
    expect(noTime.nights).toEqual([addDays(TODAY, 5)]);
    expect(noTime.pass).toBeNull();
    expect(noTime.passDue).toBe("new_day");
    expect(noTime.passWorkLeft).toBe(true);

    const budget = plan({ dirty: [], state: null }, { passBudget: 40 });
    expect(budget.counts.chunk).toBe(40);
    expect(budget.pass).toMatchObject({ next: addDays(TODAY, 40) });
  });

  it("prices the momentum nights within 10 of a booking, and marks again those the cap leaves out", () => {
    const withMomentum = state({
      pass_date: TODAY,
      pass_horizon_days: 396,
      momentum_nights: [addDays(TODAY, 20), addDays(TODAY, 29), addDays(TODAY, 31), addDays(TODAY, 90)],
    });
    const p = plan({ dirty: dirty([addDays(TODAY, 30)]), state: withMomentum });
    expect(p.nights).toEqual([addDays(TODAY, 20), addDays(TODAY, 29), addDays(TODAY, 30), addDays(TODAY, 31)]);
    expect(p.counts.momentum).toBe(3);
    // A typed price moves no neighbour: only bookings do.
    const typed = plan({ dirty: dirty([addDays(TODAY, 30)], ["manual_price"]), state: withMomentum });
    expect(typed.nights).toEqual([addDays(TODAY, 30)]);

    const capped = plan({ dirty: dirty([addDays(TODAY, 30)]), state: withMomentum }, { config: { chunkNights: 132, runMaxNights: 2 } });
    expect(capped.nights).toEqual([addDays(TODAY, 20), addDays(TODAY, 29)]);
    // Its booking's night was left out too, so it keeps its own mark: nothing is deferred.
    expect(capped.deferred).toEqual([]);
    const cappedAfter = plan(
      { dirty: dirty([addDays(TODAY, 19)]), state: withMomentum },
      { config: { chunkNights: 132, runMaxNights: 2 } },
    );
    // The booking's night is priced, and cleared with its mark; the neighbour left out is marked again.
    expect(cappedAfter.nights).toEqual([addDays(TODAY, 19), addDays(TODAY, 20)]);
    expect(cappedAfter.deferred).toEqual([addDays(TODAY, 29)]);
  });

  it("ignores marks outside the window", () => {
    const p = plan({ dirty: dirty([addDays(TODAY, -1), addDays(LAST, 1), addDays(TODAY, 2)]), state: state({ pass_date: TODAY, pass_horizon_days: 396 }) });
    expect(p.nights).toEqual([addDays(TODAY, 2)]);
  });

  it("MAYA_PRICING_CADENCE=every_tick: the whole window, and today's pass counts as done", () => {
    const p = planWholeWindow({ dirty: dirty([addDays(TODAY, 4)]), state: null }, TODAY, addDays(TODAY, 59), 60);
    expect(p.nights).toHaveLength(60);
    expect(p.pass).toMatchObject({ start: true, from: TODAY, next: null, horizon: 60 });
    expect(p.dirtyRead.map((d) => d.stay_date)).toEqual([addDays(TODAY, 4)]);
  });
});

describe("unsettledNights: what the push may not vouch for", () => {
  const work: PricingWork = {
    dirty: [
      { stay_date: addDays(TODAY, 1), mark_seq: 1, first_marked_at: "2026-10-01T11:00:00.000Z", reasons: ["booking"] },
      { stay_date: addDays(TODAY, 2), mark_seq: 2, first_marked_at: "2026-10-01T11:55:00.000Z", reasons: ["booking"] },
    ],
    state: state({ pass_date: TODAY, pass_cursor: addDays(TODAY, 5), pass_horizon_days: 7 }),
  };
  const base = {
    work,
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    maxAgeMs: 30 * 60_000,
    today: TODAY,
    lastNight: addDays(TODAY, 6),
    dayStartedMs: Date.parse("2026-10-01T04:00:00.000Z"),
    passMaxLagMs: 120 * 60_000,
  };
  const noPlan = { nights: [], dirtyRead: [], pass: null, deferred: [], passWorkLeft: true, passDue: null, counts: { touched: 0, momentum: 0, chunk: 0 } };

  it("a change unpriced for longer than the price may be old, and the nights a stuck pass has not reached", () => {
    expect([...unsettledNights({ ...base, plan: noPlan, priced: false })].sort()).toEqual([
      addDays(TODAY, 1),
      addDays(TODAY, 5),
      addDays(TODAY, 6),
    ]);
  });

  it("nothing this run priced", () => {
    const p = { ...noPlan, nights: [addDays(TODAY, 1), addDays(TODAY, 5), addDays(TODAY, 6)], pass: { date: TODAY, start: false, from: addDays(TODAY, 5), next: null, horizon: 7, reason: null, repriceSeq: null } };
    expect([...unsettledNights({ ...base, plan: p, priced: true })]).toEqual([]);
  });

  it("a pass still inside its lag after midnight holds nothing back", () => {
    expect([...unsettledNights({ ...base, plan: noPlan, priced: false, dayStartedMs: base.nowMs - 60 * 60_000 })]).toEqual([
      addDays(TODAY, 1),
    ]);
  });
});

/* ── The tick, against the cadence functions ─────────────────────── */

const HOTEL = "hotel-1";

type Priced = { at: string; nights: string[] | "window"; kind?: string };

function hotelDb(timezone: string, seed: Record<string, FakeRow[]> = {}, rpc = cadenceRpc) {
  return fakeSupabase(
    {
      hotels: [{ id: HOTEL, timezone }],
      hotel_settings: [{ hotel_id: HOTEL, simulation_mode: true }],
      room_types: [],
      reservations: [],
      ...seed,
    },
    { rpc: (fn, args, tables) => rpc(fn, args, tables) },
  );
}

function stubEngine(priced: Priced[], opts: { fail?: boolean; changed?: string[] } = {}) {
  return async (_s: SupabaseClient, _h: string, evalTs: string | undefined, _hz: number, o?: EvaluateOptions) => {
    if (opts.fail) throw new Error("engine down");
    priced.push({ at: String(evalTs), nights: o?.nights ? [...o.nights] : "window", kind: o?.runKind });
    const report = o?.report as CadenceReport | undefined;
    if (report) {
      report.nights = o?.nights ? [...o.nights] : [];
      report.failedNights = [];
      report.momentumNights = [];
      report.changedNights = opts.changed ?? [];
      report.engineMs = 1;
    }
    return { run_id: "r" };
  };
}

async function tick(
  d: ReturnType<typeof hotelDb>,
  atIso: string,
  priced: Priced[],
  over: Partial<Parameters<typeof runPricingTick>[2]> = {},
  engine = stubEngine(priced),
) {
  const at = Date.parse(atIso);
  vi.setSystemTime(new Date(at));
  return runPricingTick(
    d.client,
    HOTEL,
    {
      horizonDays: 30,
      adapter: null,
      noAdapter: { skipped: "disabled" },
      runEvaluate: true,
      pushEnabled: false,
      evaluateBy: at + 10 * 60_000,
      pushDeadlineAt: at + 10 * 60_000,
      read: "ok",
      cadence: "daily",
      cadenceConfig: { chunkNights: 10, runMaxNights: 20, tickPassNights: 1000, passMinTimeMs: 0, passMaxLagMinutes: 120 },
      ...over,
    },
    { evaluate: engine, now: () => at },
  );
}

beforeEach(() => {
  resetCadenceMissingSeen();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runPricingTick with the pricing cadence", () => {
  it("a hotel connected mid-day prices its whole window in chunks, then only what changes, then passes again after its midnight", async () => {
    const d = hotelDb("America/New_York");
    const priced: Priced[] = [];
    // 14:00 in New York on Oct 1: the first pass starts now.
    let r = await tick(d, "2026-10-01T18:00:00.000Z", priced);
    expect(r.cadence).toMatchObject({ mode: "daily", chunk: 10, passStarted: "first_run", passNext: "2026-10-11" });
    expect(r.passWorkLeft).toBe(true);
    await tick(d, "2026-10-01T18:05:00.000Z", priced);
    r = await tick(d, "2026-10-01T18:10:00.000Z", priced);
    expect(r.passWorkLeft).toBe(false);
    expect(priced.map((p) => (p.nights as string[]).length)).toEqual([10, 10, 10]);
    expect(new Set(priced.flatMap((p) => p.nights as string[])).size).toBe(30);
    expect(d.tables.hotel_pricing_state[0]).toMatchObject({ pass_date: "2026-10-01", pass_cursor: null, pass_horizon_days: 30 });

    // Nothing changed: an idle tick, with a heartbeat for the status page and the guard.
    r = await tick(d, "2026-10-01T18:15:00.000Z", priced);
    expect(r.evaluate).toEqual({ idle: true });
    expect(priced).toHaveLength(3);
    expect(d.tables.evaluation_run_log.at(-1)).toMatchObject({ run_kind: "idle", evaluated_at: "2026-10-01T18:15:00.000Z" });

    // A booking on the 9th: that night alone, in the tick that reads it.
    const before = d.tables.reservations.map((x) => ({ ...x }));
    d.tables.reservations.push({ id: "b1", hotel_id: HOTEL, stay_date: "2026-10-09", room_type_id: "rt", current_rate: 100 });
    markBookingChanges(d.tables, before, d.tables.reservations, "2026-10-01T18:19:00.000Z");
    await tick(d, "2026-10-01T18:20:00.000Z", priced);
    expect(priced.at(-1)).toMatchObject({ nights: ["2026-10-09"], kind: "nights" });
    expect(d.tables.pricing_dirty_nights).toEqual([]);

    // 23:55 in New York: still Oct 1, nothing to do.
    await tick(d, "2026-10-02T03:55:00.000Z", priced);
    expect(priced).toHaveLength(4);
    // 00:05 on Oct 2: a new pass, nearest nights first.
    r = await tick(d, "2026-10-02T04:05:00.000Z", priced);
    expect(r.cadence).toMatchObject({ passStarted: "new_day" });
    expect((priced.at(-1)!.nights as string[])[0]).toBe("2026-10-02");
  });

  it("across the end of daylight saving time: one pass for the day with 25 hours, and the next at the following midnight", async () => {
    const d = hotelDb("America/New_York");
    const priced: Priced[] = [];
    const cfg = { cadenceConfig: { chunkNights: 30, runMaxNights: 60, tickPassNights: 1000, passMinTimeMs: 0, passMaxLagMinutes: 120 } };
    const starts: (string | null)[] = [];
    // Oct 31 23:55 EDT, Nov 1 00:05 EDT, 01:30 EDT, 01:30 EST (the hour
    // again), 23:55 EST, Nov 2 00:05 EST.
    for (const at of [
      "2026-11-01T03:55:00.000Z",
      "2026-11-01T04:05:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-02T04:55:00.000Z",
      "2026-11-02T05:05:00.000Z",
    ]) {
      const r = await tick(d, at, priced, cfg);
      starts.push(r.cadence?.passStarted ?? null);
    }
    expect(starts).toEqual(["first_run", "new_day", null, null, null, "new_day"]);
    // The hotel's day begins at its local midnight, an hour later in UTC after the change.
    expect(hotelDayStartIso("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z");
    expect(hotelDayStartIso("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00.000Z");
    // Spring forward: the day that loses an hour still begins at local midnight.
    expect(hotelDayStartIso("2027-03-14", "America/New_York")).toBe("2027-03-14T05:00:00.000Z");
    expect(hotelDayStartIso("2027-03-15", "America/New_York")).toBe("2027-03-15T04:00:00.000Z");
  });

  it("a crash between pricing and recording leaves the marks and the cursor: the next tick prices the same nights", async () => {
    const d = hotelDb("UTC");
    const priced: Priced[] = [];
    await tick(d, "2026-10-01T00:05:00.000Z", priced);
    markNights(d.tables, HOTEL, ["2026-10-20"], "booking", "2026-10-01T00:06:00.000Z");
    const failing = hotelDb("UTC");
    failing.tables.hotel_pricing_state = structuredClone(d.tables.hotel_pricing_state);
    failing.tables.pricing_dirty_nights = structuredClone(d.tables.pricing_dirty_nights);
    failing.tables.__pricing_mark_seq = structuredClone(d.tables.__pricing_mark_seq);
    const down = fakeSupabase(failing.tables, {
      rpc: (fn, args, tables) => (fn === "pricing_run_done" ? new FakeRpcError({ code: "08006", message: "connection failure" }) : cadenceRpc(fn, args, tables)),
    });
    const priced2: Priced[] = [];
    const at = Date.parse("2026-10-01T00:10:00.000Z");
    vi.setSystemTime(new Date(at));
    const r = await runPricingTick(
      down.client,
      HOTEL,
      {
        horizonDays: 30,
        adapter: null,
        noAdapter: { skipped: "disabled" },
        runEvaluate: true,
        pushEnabled: false,
        evaluateBy: at + 600_000,
        pushDeadlineAt: at + 600_000,
        read: "ok",
        cadence: "daily",
        cadenceConfig: { chunkNights: 10, runMaxNights: 20, tickPassNights: 1000, passMinTimeMs: 0, passMaxLagMinutes: 120 },
      },
      { evaluate: stubEngine(priced2), now: () => at },
    );
    expect(r.cadence?.error).toMatch(/record the pricing run/);
    expect(down.tables.pricing_dirty_nights.map((x) => x.stay_date)).toEqual(["2026-10-20"]);
    expect(down.tables.hotel_pricing_state[0].pass_cursor).toBe("2026-10-11");
    // Recording works again: the same chunk and the same mark.
    const up = fakeSupabase(down.tables, { rpc: (fn, args, tables) => cadenceRpc(fn, args, tables) });
    const priced3: Priced[] = [];
    vi.setSystemTime(new Date(at + 300_000));
    await runPricingTick(
      up.client,
      HOTEL,
      {
        horizonDays: 30,
        adapter: null,
        noAdapter: { skipped: "disabled" },
        runEvaluate: true,
        pushEnabled: false,
        evaluateBy: at + 900_000,
        pushDeadlineAt: at + 900_000,
        read: "ok",
        cadence: "daily",
        cadenceConfig: { chunkNights: 10, runMaxNights: 20, tickPassNights: 1000, passMinTimeMs: 0, passMaxLagMinutes: 120 },
      },
      { evaluate: stubEngine(priced3), now: () => at + 300_000 },
    );
    expect(priced3[0].nights).toEqual(priced2[0].nights);
    expect(up.tables.pricing_dirty_nights).toEqual([]);
    expect(up.tables.hotel_pricing_state[0].pass_cursor).toBe("2026-10-21");
  });

  it("an engine failure clears nothing and moves nothing, and says pass work is left", async () => {
    const d = hotelDb("UTC");
    const priced: Priced[] = [];
    markNights(d.tables, HOTEL, ["2026-10-03"], "booking", "2026-10-01T00:00:00.000Z");
    const r = await tick(d, "2026-10-01T00:05:00.000Z", priced, {}, stubEngine(priced, { fail: true }));
    expect(r.evaluate).toEqual({ error: "engine down" });
    expect(r.passWorkLeft).toBe(true);
    expect(d.tables.pricing_dirty_nights.map((x) => x.stay_date)).toEqual(["2026-10-03"]);
    // The only thing recorded is the failure itself (pricing_run_failed).
    expect(d.tables.hotel_pricing_state ?? []).toEqual([
      expect.objectContaining({ hotel_id: HOTEL, failed_runs: 1, last_error: "evaluate: engine down", last_ok_run_at: null, pass_date: null, pass_cursor: null }),
    ]);
  });

  it("nothing is priced after a failed read, and the first good read after midnight starts the day's pass", async () => {
    const d = hotelDb("UTC");
    const priced: Priced[] = [];
    await tick(d, "2026-10-01T12:00:00.000Z", priced, { cadenceConfig: { chunkNights: 30, runMaxNights: 60, tickPassNights: 1000, passMinTimeMs: 0, passMaxLagMinutes: 120 } });
    const failed = await tick(d, "2026-10-02T00:05:00.000Z", priced, { read: "failed" });
    expect(failed.evaluate).toEqual({ skipped: "sync_failed" });
    expect(d.tables.hotel_pricing_state[0].pass_date).toBe("2026-10-01");
    const r = await tick(d, "2026-10-02T00:10:00.000Z", priced);
    expect(r.cadence).toMatchObject({ passStarted: "new_day" });
    expect(d.tables.hotel_pricing_state[0].pass_date).toBe("2026-10-02");
  });

  it("an owner edit asks for a new pass, taken up by the next tick, nearest nights first", async () => {
    const d = hotelDb("UTC");
    const priced: Priced[] = [];
    const cfg = { cadenceConfig: { chunkNights: 30, runMaxNights: 60, tickPassNights: 1000, passMinTimeMs: 0, passMaxLagMinutes: 120 } };
    await tick(d, "2026-10-01T09:00:00.000Z", priced, cfg);
    await tick(d, "2026-10-01T09:05:00.000Z", priced, cfg);
    expect(priced).toHaveLength(1);
    markHotel(d.tables, HOTEL, "2026-10-01T09:06:00.000Z");
    const r = await tick(d, "2026-10-01T09:10:00.000Z", priced, cfg);
    expect(r.cadence).toMatchObject({ passStarted: "owner_edit" });
    expect(priced).toHaveLength(2);
    // And only once.
    await tick(d, "2026-10-01T09:15:00.000Z", priced, cfg);
    expect(priced).toHaveLength(2);
  });

  it("a night where the run changed a rule's state is priced again next tick, until a run changes nothing there", async () => {
    const d = hotelDb("UTC");
    const priced: Priced[] = [];
    const cfg = { cadenceConfig: { chunkNights: 30, runMaxNights: 60, tickPassNights: 1000, passMinTimeMs: 0, passMaxLagMinutes: 120 } };
    await tick(d, "2026-10-01T09:00:00.000Z", priced, cfg, stubEngine(priced, { changed: ["2026-10-04"] }));
    expect(d.tables.pricing_dirty_nights.map((x) => [x.stay_date, x.reasons])).toEqual([["2026-10-04", ["follow_up"]]]);
    await tick(d, "2026-10-01T09:05:00.000Z", priced, cfg);
    expect(priced.at(-1)!.nights).toEqual(["2026-10-04"]);
    expect(d.tables.pricing_dirty_nights).toEqual([]);
  });

  it("spreads a midnight wave: hotels share the invocation's pass budget, and each still prices its touched nights", async () => {
    const budget = { remaining: 15 };
    const cfg = { cadenceConfig: { chunkNights: 10, runMaxNights: 20, tickPassNights: 15, passMinTimeMs: 0, passMaxLagMinutes: 120 }, passBudget: budget };
    const a = hotelDb("UTC");
    const b = hotelDb("UTC");
    markNights(b.tables, HOTEL, ["2026-10-07"], "booking", "2026-10-01T00:00:00.000Z");
    const pa: Priced[] = [];
    const pb: Priced[] = [];
    const ra = await tick(a, "2026-10-01T00:05:00.000Z", pa, cfg);
    const rb = await tick(b, "2026-10-01T00:05:00.000Z", pb, cfg);
    expect(ra.cadence?.chunk).toBe(10);
    expect(rb.cadence?.chunk).toBe(5);
    expect(pb[0].nights).toContain("2026-10-07");
    const c = hotelDb("UTC");
    markNights(c.tables, HOTEL, ["2026-10-09"], "booking", "2026-10-01T00:00:00.000Z");
    const pc: Priced[] = [];
    const rc = await tick(c, "2026-10-01T00:05:00.000Z", pc, cfg);
    expect(rc.cadence?.chunk).toBe(0);
    expect(pc[0].nights).toEqual(["2026-10-09"]);
    // Due again soon: its pass has not started.
    expect(rc.passWorkLeft).toBe(true);
  });

  it("MAYA_PRICING_CADENCE=every_tick prices the whole window every tick and clears the marks", async () => {
    const d = hotelDb("UTC");
    const priced: Priced[] = [];
    markNights(d.tables, HOTEL, ["2026-10-03"], "booking", "2026-10-01T00:00:00.000Z");
    await tick(d, "2026-10-01T00:05:00.000Z", priced, { cadence: "every_tick" });
    await tick(d, "2026-10-01T00:10:00.000Z", priced, { cadence: "every_tick" });
    expect(priced.map((p) => [p.nights, p.kind])).toEqual([
      ["window", "window"],
      ["window", "window"],
    ]);
    expect(d.tables.pricing_dirty_nights).toEqual([]);
  });

  it("before the migration: the whole window every tick, never past 60 nights, logged once", async () => {
    const d = hotelDb("UTC", {}, (fn) => (fn.startsWith("pricing_") ? new FakeRpcError(missingFunction(fn)) : undefined));
    const priced: Priced[] = [];
    const seen: number[] = [];
    const engine = async (s: SupabaseClient, h: string, evalTs: string | undefined, hz: number, o?: EvaluateOptions) => {
      seen.push(hz);
      return stubEngine(priced)(s, h, evalTs, hz, o);
    };
    const r = await tick(d, "2026-10-01T00:05:00.000Z", priced, { horizonDays: 396 }, engine);
    await tick(d, "2026-10-01T00:10:00.000Z", priced, { horizonDays: 396 }, engine);
    expect(r.cadence?.mode).toBe("pre_migration");
    expect(seen).toEqual([60, 60]);
    expect(priced.every((p) => p.nights === "window")).toBe(true);
    const lines = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) =>
      String(c[0]).includes("99_supabase_migration_pricing_cadence_v1.sql"),
    );
    expect(lines).toHaveLength(1);
  });
});
