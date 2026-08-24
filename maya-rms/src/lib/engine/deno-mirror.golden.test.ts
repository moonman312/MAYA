import { expect, it, vi } from "vitest";
import { evaluateHotel } from "../../../supabase/functions/_shared/engine/evaluate.ts";
import { EVAL_TS, EVAL_TS_RERUN, HOTEL_ID, makeGoldenFixture } from "./golden-fixture";

it("deno mirror produces the identical golden run", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(EVAL_TS));
  const fx = makeGoldenFixture();
  const run1 = await evaluateHotel(fx.supabase, HOTEL_ID, EVAL_TS, 5);
  const run2 = await evaluateHotel(fx.supabase, HOTEL_ID, EVAL_TS_RERUN, 5);
  expect({ ...run1, run_id: "x" }).toEqual({
    run_id: "x", hotel_id: HOTEL_ID, stay_dates_evaluated: 5, prices_published: 7,
    ladder_activations: 11, ladder_deactivations: 2, pickup_events_created: 2,
  });
  expect({ ...run2, run_id: "x" }).toEqual({
    run_id: "x", hotel_id: HOTEL_ID, stay_dates_evaluated: 5, prices_published: 0,
    ladder_activations: 0, ladder_deactivations: 0, pickup_events_created: 0,
  });
  vi.useRealTimers();
}, 30000);
