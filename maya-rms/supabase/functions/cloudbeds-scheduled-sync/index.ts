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
import { resolveCloudbedsCredentials, runCloudbedsSyncForHotel } from "../_shared/cloudbeds/sync-hotel.ts";
import { evaluateHotel } from "../_shared/engine/index.ts";
import { createCloudbedsRateAdapter } from "../_shared/cloudbeds/rate-push.ts";
import { pushRatesForHotel } from "../_shared/pms/rate-push.ts";
import { ensureBaseRateCalendar } from "../_shared/pms/base-rate-calendar.ts";
import { splitByEntitlement } from "../_shared/billing/entitlement.ts";
import { hotelsImportingNow, splitByParked } from "../_shared/pms/parked.ts";
import { runScheduledHotels, scheduledLoopConfigFromEnv } from "../_shared/pms/scheduled-loop.ts";
import { CLOUDBEDS_SYNC_BUDGET_MS } from "../_shared/cloudbeds/constants.ts";
import { recordRoomCount } from "../_shared/billing/room-count.ts";

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
    // A partial window looks identical to a complete one in the counters, so it
    // has to be said explicitly. False is expected for a few ticks on a very
    // large book, which resumes from its checkpoint; sustained false alongside
    // ingest.source "per_booking" means the account refused rate details and
    // is on the slow path.
    windowFullyCovered: sync.windowFullyCovered,
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
  const invocationStartedAt = Date.now();
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
      p_pms_type: "cloudbeds",
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
    console.log(JSON.stringify({ fn: "cloudbeds-scheduled-sync", skippedUnpaid: blocked }));
  }
  hotelIds = entitledHotelIds;

  // A property that has connected but not paid yet is not synced, priced or
  // pushed to until a subscription lands; the onboarding import is the one
  // read it gets before that, through its own queue. The claim RPC is meant to
  // filter these out, but it only learned to after a migration, so it is
  // enforced here too rather than resting on deploy order.
  const { allowed: liveHotelIds, parked } = await splitByParked(supabase, "cloudbeds", hotelIds);
  if (parked.length > 0) {
    console.log(JSON.stringify({ fn: "cloudbeds-scheduled-sync", skippedParked: parked }));
  }
  hotelIds = liveHotelIds;

  const results: Array<{
    hotelId: string;
    sync: ReturnType<typeof publicSyncResult> | { ok: true; skipped: "import_running" };
    evaluate?: Awaited<ReturnType<typeof evaluateHotel>> | { error: string } | { skipped: true };
    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    push?: any;
    rooms?: Awaited<ReturnType<typeof recordRoomCount>> | null;
  }> = [];

  // Hotels mid-import skip only the PMS read; see hotelsImportingNow.
  const importing = await hotelsImportingNow(supabase, hotelIds);
  if (importing.size > 0) {
    console.log(JSON.stringify({ fn: "cloudbeds-scheduled-sync", syncSkippedImportRunning: [...importing] }));
  }

  // Each hotel runs inside the invocation's wall clock; see scheduled-loop.ts.
  const processHotel = async (hotelId: string, deadlineAt: number, invocationDeadline: number) => {
    const t0 = Date.now();
    // Mid-import: the worker is reading this property; only the read is skipped.
    const syncSkipped = importing.has(hotelId);
    const sync = syncSkipped
      ? { ok: true as const, skipped: "import_running" as const }
      : await runCloudbedsSyncForHotel(supabase, hotelId, { deadlineAt });
    const creds = !sync.ok
      ? null
      : "creds" in sync
        ? sync.creds
        : await resolveCloudbedsCredentials(supabase, hotelId);
    const tSync = Date.now();

    // The property's own rate, captured BEFORE the engine runs so a brand new
    // hotel has a base on day one instead of skipping every unbooked cell, and
    // so a booking taken at one of our own prices can never become the base.
    // Cells we have already pushed to are excluded inside; this only fills gaps.
    if (creds) {
      try {
        await ensureBaseRateCalendar(supabase, hotelId, createCloudbedsRateAdapter(creds), {
          horizonDays,
        });
      } catch {
        // Never fail a tick over the calendar; pricing falls back as before.
      }
    }

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
      if (creds) {
        try {
          const adapter = createCloudbedsRateAdapter(creds);
          push = await pushRatesForHotel(supabase, hotelId, adapter, {
            // Leaves the room count and the release their time.
            deadlineAt: invocationDeadline - 20_000,
          });
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
        syncTruncated: "windowFullyCovered" in sync ? !sync.windowFullyCovered : undefined,
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
    const roomVerdict = sync.ok && !syncSkipped ? await recordRoomCount(supabase, hotelId, new Date()) : null;

    results.push({ hotelId, sync: "skipped" in sync ? sync : publicSyncResult(sync), evaluate, push, rooms: roomVerdict });

    // Hand the claim back and say when this hotel next wants looking at. A
    // failure backs off exponentially inside release_pms_sync, so one hotel with
    // a revoked token stops costing a full-rate retry every tick forever.
    // Skipped for a single-hotel dispatch, which never took a lease.
    if (!bodyHotelId) {
      const { error: releaseErr } = await supabase.rpc("release_pms_sync", {
        p_hotel_id: hotelId,
        p_pms_type: "cloudbeds",
        p_ok: sync.ok,
        p_interval_seconds: syncIntervalSeconds,
      });
      if (releaseErr) {
        // Not fatal: the lease expires on its own and the next tick reclaims it.
        // Worth saying though — a run of these means the batch is churning.
        console.error(
          JSON.stringify({ fn: "cloudbeds-scheduled-sync", step: "release", hotelId, error: releaseErr.message }),
        );
      }
    }
  };

  const loop = await runScheduledHotels(
    hotelIds,
    invocationStartedAt,
    scheduledLoopConfigFromEnv(CLOUDBEDS_SYNC_BUDGET_MS),
    {
      now: Date.now,
      processHotel,
      // A claim nobody started: drop the lease and leave its due time and
      // failure count alone, so the next tick takes it straight away.
      handBack: async (hotelId) => {
        if (bodyHotelId) return;
        await supabase
          .from("pms_connections")
          .update({ sync_lease_until: null, sync_lease_owner: null })
          .eq("hotel_id", hotelId)
          .eq("pms_type", "cloudbeds")
          .eq("sync_lease_owner", workerId);
      },
      releaseFailed: async (hotelId) => {
        if (bodyHotelId) return;
        await supabase.rpc("release_pms_sync", {
          p_hotel_id: hotelId,
          p_pms_type: "cloudbeds",
          p_ok: false,
          p_interval_seconds: syncIntervalSeconds,
        });
      },
      log: (line) => console.log(JSON.stringify({ fn: "cloudbeds-scheduled-sync", ...line })),
    },
  );

  const failed = results.filter(
    (r) => r.sync.ok === false || (r.evaluate && "error" in r.evaluate),
  );

  return new Response(
    JSON.stringify({
      ok: failed.length === 0,
      hotels: hotelIds.length,
      // Claimed but not started this invocation for lack of time; the next tick takes them.
      handedBack: loop.handedBack,
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
