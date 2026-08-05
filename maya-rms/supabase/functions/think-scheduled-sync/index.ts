/**
 * Scheduled Think sync + pricing evaluation.
 *
 * For every hotel with a `pms_type = 'think'` connection (or a single hotel
 * when `{ hotel_id }` is posted):
 *   1. Pull fresh reservations/room-types from Think (runThinkSyncForHotel)
 *   2. Run the pricing rules engine                  (evaluateHotel)
 *
 * Parallel to mews-scheduled-sync. Auth: pg_cron/pg_net sends
 * `x-think-cron-secret`, validated against THINK_CRON_SECRET
 * (verify_jwt=false for this function).
 */

import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { runThinkSyncForHotel } from "../_shared/think/sync-hotel.ts";
import { createThinkRateAdapter } from "../_shared/think/rate-push.ts";
import { THINK_API_BASE_URL } from "../_shared/think/constants.ts";
import { evaluateHotel } from "../_shared/engine/index.ts";
import { pushRatesForHotel } from "../_shared/pms/rate-push.ts";
import { resolveOAuthCredentials } from "../_shared/pms/oauth-credentials.ts";
import { splitByEntitlement } from "../_shared/billing/entitlement.ts";
import { recordRoomCount } from "../_shared/billing/room-count.ts";

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
  const cronSecret = getEnv("THINK_CRON_SECRET");
  if (cronSecret) {
    const header = req.headers.get("x-think-cron-secret");
    if (header !== cronSecret) {
      return unauthorized("Invalid or missing x-think-cron-secret.");
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
  // Outbound rate push is OFF unless explicitly enabled, and even then only
  // fires for hotels in LIVE mode (gated inside pushRatesForHotel).
  const pushRatesEnabled = (getEnv("MAYA_PUSH_RATES") ?? "false").toLowerCase() === "true";

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

  // How much one invocation takes. Small enough to finish inside the Edge
  // runtime limit with room for the slowest hotel; raise it, or add cron
  // entries, as the fleet grows. Both are configuration.
  const batchSize = Math.max(1, Number(getEnv("MAYA_SYNC_BATCH_SIZE") ?? "25") || 25);
  const leaseSeconds = Math.max(60, Number(getEnv("MAYA_SYNC_LEASE_SECONDS") ?? "600") || 600);
  // How long until a healthy connection is due again. The cron can tick more
  // often than this without doing extra work — claim_pms_sync_batch only returns
  // what is actually due, so over-ticking costs one cheap query.
  const syncIntervalSeconds = Math.max(60, Number(getEnv("MAYA_SYNC_INTERVAL_SECONDS") ?? "300") || 300);
  const workerId = crypto.randomUUID();

  let hotelIds: string[];
  if (bodyHotelId) {
    hotelIds = [bodyHotelId];
  } else {
    // Claim a bounded batch under a lease rather than listing every connection
    // and looping it. Selecting them all is fine at seven hotels and impossible
    // at twenty thousand: one invocation has a wall clock, and the tail of the
    // list simply never runs.
    //
    // FOR UPDATE SKIP LOCKED inside claim_pms_sync_batch is what makes this
    // scale without coordination — two workers running at the same instant take
    // disjoint rows instead of blocking, so capacity is "run more invocations"
    // rather than a redesign. The lease is what makes a crashed worker safe: it
    // expires and the next tick picks the hotel back up.
    const { data: claimed, error: listErr } = await supabase.rpc("claim_pms_sync_batch", {
      p_pms_type: "think",
      p_limit: batchSize,
      p_lease_seconds: leaseSeconds,
      p_owner: workerId,
    });
    if (listErr) {
      return new Response(JSON.stringify({ ok: false, error: listErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    hotelIds = ((claimed ?? []) as { hotel_id: string }[]).map((r) => r.hotel_id).filter(Boolean);
  }

  // Lapsed hotels are dropped before any work happens, not after: syncing and
  // evaluating them burns the PMS's rate limit and our compute, and pushing the
  // result would be delivering the product to someone who stopped paying for it.
  // Trialing and past_due still pass — see isEntitledStatus for why.
  const { allowed: entitledHotelIds, blocked } = await splitByEntitlement(supabase, hotelIds);
  if (blocked.length > 0) {
    console.log(JSON.stringify({ fn: "think-scheduled-sync", skippedUnpaid: blocked }));
  }
  hotelIds = entitledHotelIds;

  const results: Array<{
    hotelId: string;
    sync: Awaited<ReturnType<typeof runThinkSyncForHotel>>;
    evaluate?: Awaited<ReturnType<typeof evaluateHotel>> | { error: string } | { skipped: true };
    rooms?: Awaited<ReturnType<typeof recordRoomCount>> | null;
  }> = [];

  for (const hotelId of hotelIds) {
    const t0 = Date.now();
    const sync = await runThinkSyncForHotel(supabase, hotelId);
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

    // Outbound rate push. The sync result carries no credentials (unlike
    // Cloudbeds'), so the push re-resolves them — one Vault RPC, and the
    // token the sync just refreshed is the one that comes back. Internally
    // no-ops unless the hotel is in LIVE mode.
    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let push: any = pushRatesEnabled ? undefined : { skipped: "disabled" };
    if (pushRatesEnabled) {
      if (sync.ok) {
        try {
          const resolved = await resolveOAuthCredentials(supabase, hotelId, "think");
          if ("error" in resolved || !resolved.propertyId) {
            push = { skipped: "no_credentials" };
          } else {
            const { data: connRow } = await supabase
              .from("pms_connections")
              .select("base_url")
              .eq("hotel_id", hotelId)
              .eq("pms_type", "think")
              .maybeSingle();
            const baseUrl = (
              (connRow?.base_url as string | null) || THINK_API_BASE_URL
            ).replace(/\/$/, "");
            const adapter = createThinkRateAdapter(
              { accessToken: resolved.accessToken, baseUrl },
              resolved.propertyId,
            );
            push = await pushRatesForHotel(supabase, hotelId, adapter);
          }
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
        fn: "think-scheduled-sync",
        hotelId,
        syncOk: sync.ok,
        // A budget-truncated run is not a failed one, but sustained false here
        // means the property needs the incremental path more often than it is
        // getting it — worth a look before it needs a bigger budget.
        windowFullyCovered: sync.ok ? sync.windowFullyCovered : undefined,
        syncError: sync.ok ? undefined : sync.error,
        evaluate,
        push,
        syncMs: tSync - t0,
        evalMs: tEval - tSync,
        pushMs: tPush - tEval,
        horizonDays,
      }),
    );

    // Re-measure what they actually run. room_types was just refreshed from the
    // PMS, so this is the freshest the number ever gets. Measuring here rather
    // than at onboarding is the point: properties grow, and the old one-off
    // reading meant a hotel that opened a wing paid its old price forever.
    const roomVerdict = sync.ok ? await recordRoomCount(supabase, hotelId, new Date()) : null;

    results.push({ hotelId, sync, evaluate, rooms: roomVerdict });

    // Hand the claim back and say when this hotel next wants looking at. A
    // failure backs off exponentially inside release_pms_sync, so one hotel with
    // a revoked token stops costing a full-rate retry every tick forever.
    // Skipped for a single-hotel dispatch, which never took a lease.
    if (!bodyHotelId) {
      const { error: releaseErr } = await supabase.rpc("release_pms_sync", {
        p_hotel_id: hotelId,
        p_pms_type: "think",
        p_ok: sync.ok,
        p_interval_seconds: syncIntervalSeconds,
      });
      if (releaseErr) {
        // Not fatal: the lease expires on its own and the next tick reclaims it.
        // Worth saying though — a run of these means the batch is churning.
        console.error(
          JSON.stringify({ fn: "think-scheduled-sync", step: "release", hotelId, error: releaseErr.message }),
        );
      }
    }
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
      // Reported rather than merely logged: a hotel silently absent from a run
      // is indistinguishable from one that never had a connection.
      skippedUnpaid: blocked,
      results,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
