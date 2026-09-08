/**
 * POST /api/admin/metrics-snapshot — write today's hotel_metrics_daily rows.
 *
 * Driven nightly by pg_cron (supabase/cron/business-metrics-snapshot.sql.example)
 * with the same shared secret as the billing crons. The analytics page also
 * writes today's rows lazily when it loads, so a deployment whose cron was
 * never scheduled still accumulates history on every visit — the cron's job is
 * the quiet days nobody looked at.
 */

import { snapshotHotelMetrics } from "@/lib/admin/analytics";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.BILLING_CRON_SECRET;
  if (!secret || request.headers.get("x-billing-cron-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Admin client not configured" }, { status: 503 });
  }
  try {
    const day = new Date().toISOString().slice(0, 10);
    const rows = await snapshotHotelMetrics(createAdminClient(), day);
    console.log(JSON.stringify({ fn: "metricsSnapshot", day, rows }));
    return NextResponse.json({ ok: true, day, rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ fn: "metricsSnapshot", error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
