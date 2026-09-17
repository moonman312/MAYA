/**
 * The scheduled tick after the PMS read: refresh the base, evaluate on it,
 * push. One hotel date for all three, and one horizon, so the push never
 * sends a night this tick did not price or a night with no fresh base.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPricingTick } from "../../../supabase/functions/_shared/pms/pricing-tick";
import type {
  CellPushResult,
  PmsRatePushAdapter,
  RateCalendarEntry,
  RateCell,
} from "../../../supabase/functions/_shared/pms/rate-push";
import { fakeSupabase, type FakeRow } from "../engine/fake-supabase.test";
import type { SupabaseClient } from "@supabase/supabase-js";

const HOTEL = "hotel-1";

function db(seed: Record<string, FakeRow[]> = {}, opts: Parameters<typeof fakeSupabase>[1] = {}) {
  return fakeSupabase(
    {
      hotels: [{ id: HOTEL, timezone: "America/Los_Angeles" }],
      hotel_settings: [{ hotel_id: HOTEL, simulation_mode: false }],
      room_types: [{ id: "rt-king", hotel_id: HOTEL, external_room_type_id: "CB-KING", is_active: true }],
      pms_connections: [
        { id: "conn-1", hotel_id: HOTEL, pms_type: "cloudbeds", base_rates_refreshed_at: null, push_rate_targets: null },
      ],
      base_rate_calendar: [],
      rate_updates: [],
      published_price: [],
      ...seed,
    },
    opts,
  );
}

function makeAdapter(entries: RateCalendarEntry[] = []) {
  const log: string[] = [];
  const adapter: PmsRatePushAdapter = {
    pmsType: "cloudbeds",
    async resolveRateTargets() {
      log.push("resolve");
      return { "CB-KING": "base-1" };
    },
    async readBaseRateCalendar(start, end) {
      log.push(`calendar:${start}..${end}`);
      return { targets: { "CB-KING": "base-1" }, entries };
    },
    async pushCells(cells: Array<RateCell & { externalRateId: string }>): Promise<CellPushResult[]> {
      log.push(`push:${cells.map((c) => c.stayDate).join(",")}`);
      return cells.map((cell) => ({ cell, ok: true, jobReference: "accepted:202" }));
    },
  };
  return { adapter, log };
}

/** An engine stand-in: records what it was asked and publishes the nights it is told to. */
function makeEvaluate(d: ReturnType<typeof db>, log: string[], nights: string[]) {
  const seen: { evalTs: string | undefined; horizonDays: number; baseAtStart: FakeRow[] }[] = [];
  const evaluate = async (_s: SupabaseClient, _h: string, evalTs: string | undefined, horizonDays: number) => {
    log.push("evaluate");
    seen.push({ evalTs, horizonDays, baseAtStart: (d.tables.base_rate_calendar ?? []).map((r) => ({ ...r })) });
    for (const stay_date of nights) {
      d.tables.published_price.push({ hotel_id: HOTEL, stay_date, room_type_id: "rt-king", price: 250 });
    }
    return { run_id: "run-1" };
  };
  return { evaluate, seen };
}

const BASE_OPTS = { horizonDays: 60, runEvaluate: true, pushEnabled: true, pushDeadlineAt: Number.MAX_SAFE_INTEGER };
// 22:00 on Oct 1 in Los Angeles; already Oct 2 in UTC.
const T0 = Date.parse("2026-10-02T05:00:00Z");

