/**
 * Drift tripwire for the two engine copies. The canonical and edge engines
 * run the SAME golden fixture, and every table they leave behind — prices,
 * states, transitions, ledger, audits, heartbeats — plus their query
 * profiles must be identical. Counters alone once passed a rounding drift;
 * whole-state equality can't.
 */
import { expect, it, vi } from "vitest";
import { evaluateHotel as canonicalEvaluate } from "./evaluate";
import { evaluateHotel as edgeEvaluate } from "../../../supabase/functions/_shared/engine/evaluate.ts";
import { EVAL_TS, EVAL_TS_RERUN, HOTEL_ID, makeGoldenFixture, type EngineSupabaseStub } from "./golden-fixture";

type Evaluate = typeof canonicalEvaluate;

async function goldenRun(evaluate: Evaluate) {
  const fx: EngineSupabaseStub = makeGoldenFixture();
  const run1 = await evaluate(fx.supabase, HOTEL_ID, EVAL_TS, 5);
  const run2 = await evaluate(fx.supabase, HOTEL_ID, EVAL_TS_RERUN, 5);
  // Run ids are random uuids — normalize them so everything else must match.
  const runIds = new Map<string, string>([
    [run1.run_id, "RUN1"],
    [run2.run_id, "RUN2"],
  ]);
  const tables = JSON.parse(JSON.stringify(fx.tables)) as Record<string, Record<string, unknown>[]>;
  for (const rows of Object.values(tables)) {
    for (const row of rows) {
      if (typeof row.evaluation_run_id === "string" && runIds.has(row.evaluation_run_id)) {
        row.evaluation_run_id = runIds.get(row.evaluation_run_id);
      }
    }
  }
  return {
    results: [
      { ...run1, run_id: "RUN1" },
      { ...run2, run_id: "RUN2" },
    ],
    tables,
    queryCounts: fx.queryCounts,
  };
}

it("edge copy leaves a state indistinguishable from the canonical engine's", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(EVAL_TS));
  const canonical = await goldenRun(canonicalEvaluate);
  const edge = await goldenRun(edgeEvaluate as unknown as Evaluate);
  vi.useRealTimers();

  expect(edge.results).toEqual(canonical.results);
  expect(edge.tables).toEqual(canonical.tables);
  expect(edge.queryCounts).toEqual(canonical.queryCounts);
}, 30000);
