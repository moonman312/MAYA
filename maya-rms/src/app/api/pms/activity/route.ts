/**
 * GET /api/pms/activity — PMS connection health for the active hotel.
 *
 * Returns the pms_connections row (preferring status=connected), a health
 * classification over the last 24h of pms_request_log traffic, and the latest
 * 50 log entries (newest first). Also prunes log rows older than 7 days for
 * this hotel as fire-and-forget housekeeping.
 */

import { classifyPmsHealth } from "@/lib/pms/health";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const LOG_LIMIT = 50;
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function pruneOldRows(hotelId: string): void {
  // Authenticated users can only read pms_request_log (writes are revoked),
  // so housekeeping needs the service-role client. Safe here: access to the
  // hotel was just verified and the delete is scoped to it.
  if (!isAdminConfigured()) return;
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  void createAdminClient()
    .from("pms_request_log")
    .delete()
    .eq("hotel_id", hotelId)
    .lt("created_at", cutoff)
    .then(
      ({ error }) => {
        if (error) console.error("pms_request_log prune failed:", error.message);
      },
      (e: unknown) => {
        console.error(
          "pms_request_log prune failed:",
          e instanceof Error ? e.message : String(e),
        );
      },
    );
}

export async function GET() {
  const ctx = await requireSupabaseHotel(await cookies());
  if (!ctx.ok) return ctx.response;
  const { supabase, hotelId } = ctx;

  const since = new Date(Date.now() - HEALTH_WINDOW_MS).toISOString();

  const [connRes, logRes, totalRes, failureRes] = await Promise.all([
    supabase
      .from("pms_connections")
      .select("pms_type, status, last_sync_at, last_tested_at")
      .eq("hotel_id", hotelId)
      .order("created_at", { ascending: true }),
    supabase
      .from("pms_request_log")
      .select("id, created_at, http_method, endpoint, status_code, ok, duration_ms, message")
      .eq("hotel_id", hotelId)
      .order("created_at", { ascending: false })
      .limit(LOG_LIMIT),
    supabase
      .from("pms_request_log")
      .select("id", { count: "exact", head: true })
      .eq("hotel_id", hotelId)
      .gte("created_at", since),
    supabase
      .from("pms_request_log")
      .select("id", { count: "exact", head: true })
      .eq("hotel_id", hotelId)
      .eq("ok", false)
      .gte("created_at", since),
  ]);

  const firstError =
    connRes.error ?? logRes.error ?? totalRes.error ?? failureRes.error;
  if (firstError) {
    return NextResponse.json({ error: firstError.message }, { status: 500 });
  }

  const connections = connRes.data ?? [];
  const connection =
    connections.find((c) => c.status === "connected") ?? connections[0] ?? null;

  pruneOldRows(hotelId);

  return NextResponse.json({
    connection,
    health: classifyPmsHealth(totalRes.count ?? 0, failureRes.count ?? 0),
    log: logRes.data ?? [],
  });
}
