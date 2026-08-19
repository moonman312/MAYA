import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateHotel, type EvaluationResult } from "./evaluate";
import {
  D,
  EVAL_TS,
  EVAL_TS_RERUN,
  HOTEL_ID,
  SEED_TS,
  makeGoldenFixture,
  type EngineSupabaseStub,
  type WriteLogEntry,
} from "./golden-fixture";

/**
 * Total executed queries by "table.op" across BOTH golden runs. This is the
 * efficiency baseline the query-batching refactor exists to beat — update it
 * consciously alongside the refactor, never to quiet a red test.
 */
export const GOLDEN_QUERY_COUNT_BASELINE: Record<string, number> = {
  "assumption_challenges.select": 2,
  "evaluation_audit.delete": 2,
  "evaluation_audit.insert": 7,
  "evaluation_audit.select": 2,
  "evaluation_run_log.delete": 2,
  "evaluation_run_log.upsert": 2,
  "hotel_closed_periods.select": 2,
  "hotels.select": 2,
  "ladder_rule_state.select": 76,
  "ladder_rule_state.update": 25,
  "ladder_rule_state.upsert": 11,
  "ladder_transition_event.insert": 13,
  "pickup_event.insert": 2,
  "pickup_event.select": 40,
  "pickup_event.update": 2,
  "pricing_rules.select": 2,
  "published_price.select": 18,
  "published_price.upsert": 7,
  "reservations.select": 6,
  "room_types.select": 2,
  "stay_date_snapshot.delete": 4,
  "stay_date_snapshot.insert": 2,
  "stay_date_snapshot.select": 244,
};