const sentNights = (d: ReturnType<typeof db>) =>
  d.tables.rate_updates.filter((r) => r.status === "sent").map((r) => r.stay_date).sort();

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runPricingTick", () => {
  it("refreshes the base, evaluates on it, then pushes exactly the nights it evaluated, all on the hotel's date", async () => {
    const d = db();
    const { adapter, log } = makeAdapter([{ stayDate: "2026-10-01", externalRoomTypeId: "CB-KING", price: 210 }]);
    const { evaluate, seen } = makeEvaluate(d, log, ["2026-10-01", "2026-11-29", "2026-11-30"]);

    const res = await runPricingTick(
      d.client,
      HOTEL,
      { ...BASE_OPTS, adapter, evaluateBy: T0 + 60_000 },
      { evaluate, now: () => T0 },
    );

    // (The push resolves its own targets: nothing is cached on the connection yet.)
    expect(log).toEqual(["calendar:2026-10-01..2026-11-29", "evaluate", "resolve", "push:2026-10-01,2026-11-29"]);
    // The engine got the tick's instant, which is Oct 1 in Los Angeles, and the same horizon.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ evalTs: "2026-10-02T05:00:00.000Z", horizonDays: 60 });
    expect(seen[0].baseAtStart).toEqual([expect.objectContaining({ stay_date: "2026-10-01", price: 210 })]);
    expect(sentNights(d)).toEqual(["2026-10-01", "2026-11-29"]);
    expect(res).toMatchObject({
      today: "2026-10-01",
      calendar: { ok: true, captured: 1, pmsEditedPushedNights: 0 },
      evaluate: { run_id: "run-1" },
      push: { pushed: true, sent: 2 },
      pmsEditedPushedNights: 0,
      outOfTime: false,
    });
  });

  it("keeps the tick's date for the push even if the hotel's midnight passes mid-tick", async () => {
    const d = db();
    const { adapter, log } = makeAdapter();
    const { evaluate } = makeEvaluate(d, log, ["2026-10-01", "2026-11-29", "2026-11-30"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T07:05:00Z")); // 00:05 Oct 2 in Los Angeles by the time anything reads Date

    await runPricingTick(d.client, HOTEL, { ...BASE_OPTS, adapter, evaluateBy: T0 + 60_000 }, { evaluate, now: () => T0 });

    expect(sentNights(d)).toEqual(["2026-10-01", "2026-11-29"]);
  });

  it("uses one horizon for the refresh, the evaluation and the push", async () => {
    const d = db();
    const { adapter, log } = makeAdapter();
    const { evaluate, seen } = makeEvaluate(d, log, ["2026-10-01", "2026-10-14", "2026-10-15"]);

    await runPricingTick(d.client, HOTEL, { ...BASE_OPTS, horizonDays: 14, adapter, evaluateBy: T0 + 60_000 }, { evaluate, now: () => T0 });

    expect(log[0]).toBe("calendar:2026-10-01..2026-10-14");
    expect(seen[0].horizonDays).toBe(14);
    expect(sentNights(d)).toEqual(["2026-10-01", "2026-10-14"]);
  });

  it("surfaces pushed nights the PMS now quotes differently", async () => {
    const d = db({
      rate_updates: [{ id: "1", hotel_id: HOTEL, stay_date: "2026-10-03", room_type_id: "rt-king", price: 230, status: "sent" }],
    });
    const { adapter, log } = makeAdapter([{ stayDate: "2026-10-03", externalRoomTypeId: "CB-KING", price: 199 }]);
    const { evaluate } = makeEvaluate(d, log, []);

    const res = await runPricingTick(
      d.client,
      HOTEL,
      { ...BASE_OPTS, pushEnabled: false, adapter, evaluateBy: T0 + 60_000 },
      { evaluate, now: () => T0 },
    );

    expect(res.pmsEditedPushedNights).toBe(1);
    expect(res.push).toEqual({ skipped: "disabled" });
    expect(d.tables.base_rate_calendar).toEqual([]);
  });

  it("starts nothing past the evaluation cut-off", async () => {
    const d = db();
    const { adapter, log } = makeAdapter();
    const { evaluate } = makeEvaluate(d, log, []);

    const res = await runPricingTick(d.client, HOTEL, { ...BASE_OPTS, adapter, evaluateBy: T0 - 1 }, { evaluate, now: () => T0 });

    expect(log).toEqual([]);
    expect(res).toMatchObject({
      calendar: { skipped: "out_of_time" },
      evaluate: { skipped: "out_of_time" },
      push: { skipped: "out_of_time" },
      outOfTime: true,
    });
  });

  it("skips evaluation and push when the refresh used up the time", async () => {
    const d = db();
    const { adapter, log } = makeAdapter();
    const { evaluate } = makeEvaluate(d, log, []);
    let clock = T0;
    adapter.readBaseRateCalendar = async () => {
      clock += 120_000;
      return { targets: { "CB-KING": "base-1" }, entries: [] };
    };

    const res = await runPricingTick(d.client, HOTEL, { ...BASE_OPTS, adapter, evaluateBy: T0 + 60_000 }, { evaluate, now: () => clock });

    expect(log).toEqual([]);
    expect(res).toMatchObject({ calendar: { ok: true }, evaluate: { skipped: "out_of_time" }, push: { skipped: "out_of_time" }, outOfTime: true });
    expect(res.calendarMs).toBe(120_000);
  });

  it("still evaluates without credentials, and says why nothing was refreshed or pushed", async () => {
    const d = db();
    const { evaluate, seen } = makeEvaluate(d, [], []);

    const res = await runPricingTick(
      d.client,
      HOTEL,
      { ...BASE_OPTS, adapter: null, noAdapter: { error: "vault unavailable" }, evaluateBy: T0 + 60_000 },
      { evaluate, now: () => T0 },
    );

    expect(seen).toHaveLength(1);
    expect(res).toMatchObject({ calendar: { error: "vault unavailable" }, push: { error: "vault unavailable" } });
  });

  it("does not push when the hotel's date can't be read, but still lets the engine run", async () => {
    const d = db({}, { fault: (c) => (c.table === "hotels" ? { message: "connection reset" } : null) });
    const { adapter, log } = makeAdapter();
    const { evaluate, seen } = makeEvaluate(d, log, ["2026-10-01"]);

    const res = await runPricingTick(d.client, HOTEL, { ...BASE_OPTS, adapter, evaluateBy: T0 + 60_000 }, { evaluate, now: () => T0 });

    expect(seen[0].evalTs).toBeUndefined();
    expect(log).toEqual(["evaluate"]);
    expect(d.tables.rate_updates).toEqual([]);
    expect(res).toMatchObject({
      today: null,
      calendar: { error: expect.stringContaining("connection reset") },
      push: { error: expect.stringContaining("connection reset") },
    });
  });

  it("reports an engine failure without taking down the push", async () => {
    const d = db();
    const { adapter } = makeAdapter();
    const res = await runPricingTick(
      d.client,
      HOTEL,
      { ...BASE_OPTS, runEvaluate: true, adapter, evaluateBy: T0 + 60_000 },
      {
        evaluate: async () => {
          throw new Error("x".repeat(500));
        },
        now: () => T0,
      },
    );
    expect(res.evaluate).toEqual({ error: "x".repeat(300) });
    expect(res.push).toEqual({ pushed: false, reason: "no_published_prices" });
  });
});
