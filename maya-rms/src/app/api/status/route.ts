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
 */
import { classifyPmsHealth } from "@/lib/pms/health";
import { createAdminClient } from "@/utils/supabase/admin";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** The scheduled tick runs every 5 minutes; three misses is a real stall, not a blip. */
const ENGINE_STALL_MS = 15 * 60 * 1000;

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ status: "unknown", reason: "not_configured" }, { status: 503 });
  }

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const admin = createAdminClient();

  try {
    // PMS traffic in the window, by vendor.
    const { data: reqs } = await admin
      .from("pms_request_log")
      .select("pms_type, ok")
      .gte("created_at", since);

    const byPms = new Map<string, { total: number; failures: number }>();
    for (const r of reqs ?? []) {
      const key = String(r.pms_type ?? "unknown");
      const agg = byPms.get(key) ?? { total: 0, failures: 0 };
      agg.total += 1;
      if (r.ok === false) agg.failures += 1;
      byPms.set(key, agg);
    }

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

    // Is the pricing engine actually running? A tick writes a heartbeat row
    // whether or not anything changed, so silence here is the engine being
    // down — which no amount of healthy PMS traffic would reveal.
    const { data: lastRun } = await admin
      .from("evaluation_run_log")
      .select("evaluated_at")
      .order("evaluated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastRunAt = lastRun?.evaluated_at ? new Date(String(lastRun.evaluated_at)) : null;
    const engineAgeMs = lastRunAt ? Date.now() - lastRunAt.getTime() : null;
    const engine =
      engineAgeMs == null
        ? { state: "unknown" as const, lastRunAt: null, minutesAgo: null }
        : {
            state: engineAgeMs > ENGINE_STALL_MS ? ("down" as const) : ("healthy" as const),
            lastRunAt: lastRunAt!.toISOString(),
            minutesAgo: Math.round(engineAgeMs / 60000),
          };

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
      { status, checkedAt: new Date().toISOString(), windowHours: 24, engine, integrations },
      { headers: { "Cache-Control": "public, max-age=30" } },
    );
  } catch (e) {
    // A status endpoint that 500s tells you less than one that admits it broke.
    return NextResponse.json(
      { status: "unknown", reason: e instanceof Error ? e.message : "status check failed" },
      { status: 200 },
    );
  }
}
