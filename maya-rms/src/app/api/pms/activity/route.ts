/**
 * GET /api/pms/activity — PMS connection health for the active hotel.
 *
 * Returns the pms_connections row (preferring status=connected), a health
 * classification over the last 24h of pms_request_log traffic, and the latest
 * 50 log entries (newest first). Retention is the nightly database sweep
 * (pms_request_log_sweep, 7 days) — it used to be pruned here per request,
 * which only ever ran for hotels somebody actually looked at.
 */

import { classifyPmsHealth } from "@/lib/pms/health";
import { getRegistry, type PmsType } from "@/lib/pms/registry";
import { hasHotelRank, requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const LOG_LIMIT = 50;
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

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

  // How this PMS authenticates, so the dashboard knows whether reconnecting is
  // one click out to the vendor or a credential the owner has to fetch. The
  // registry is server-only, and a second copy of this fact on the client would
  // eventually disagree with it.
  const registry = connection ? getRegistry(connection.pms_type as PmsType) : null;

  // Whether this caller could actually reconnect. The OAuth route enforces it
  // regardless, but enforcing without telling the client means offering a button
  // that answers with raw JSON — so the answer comes back here and the button
  // simply isn't drawn for someone who can't use it.
  const canManage = await hasHotelRank(ctx.supabase, hotelId, "general_manager");

  return NextResponse.json({
    connection,
    pms: registry
      ? { authKind: registry.authKind, displayName: registry.displayName, canManage }
      : null,
    health: classifyPmsHealth(totalRes.count ?? 0, failureRes.count ?? 0),
    log: logRes.data ?? [],
  });
}
