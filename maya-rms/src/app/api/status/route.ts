/**
 * Public service status, computed from what MAYA already records.
 *
 * There was no way to answer "is it up?" without a database console — no
 * status page, no alerting, no external error tracker. This is the cheapest
 * honest version: the same numbers the product already collects, aggregated
 * across every property and served without authentication.
 *
 * Deliberately says nothing about individual hotels. It reports whether MAYA
 * is doing its job, never whose data it is doing it to, so it can be linked
 * publicly during a certification call or a support conversation.
 *
 * Whether pricing is running is the database watchdog's reckoning
 * (pricing_watchdog, 99_supabase_migration_pricing_watchdog_v1.sql, asked
 * without posting): one row per live or simulating, entitled, non-test hotel
 * with a property system. A live hotel with no run for 30 minutes is down; a
 * late daily pass, or a simulating hotel behind, is degraded. Test hotels
 * never count, so a sandbox ticking away cannot keep this green while a real
 * hotel stalls, and their traffic is left out of the integration counts too.
 * "down" answers 503, so an outside monitor can key on the status code.
 */
import { engineFromWatchdog, type Engine, type WatchdogRow } from "@/lib/pms/engine-status";
import { classifyPmsHealth } from "@/lib/pms/health";
import { createAdminClient } from "@/utils/supabase/admin";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Every value of the pms_type enum. */
const PMS_TYPES = ["cloudbeds", "mews", "think", "opera", "other"] as const;
/** Before the watchdog migration: the scheduled tick runs every 5 minutes; three misses is a real stall, not a blip. */
const ENGINE_STALL_MS = 15 * 60 * 1000;

function isMissingFunction(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(String(error.message ?? ""));
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ status: "unknown", reason: "not_configured" }, { status: 503 });
  }

  const nowMs = Date.now();
  const since = new Date(nowMs - WINDOW_MS).toISOString();
  const admin = createAdminClient();

  try {
    // Test hotels (the sandbox, fixtures) say nothing about the service.
    const { data: testHotels, error: testErr } = await admin.from("hotels").select("id").eq("is_test", true);
    if (testErr) throw new Error(testErr.message);
    const testIds = (testHotels ?? []).map((h) => String((h as { id: unknown }).id));
    const withoutTests = <Q extends { not: (col: string, op: string, value: string) => Q }>(q: Q): Q =>
      testIds.length > 0 ? q.not("hotel_id", "in", `(${testIds.join(",")})`) : q;

    // PMS traffic in the window, by vendor. Exact counts, not rows: a day of
    // request log across every property is far past PostgREST's 1,000-row
    // cap, and counting the rows that came back reported a fraction of it.
    const byPms = new Map<string, { total: number; failures: number }>();
    await Promise.all(
      PMS_TYPES.map(async (pms) => {
        const [{ count: total, error: totalErr }, { count: failures, error: failErr }] = await Promise.all([
          withoutTests(admin.from("pms_request_log").select("id", { count: "exact", head: true }).eq("pms_type", pms).gte("created_at", since)),
          withoutTests(
            admin.from("pms_request_log").select("id", { count: "exact", head: true }).eq("pms_type", pms).eq("ok", false).gte("created_at", since),
          ),
        ]);
        if (totalErr || failErr) throw new Error((totalErr ?? failErr)!.message);
        if ((total ?? 0) > 0) byPms.set(pms, { total: total ?? 0, failures: failures ?? 0 });
      }),
    );

    const integrations = [...byPms.entries()]
      .map(([pms, agg]) => {
        const h = classifyPmsHealth(agg.total, agg.failures);
        return {
          pms,
          state: h.state,
          successRate: h.successRate != null ? Math.round(h.successRate * 1000) / 10 : null,
          requests: h.total,
        };
      })
      .sort((a, b) => a.pms.localeCompare(b.pms));

    // Is the pricing engine actually running, for the hotels that count?
    const { data: watched, error: watchErr } = await admin.rpc("pricing_watchdog", { p_post: false, p_min_severity: "critical" });
    let engine: Engine;
    if (!watchErr) {
      engine = engineFromWatchdog((watched ?? []) as WatchdogRow[], nowMs);
    } else if (isMissingFunction(watchErr)) {
      // Before the watchdog migration: the newest run of any hotel, as
      // before. A tick writes a heartbeat row whether or not anything
      // changed, so silence here is the engine being down.
      const { data: lastRun, error: runErr } = await admin
        .from("evaluation_run_log")
        .select("evaluated_at")
        .order("evaluated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (runErr) throw new Error(runErr.message);
      const lastRunAt = lastRun?.evaluated_at ? new Date(String(lastRun.evaluated_at)) : null;
      const engineAgeMs = lastRunAt ? nowMs - lastRunAt.getTime() : null;
      engine =
        engineAgeMs == null
          ? { state: "unknown", lastRunAt: null, minutesAgo: null, note: "watchdog_migration_missing" }
          : {
              state: engineAgeMs > ENGINE_STALL_MS ? "down" : "healthy",
              lastRunAt: lastRunAt!.toISOString(),
              minutesAgo: Math.round(engineAgeMs / 60000),
              note: "watchdog_migration_missing",
            };
    } else {
      throw new Error(watchErr.message);
    }

    // Worst component wins: a green overall badge beside a dead engine is the
    // kind of self-contradicting status page nobody trusts twice.
    const states = [engine.state, ...integrations.map((i) => i.state)];
    const status = states.includes("down")
      ? "down"
      : states.includes("degraded")
        ? "degraded"
        : states.every((s) => s === "unknown")
          ? "unknown"
          : "operational";

    return NextResponse.json(
      { status, checkedAt: new Date(nowMs).toISOString(), windowHours: 24, engine, integrations },
      { status: status === "down" ? 503 : 200, headers: { "Cache-Control": "public, max-age=30" } },
    );
  } catch (e) {
    // A status endpoint that 500s tells you less than one that admits it
    // broke; 503 so a monitor still counts it as not serving.
    return NextResponse.json(
      { status: "unknown", reason: e instanceof Error ? e.message : "status check failed" },
      { status: 503 },
    );
  }
}