describe("evaluateHotel golden equivalence", () => {
  let fx: EngineSupabaseStub;
  let run1: EvaluationResult;
  let run2: EvaluationResult;
  let run2Writes: WriteLogEntry[];

  beforeAll(async () => {
    // Only the retention purges read the wall clock; pin it so the golden
    // fixture's fixed dates never age into a purge window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(EVAL_TS));

    fx = makeGoldenFixture();
    run1 = await evaluateHotel(fx.supabase, HOTEL_ID, EVAL_TS, 5);
    const writesAfterRun1 = fx.writeLog.length;
    run2 = await evaluateHotel(fx.supabase, HOTEL_ID, EVAL_TS_RERUN, 5);
    run2Writes = fx.writeLog.slice(writesAfterRun1);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns the golden counters", () => {
    expect(run1).toEqual({
      run_id: run1.run_id,
      hotel_id: HOTEL_ID,
      stay_dates_evaluated: 5,
      prices_published: 7,
      ladder_activations: 11,
      ladder_deactivations: 2,
      pickup_events_created: 2,
    });
  });

  it("publishes the golden prices (d4 unpriceable, d3/rtA unchanged)", () => {
    const published = Object.fromEntries(
      fx.tables.published_price.map((r) => [
        `${r.stay_date}|${r.room_type_id}`,
        { price: r.price, base_price: r.base_price },
      ]),
    );
    expect(published).toEqual({
      [`${D.d0}|rtA`]: { price: 95, base_price: 100 },
      [`${D.d0}|rtB`]: { price: 76, base_price: 80 },
      [`${D.d1}|rtA`]: { price: 126, base_price: 100 }, // ceiling clamp
      [`${D.d1}|rtB`]: { price: 89.45, base_price: 80 },
      [`${D.d2}|rtA`]: { price: 117.7, base_price: 100 },
      [`${D.d2}|rtB`]: { price: 96, base_price: 80 }, // frozen r6 still applies
      [`${D.d3}|rtA`]: { price: 125, base_price: 100 },
      [`${D.d3}|rtB`]: { price: 88, base_price: 80 },
    });
    // Recomputing the identical price must not rewrite the row.
    const seeded = fx.tables.published_price.find(
      (r) => r.stay_date === D.d3 && r.room_type_id === "rtA",
    );
    expect(seeded?.computed_at).toBe(SEED_TS);
  });

  it("lands the golden ladder states, leaving disabled r6 frozen", () => {
    const states = Object.fromEntries(
      fx.tables.ladder_rule_state.map((r) => [
        `${r.rule_id}|${r.stay_date}|${r.room_type_id}`,
        r.is_active,
      ]),
    );
    expect(states).toEqual({
      [`r1|${D.d1}|rtA`]: true,
      [`r1|${D.d1}|rtB`]: true,
      [`r1|${D.d2}|rtA`]: false,
      [`r1|${D.d2}|rtB`]: false,
      [`r1|${D.d3}|rtA`]: true,
      [`r1|${D.d3}|rtB`]: true,
      [`r2|${D.d0}|rtA`]: true,
      [`r2|${D.d0}|rtB`]: true,
      [`r2|${D.d1}|rtA`]: true,
      [`r2|${D.d1}|rtB`]: true,
      [`r2|${D.d2}|rtA`]: true,
      [`r2|${D.d2}|rtB`]: true,
      [`r3|${D.d1}|rtA`]: true,
      [`r3|${D.d2}|rtA`]: true,
      [`r3|${D.d3}|rtA`]: true,
      [`r6|${D.d2}|rtB`]: true,
    });
  });

  it("touches every live state row both runs; frozen r6 is never touched", () => {
    // last_evaluated_at is the only trace of a touch, and the only DB-state
    // difference between "second run touched this row" and "second run never
    // visited it" — query counts alone must not be what locks that (the
    // refactor rewrites the counts). Frozen r6 keeps its seeded timestamp:
    // no pass may touch a disabled rule's state.
    const touched = Object.fromEntries(
      fx.tables.ladder_rule_state.map((r) => [
        `${r.rule_id}|${r.stay_date}|${r.room_type_id}`,
        r.last_evaluated_at,
      ]),
    );
    expect(touched).toEqual({
      [`r1|${D.d1}|rtA`]: EVAL_TS_RERUN,
      [`r1|${D.d1}|rtB`]: EVAL_TS_RERUN,
      [`r1|${D.d2}|rtA`]: EVAL_TS_RERUN,
      [`r1|${D.d2}|rtB`]: EVAL_TS_RERUN,
      [`r1|${D.d3}|rtA`]: EVAL_TS_RERUN,
      [`r1|${D.d3}|rtB`]: EVAL_TS_RERUN,
      [`r2|${D.d0}|rtA`]: EVAL_TS_RERUN,
      [`r2|${D.d0}|rtB`]: EVAL_TS_RERUN,
      [`r2|${D.d1}|rtA`]: EVAL_TS_RERUN,
      [`r2|${D.d1}|rtB`]: EVAL_TS_RERUN,
      [`r2|${D.d2}|rtA`]: EVAL_TS_RERUN,
      [`r2|${D.d2}|rtB`]: EVAL_TS_RERUN,
      [`r3|${D.d1}|rtA`]: EVAL_TS_RERUN,
      [`r3|${D.d2}|rtA`]: EVAL_TS_RERUN,
      [`r3|${D.d3}|rtA`]: EVAL_TS_RERUN,
      [`r6|${D.d2}|rtB`]: SEED_TS,
    });
  });

  it("emits the golden transitions in order (duplicate-affected activates once)", () => {
    const transitions = fx.tables.ladder_transition_event.map(
      (r) => `${r.rule_id}|${r.stay_date}|${r.room_type_id}|${r.transition}`,
    );
    expect(transitions).toEqual([
      `r1|${D.d1}|rtA|activate`,
      `r1|${D.d1}|rtB|activate`,
      `r1|${D.d2}|rtA|deactivate`,
      `r1|${D.d2}|rtB|deactivate`,
      `r2|${D.d0}|rtA|activate`,
      `r2|${D.d0}|rtB|activate`,
      `r2|${D.d1}|rtA|activate`,
      `r2|${D.d1}|rtB|activate`,
      `r2|${D.d2}|rtA|activate`,
      `r2|${D.d2}|rtB|activate`,
      `r3|${D.d1}|rtA|activate`,
      `r3|${D.d2}|rtA|activate`,
      `r3|${D.d3}|rtA|activate`,
    ]);
  });

  it("leaves the golden pickup ledger (past retired, d2 kept, d1 fired)", () => {
    const events = fx.tables.pickup_event.map((r) => ({
      id: r.id,
      rule_id: r.rule_id,
      stay_date: r.stay_date,
      room_type_id: r.affected_room_type_id,
      retired: r.retired_at != null,
      units_start: r.signal_booked_units_start,
      units_end: r.signal_booked_units_end,
      revenue_start: r.signal_booked_revenue_start,
      revenue_end: r.signal_booked_revenue_end,
    }));
    expect(events).toEqual([
      { id: "1", rule_id: "r4", stay_date: "2026-08-18", room_type_id: "rtA", retired: true, units_start: 5, units_end: 8, revenue_start: 500, revenue_end: 800 },
      { id: "2", rule_id: "r4", stay_date: D.d2, room_type_id: "rtA", retired: false, units_start: 3, units_end: 5, revenue_start: 300, revenue_end: 460 },
      { id: "3", rule_id: "r4", stay_date: D.d1, room_type_id: "rtA", retired: false, units_start: 7, units_end: 10, revenue_start: 640, revenue_end: 920 },
      { id: "4", rule_id: "r4", stay_date: D.d1, room_type_id: "rtB", retired: false, units_start: 7, units_end: 10, revenue_start: 640, revenue_end: 920 },
    ]);
  });

  it("writes the golden audit rows, skipping the unchanged cell", () => {
    // `ladder` (matched_ladder_rules as rule:transition) is what proves the
    // duplicate-affected r3 row was VISITED twice — the second visit's noop
    // entry is its only non-query-count trace. `bs` locks the booking-speed
    // block: with zero usable history the recorded observation must say
    // insufficient_data, never a synthesized classification.
    const rows = fx.tables.evaluation_audit
      .filter((r) => r.evaluation_run_id === run1.run_id)
      .map((r) => {
        const details = r.details as {
          application_order: string[];
          clamped_by: string;
          matched_ladder_rules: { rule_id: string; transition: string }[];
          pickup_candidates: { rule_id: string; outcome: string }[];
          booking_speed_observations?: { method?: string }[];
        };
        return {
          stay_date: r.stay_date,
          room_type_id: r.room_type_id,
          final_price: r.final_price,
          application_order: details.application_order,
          clamped_by: details.clamped_by,
          ladder: details.matched_ladder_rules.map((m) => `${m.rule_id}:${m.transition}`),
          pickup: details.pickup_candidates.map((c) => `${c.rule_id}:${c.outcome}`),
          bs: (details.booking_speed_observations ?? []).map((o) => o.method),
        };
      });
    expect(rows).toEqual([
      { stay_date: D.d0, room_type_id: "rtA", final_price: 95, application_order: ["ladder:r2"], clamped_by: "none", ladder: ["r1:noop", "r2:activate", "r3:noop", "r3:noop"], pickup: [], bs: ["insufficient_data"] },
      { stay_date: D.d0, room_type_id: "rtB", final_price: 76, application_order: ["ladder:r2"], clamped_by: "none", ladder: ["r1:noop", "r2:activate"], pickup: [], bs: ["insufficient_data"] },
      { stay_date: D.d1, room_type_id: "rtA", final_price: 126, application_order: ["ladder:r1", "ladder:r2", "ladder:r3", "pickup:3"], clamped_by: "ceiling", ladder: ["r1:activate", "r2:activate", "r3:activate", "r3:noop"], pickup: ["r4:won"], bs: ["insufficient_data"] },
      { stay_date: D.d1, room_type_id: "rtB", final_price: 89.45, application_order: ["ladder:r1", "ladder:r2", "pickup:4"], clamped_by: "none", ladder: ["r1:activate", "r2:activate"], pickup: ["r4:won"], bs: ["insufficient_data"] },
      { stay_date: D.d2, room_type_id: "rtA", final_price: 117.7, application_order: ["ladder:r2", "ladder:r3", "pickup:2"], clamped_by: "none", ladder: ["r1:deactivate", "r2:activate", "r3:activate", "r3:noop"], pickup: [], bs: ["insufficient_data"] },
      { stay_date: D.d2, room_type_id: "rtB", final_price: 96, application_order: ["ladder:r2", "ladder:r6"], clamped_by: "none", ladder: ["r1:deactivate", "r2:activate"], pickup: [], bs: ["insufficient_data"] },
      { stay_date: D.d3, room_type_id: "rtB", final_price: 88, application_order: ["ladder:r1"], clamped_by: "none", ladder: ["r1:noop", "r2:noop"], pickup: [], bs: ["insufficient_data"] },
    ]);
  });

  it("second run is fully idempotent: no publishes, no audits, no transitions", () => {
    expect(run2).toEqual({
      run_id: run2.run_id,
      hotel_id: HOTEL_ID,
      stay_dates_evaluated: 5,
      prices_published: 0,
      ladder_activations: 0,
      ladder_deactivations: 0,
      pickup_events_created: 0,
    });
    expect(run2Writes.filter((w) => w.table === "published_price" && w.op === "upsert")).toEqual([]);
    expect(run2Writes.filter((w) => w.table === "evaluation_audit" && w.op === "insert")).toEqual([]);
    // R3's duplicate affected room type must land as touch, not re-activate.
    expect(run2Writes.filter((w) => w.table === "ladder_transition_event")).toEqual([]);
    expect(fx.tables.pickup_event).toHaveLength(4);
    // The heartbeat is the one write-on-change exception: a quiet run still
    // records that it checked.
    expect(
      fx.tables.evaluation_run_log.map((r) => ({ checked: r.cells_checked, changed: r.cells_changed })),
    ).toEqual([
      { checked: 8, changed: 7 },
      { checked: 8, changed: 0 },
    ]);
  });

  it("holds the query-count baseline the refactor must beat", () => {
    expect(fx.queryCounts).toEqual(GOLDEN_QUERY_COUNT_BASELINE);
  });
});
