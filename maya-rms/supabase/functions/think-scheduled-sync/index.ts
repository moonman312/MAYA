/**
 * Scheduled Think sync + pricing evaluation.
 *
 * For every hotel with a `pms_type = 'think'` connection (or a single hotel
 * when `{ hotel_id }` is posted):
 *   1. Pull fresh reservations/room-types from Think (runThinkSyncForHotel)
 *   2. Refresh the property's own base rates         (ensureBaseRateCalendar)
 *   3. Run the pricing rules engine                  (evaluateHotel)
 *   4. Push changed prices, Live hotels only         (pushRatesForHotel)
 * Steps 2-4 share one hotel date and one horizon (runPricingTick).
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
import type { PmsRatePushAdapter } from "../_shared/pms/rate-push.ts";
import { type PricingTickResult, readOutcome, runPricingTick, type TickSkip } from "../_shared/pms/pricing-tick.ts";
import { pricingHorizonDays } from "../_shared/pms/pricing-window.ts";
import { resolveOAuthCredentials } from "../_shared/pms/oauth-credentials.ts";
import { splitByEntitlement } from "../_shared/billing/entitlement.ts";
import { hotelsImportingNow, splitByParked } from "../_shared/pms/parked.ts";
import {
  claimDispatchedHotelWaiting,
  OUT_OF_TIME_RETRY_SECONDS,
  runScheduledHotels,
  scheduledLoopConfigFromEnv,
} from "../_shared/pms/scheduled-loop.ts";
import { THINK_SYNC_BUDGET_MS } from "../_shared/think/constants.ts";
import { recordRoomCount } from "../_shared/billing/room-count.ts";

type PricingTick = PricingTickResult<Awaited<ReturnType<typeof evaluateHotel>>>;

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
  // Nights evaluated, refreshed and pushed per tick: 60 by default, the window
  // the support page promises. Env override: MAYA_EVAL_HORIZON_DAYS.
  const horizonDays = pricingHorizonDays();
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

  // A property that has connected but not paid yet is not synced, priced or
  // pushed to until a subscription lands; the onboarding import is the one
  // read it gets before that, through its own queue. The claim RPC is meant to
  // filter these out, but it only learned to after a migration, so it is
  // enforced here too rather than resting on deploy order.
  const { allowed: liveHotelIds, parked } = await splitByParked(supabase, "think", hotelIds);
  if (parked.length > 0) {
    console.log(JSON.stringify({ fn: "think-scheduled-sync", skippedParked: parked }));
  }
  hotelIds = liveHotelIds;

  // A single-hotel dispatch takes the same lease a cron claim does, so it never
  // runs a hotel that another invocation or a manual sync is already working.
  // While the hotel is busy it tries again for up to a minute from the start of
  // this invocation: the holder may be a manual sync that never prices, or a
  // run that read published_price before the save. Past that it steps aside
  // and the next due tick picks the change up.
  let dispatchLeased = false;
  if (bodyHotelId && hotelIds.length > 0) {
    const claim = await claimDispatchedHotelWaiting(
      supabase,
      "think",
      bodyHotelId,
      workerId,
      (line) => console.log(JSON.stringify({ fn: "think-scheduled-sync", ...line })),
      invocationStartedAt,
    );
    if (claim === "busy") {
      return new Response(
        JSON.stringify({ ok: true, hotels: 0, skipped: "sync_running", hotelId: bodyHotelId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    dispatchLeased = claim === "claimed";
  }
  // Whether this invocation holds the lease on the hotels it runs.
  const leased = !bodyHotelId || dispatchLeased;

  const results: Array<{
    hotelId: string;
    sync: Awaited<ReturnType<typeof runThinkSyncForHotel>> | { ok: true; skipped: "import_running" };
    calendar?: PricingTick["calendar"];
    evaluate?: PricingTick["evaluate"];
    rooms?: Awaited<ReturnType<typeof recordRoomCount>> | null;
  }> = [];

  // Hotels mid-import skip only the PMS read; see hotelsImportingNow.
  const importing = await hotelsImportingNow(supabase, hotelIds);
  if (importing.size > 0) {
    console.log(JSON.stringify({ fn: "think-scheduled-sync", syncSkippedImportRunning: [...importing] }));
  }

  // Each hotel runs inside the invocation's wall clock; see scheduled-loop.ts.
  const processHotel = async (hotelId: string, deadlineAt: number, invocationDeadline: number, evaluateBy: number) => {
    const t0 = Date.now();
    // Mid-import: the worker is reading this property; only the read is skipped.
    const syncSkipped = importing.has(hotelId);
    const sync = syncSkipped
      ? { ok: true as const, skipped: "import_running" as const }
      : await runThinkSyncForHotel(supabase, hotelId, { deadlineAt });

    // The sync result carries no credentials (unlike Cloudbeds'), so they are
    // resolved again: one Vault RPC, and the token the sync just refreshed is
    // the one that comes back. Needed whether or not pushing is on, because
    // the base rate refresh reads the property's own rates with them.
    let adapter: PmsRatePushAdapter | null = null;
    let noAdapter: TickSkip = { skipped: "no_credentials" };
    if (sync.ok) {
      try {
        const resolved = await resolveOAuthCredentials(supabase, hotelId, "think");
        if (!("error" in resolved) && resolved.propertyId) {
          const { data: connRow } = await supabase
            .from("pms_connections")
            .select("base_url")
            .eq("hotel_id", hotelId)
            .eq("pms_type", "think")
            .maybeSingle();
          const baseUrl = (
            (connRow?.base_url as string | null) || THINK_API_BASE_URL
          ).replace(/\/$/, "");
          adapter = createThinkRateAdapter(
            { accessToken: resolved.accessToken, baseUrl },
            resolved.propertyId,
          );
        }
      } catch (e) {
        noAdapter = { error: (e instanceof Error ? e.message : "credentials unavailable").slice(0, 300) };
      }
    }
    const tSync = Date.now();

    // The property's own rate is re-read BEFORE the engine runs, so a rate the
    // hotel changed in Think is what this tick prices on, and a booking taken
    // at one of our own prices can never become the base. Push no-ops unless
    // the hotel is in LIVE mode. A failed read prices and pushes nothing; a
    // truncated one pushes nothing.
    const tick = await runPricingTick(
      supabase,
      hotelId,
      {
        horizonDays,
        adapter,
        noAdapter,
        runEvaluate,
        pushEnabled: pushRatesEnabled,
        evaluateBy,
        // Leaves the room count and the release their time.
        pushDeadlineAt: invocationDeadline - 20_000,
        read: readOutcome(sync),
      },
      { evaluate: evaluateHotel },
    );
    const { calendar, evaluate, push, outOfTime } = tick;

    console.log(
      JSON.stringify({
        fn: "think-scheduled-sync",
        hotelId,
        syncOk: sync.ok,
        // A budget-truncated run is not a failed one, but sustained false here
        // means the property needs the incremental path more often than it is
        // getting it — worth a look before it needs a bigger budget.
        windowFullyCovered: "windowFullyCovered" in sync ? sync.windowFullyCovered : undefined,
        syncError: sync.ok ? undefined : sync.error,
        today: tick.today,
        calendar,
        pmsEditedPushedNights: tick.pmsEditedPushedNights,
        evaluate,
        push,
        syncMs: tSync - t0,
        calendarMs: tick.calendarMs,
        evalMs: tick.evalMs,
        pushMs: tick.pushMs,
        horizonDays,
      }),
    );

    // Re-measure what they actually run. room_types was just refreshed from the
    // PMS, so this is the freshest the number ever gets. Measuring here rather
    // than at onboarding is the point: properties grow, and the old one-off
    // reading meant a hotel that opened a wing paid its old price forever.
    const roomVerdict = sync.ok && !syncSkipped ? await recordRoomCount(supabase, hotelId, new Date()) : null;

    results.push({ hotelId, sync, calendar, evaluate, rooms: roomVerdict });

    // Hand the claim back and say when this hotel next wants looking at. A
    // failure backs off exponentially inside release_pms_sync, so one hotel with
    // a revoked token stops costing a full-rate retry every tick forever.
    // Skipped for a single-hotel dispatch that runs without a lease.
    if (leased) {
      const { error: releaseErr } = await supabase.rpc("release_pms_sync", {
        p_hotel_id: hotelId,
        p_pms_type: "think",
        p_ok: sync.ok,
        p_interval_seconds: outOfTime ? OUT_OF_TIME_RETRY_SECONDS : syncIntervalSeconds,
      });
      if (releaseErr) {
        // Not fatal: the lease expires on its own and the next tick reclaims it.
        // Worth saying though — a run of these means the batch is churning.
        console.error(
          JSON.stringify({ fn: "think-scheduled-sync", step: "release", hotelId, error: releaseErr.message }),
        );
      }
    }
  };

  const loop = await runScheduledHotels(
    hotelIds,
    invocationStartedAt,
    scheduledLoopConfigFromEnv(THINK_SYNC_BUDGET_MS),
    {
      now: Date.now,
      processHotel,
      // A claim nobody started: drop the lease and leave its due time and
      // failure count alone, so the next tick takes it straight away.
      handBack: async (hotelId) => {
        if (!leased) return;
        await supabase
          .from("pms_connections")
          .update({ sync_lease_until: null, sync_lease_owner: null })
          .eq("hotel_id", hotelId)
          .eq("pms_type", "think")
          .eq("sync_lease_owner", workerId);
      },
      releaseFailed: async (hotelId) => {
        if (!leased) return;
        await supabase.rpc("release_pms_sync", {
          p_hotel_id: hotelId,
          p_pms_type: "think",
          p_ok: false,
          p_interval_seconds: syncIntervalSeconds,
        });
      },
      log: (line) => console.log(JSON.stringify({ fn: "think-scheduled-sync", ...line })),
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
