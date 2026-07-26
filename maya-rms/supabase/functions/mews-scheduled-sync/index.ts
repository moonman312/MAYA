/**
 * Scheduled Mews sync + pricing evaluation.
 *
 * For every hotel with a `pms_type = 'mews'` connection (or a single hotel when
 * `{ hotel_id }` is posted):
 *   1. Pull fresh reservations/room-types from Mews  (runMewsSyncForHotel)
 *   2. Run the pricing rules engine                  (evaluateHotel)
 *
 * Step 2 is what actually applies your pricing rules and writes published_price
 * (the calendar's "Current price"). Disable it with MAYA_RUN_EVALUATE=false to
 * get pre-existing sync-only behavior.
 *
 * Auth: pg_cron/pg_net sends `x-mews-cron-secret`; validated against
 * MEWS_CRON_SECRET (verify_jwt=false for this function).
 */

import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { runMewsSyncForHotel } from "../_shared/mews/sync-hotel.ts";
import { evaluateHotel } from "../_shared/engine/index.ts";

function getEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v !== "" ? v : undefined;
}

function unauthorized(msg: string): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const cronSecret = getEnv("MEWS_CRON_SECRET");
  if (cronSecret) {
    const header = req.headers.get("x-mews-cron-secret");
    if (header !== cronSecret) {
      return unauthorized("Invalid or missing x-mews-cron-secret.");
    }
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const runEvaluate = (getEnv("MAYA_RUN_EVALUATE") ?? "true").toLowerCase() !== "false";
  // Bound the per-tick evaluation so it finishes inside the Edge runtime limit.
  const horizonDays = Math.max(1, Number(getEnv("MAYA_EVAL_HORIZON_DAYS") ?? "45") || 45);

  // Optional single-hotel dispatch: body { hotel_id }.
  let bodyHotelId: string | null = null;
  try {
    const text = await req.text();
    if (text) {
      const body = JSON.parse(text) as { hotel_id?: string };
      if (body?.hotel_id) bodyHotelId = String(body.hotel_id);
    }
  } catch {
    // ignore malformed body; fall back to fleet mode
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let hotelIds: string[];
  if (bodyHotelId) {
    hotelIds = [bodyHotelId];
  } else {
    const { data: connRows, error: listErr } = await supabase
      .from("pms_connections")
      .select("hotel_id")
      .eq("pms_type", "mews");
    if (listErr) {
      return new Response(JSON.stringify({ ok: false, error: listErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    hotelIds = [...new Set((connRows ?? []).map((r) => r.hotel_id).filter(Boolean))] as string[];
  }

  const results: Array<{
    hotelId: string;
    sync: Awaited<ReturnType<typeof runMewsSyncForHotel>>;
    evaluate?: Awaited<ReturnType<typeof evaluateHotel>> | { error: string } | { skipped: true };
  }> = [];

  for (const hotelId of hotelIds) {
    const t0 = Date.now();
    const sync = await runMewsSyncForHotel(supabase, hotelId);
    const tSync = Date.now();

    let evaluate: (typeof results)[number]["evaluate"];
    if (runEvaluate) {
      try {
        evaluate = await evaluateHotel(supabase, hotelId, undefined, horizonDays);
      } catch (e) {
        evaluate = { error: e instanceof Error ? e.message : "evaluate failed" };
      }
    } else {
      evaluate = { skipped: true };
    }
    const tEval = Date.now();

    console.log(
      JSON.stringify({
        fn: "mews-scheduled-sync",
        hotelId,
        syncOk: sync.ok,
        syncError: sync.ok ? undefined : sync.error,
        evaluate,
        syncMs: tSync - t0,
        evalMs: tEval - tSync,
        horizonDays,
      }),
    );

    results.push({ hotelId, sync, evaluate });
  }

  const failed = results.filter(
    (r) => r.sync.ok === false || (r.evaluate && "error" in r.evaluate),
  );

  return new Response(
    JSON.stringify({
      ok: failed.length === 0,
      hotels: hotelIds.length,
      failedHotels: failed.length,
      evaluated: runEvaluate,
      results,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
