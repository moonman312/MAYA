/**
 * Scheduled Cloudbeds sync + pricing evaluation.
 *
 * For every hotel with a `pms_type = 'cloudbeds'` connection (or a single hotel
 * when `{ hotel_id }` is posted):
 *   1. Pull fresh reservations/room-types from Cloudbeds (runCloudbedsSyncForHotel)
 *   2. Run the pricing rules engine                      (evaluateHotel)
 *
 * Parallel to mews-scheduled-sync. Auth: pg_cron/pg_net sends
 * `x-cloudbeds-cron-secret`, validated against CLOUDBEDS_CRON_SECRET
 * (verify_jwt=false for this function).
 */

import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { runCloudbedsSyncForHotel } from "../_shared/cloudbeds/sync-hotel.ts";
import { evaluateHotel } from "../_shared/engine/index.ts";
import { createCloudbedsRateAdapter } from "../_shared/cloudbeds/rate-push.ts";
import { pushRatesForHotel } from "../_shared/pms/rate-push.ts";

/**
 * The sync result carries live Cloudbeds credentials because the rate-push
 * step needs them in-process. They must never leave this function: the
 * response body is persisted by pg_net, and this endpoint runs with
 * verify_jwt=false, so anything returned here is readable by anyone who can
 * reach it. Project an explicit allowlist rather than spreading the result,
 * so a field added to the sync type later cannot silently start leaking.
 */
function publicSyncResult(sync: Awaited<ReturnType<typeof runCloudbedsSyncForHotel>>) {
  if (!sync.ok) {
    return {
      ok: false as const,
      error: sync.error,
      cloudbedsStatus: sync.cloudbedsStatus,
      retryAfterMs: sync.retryAfterMs,
    };
  }
  return {
    ok: true as const,
    fetchWindow: sync.fetchWindow,
    apiPages: sync.apiPages,
    roomTypesUpserted: sync.roomTypesUpserted,
    reservationRowsUpserted: sync.reservationRowsUpserted,
    ingest: sync.ingest,
  };
}

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
  const cronSecret = getEnv("CLOUDBEDS_CRON_SECRET");
  if (cronSecret) {
    const header = req.headers.get("x-cloudbeds-cron-secret");
    if (header !== cronSecret) {
      return unauthorized("Invalid or missing x-cloudbeds-cron-secret.");
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
  // Keep the per-tick evaluation small enough to finish inside the Edge runtime
  // limit. 45 days covers the near-term calendar; raise once you've confirmed
  // run durations in the logs. Env override: MAYA_EVAL_HORIZON_DAYS.
  const horizonDays = Math.max(1, Number(getEnv("MAYA_EVAL_HORIZON_DAYS") ?? "45") || 45);
  // Outbound rate push is OFF unless explicitly enabled, and even then only
  // fires for hotels in LIVE mode (gated inside pushRatesForHotel).
  const pushRatesEnabled = (getEnv("MAYA_PUSH_RATES") ?? "false").toLowerCase() === "true";

  let bodyHotelId: string | null = null;
  try {
    const text = await req.text();
    if (text) {
      const body = JSON.parse(text) as { hotel_id?: string };
      if (body?.hotel_id) bodyHotelId = String(body.hotel_id);
    }
  } catch {
    // ignore
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
      .eq("pms_type", "cloudbeds");
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
    sync: ReturnType<typeof publicSyncResult>;
    evaluate?: Awaited<ReturnType<typeof evaluateHotel>> | { error: string } | { skipped: true };
    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    push?: any;
  }> = [];

  for (const hotelId of hotelIds) {
    const t0 = Date.now();
    const sync = await runCloudbedsSyncForHotel(supabase, hotelId);
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

    // Outbound rate push — needs live credentials (only available when sync
    // succeeded). Internally no-ops unless the hotel is in LIVE mode.
    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let push: any = pushRatesEnabled ? undefined : { skipped: "disabled" };
    if (pushRatesEnabled) {
      if (sync.ok) {
        try {
          const adapter = createCloudbedsRateAdapter(sync.creds);
          push = await pushRatesForHotel(supabase, hotelId, adapter);
        } catch (e) {
          push = { error: e instanceof Error ? e.message : "push failed" };
        }
      } else {
        push = { skipped: "no_credentials" };
      }
    }
    const tPush = Date.now();

    console.log(
      JSON.stringify({
        fn: "cloudbeds-scheduled-sync",
        hotelId,
        syncOk: sync.ok,
        syncError: sync.ok ? undefined : sync.error,
        evaluate,
        push,
        syncMs: tSync - t0,
        evalMs: tEval - tSync,
        pushMs: tPush - tEval,
        horizonDays,
      }),
    );

    results.push({ hotelId, sync: publicSyncResult(sync), evaluate, push });
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
