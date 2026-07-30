/**
 * Onboarding import worker.
 *
 * Claims the next runnable import job (claim_import_job RPC — queued, or
 * running with an expired lease) and drives it forward for a bounded time
 * budget, checkpointing continuously. If work remains it hands the lease back
 * and re-invokes itself, so the chained call can claim the same job on the
 * spot; pg_cron (every minute) is the crash-recovery driver.
 *
 * Auth: `x-onboarding-cron-secret` vs ONBOARDING_CRON_SECRET
 * (verify_jwt=false for this function — see supabase/config.toml).
 */

import { createClient } from "npm:@supabase/supabase-js@2.99.3";
import { createOnboardingAdapter } from "../_shared/pms/onboarding-adapter.ts";
import { runCloudbedsSyncForHotel } from "../_shared/cloudbeds/sync-hotel.ts";
import { analyzeImport } from "../_shared/onboarding/analysis.ts";
import {
  LEASE_SECONDS,
  processJob,
  type ImportJobRow,
  type WorkerDeps,
} from "../_shared/onboarding/worker-core.ts";

function getEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v !== "" ? v : undefined;
}

const deps: WorkerDeps = {
  createAdapter: (supabase, hotelId, pmsType) =>
    createOnboardingAdapter(supabase, hotelId, pmsType),
  runCurrentSync: async (supabase, hotelId, pmsType) => {
    if (pmsType !== "cloudbeds") {
      return { ok: false, error: `No current-window sync for '${pmsType}'` };
    }
    const res = await runCloudbedsSyncForHotel(supabase, hotelId);
    // Report the window it actually covered — its depth is env-configurable
    // (MAYA_SYNC_DAYS_BACK), so the historical phase must not assume one.
    return res.ok
      ? { ok: true, coveredFrom: res.fetchWindow.checkInFrom }
      : { ok: false, error: res.error };
  },
  analyze: analyzeImport,
  now: () => Date.now(),
  todayYmd: () => new Date().toISOString().slice(0, 10),
};

Deno.serve(async (req) => {
  const cronSecret = getEnv("ONBOARDING_CRON_SECRET");
  if (cronSecret) {
    const header = req.headers.get("x-onboarding-cron-secret");
    if (header !== cronSecret) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid secret" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
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

  const budgetMs = Math.max(10_000, Number(getEnv("ONBOARDING_WORKER_BUDGET_MS") ?? "90000") || 90_000);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: claimed, error: claimErr } = await supabase.rpc("claim_import_job", {
    p_lease_seconds: LEASE_SECONDS,
  });
  if (claimErr) {
    return new Response(JSON.stringify({ ok: false, error: claimErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const job = (Array.isArray(claimed) ? claimed[0] : claimed) as ImportJobRow | undefined;
  if (!job) {
    return new Response(JSON.stringify({ ok: true, claimed: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();
  const outcome = await processJob(supabase, job, deps, budgetMs);

  console.log(
    JSON.stringify({
      fn: "onboarding-import-worker",
      jobId: job.id,
      hotelId: job.hotel_id,
      outcome,
      phase: job.phase,
      windowIndex: job.window_index,
      rowsUpserted: job.rows_upserted,
      ms: Date.now() - t0,
    }),
  );

  // Work remains — chain the next invocation (cron is the fallback driver).
  if (outcome === "budget_exhausted") {
    const chain = fetch(`${supabaseUrl}/functions/v1/onboarding-import-worker`, {
      method: "POST",
      headers: cronSecret ? { "x-onboarding-cron-secret": cronSecret } : {},
    }).catch(() => {});
    const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
      .EdgeRuntime;
    if (runtime?.waitUntil) {
      runtime.waitUntil(chain);
    }
  }

  return new Response(
    JSON.stringify({ ok: outcome !== "failed", claimed: true, jobId: job.id, outcome }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
