import { mewsFetchReservationsRange, MewsHttpError } from "@/lib/mews/client";
import { parseMewsApiResponse } from "@/lib/mews/etl";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { resolveMewsCredentials } from "@/lib/mews/resolve-credentials";
import type { MewsCredentialsInput } from "@/lib/mews/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = {
  mews?: MewsCredentialsInput;
  /** Default aligned with Python `MAYA_FETCH_START` / `MAYA_FETCH_END` intent; capped for UI safety. */
  daysBack?: number;
  daysForward?: number;
};

/** Match `shared/legacy-python/config.py` when env is unset. */
const DEFAULT_BACK = 30;
const DEFAULT_FORWARD = 396;

const MAX_BACK = 365;
const MAX_FORWARD = 396;

function utcRange(daysBack: number, daysForward: number): { start: string; end: string } {
  const now = Date.now();
  const start = new Date(now - daysBack * 86400000);
  const end = new Date(now + daysForward * 86400000);
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { start: fmt(start), end: fmt(end) };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * `mewsFetchReservationsRange` concatenates multiple `reservations/getAll` windows.
 * The same room category (or reservation) can appear in more than one chunk, so we
 * collapse to one row per natural key before upsert — not because the PMS sends
 * invalid duplicate keys, but because our merge produces duplicates.
 */
function dedupeByKey<T>(rows: T[], keyFn: (row: T) => string): { rows: T[]; merged: number } {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(keyFn(row), row);
  }
  return { rows: [...map.values()], merged: rows.length - map.size };
}

function resolveFetchWindow(body: Body): { start: string; end: string } {
  const absStart = process.env.MAYA_FETCH_START?.trim();
  const absEnd = process.env.MAYA_FETCH_END?.trim();
  if (absStart && absEnd) {
    return { start: absStart, end: absEnd };
  }
  const back = Math.min(
    MAX_BACK,
    Math.max(1, body.daysBack ?? readPositiveIntEnv("MAYA_SYNC_DAYS_BACK", DEFAULT_BACK)),
  );
  const forward = Math.min(
    MAX_FORWARD,
    Math.max(1, body.daysForward ?? readPositiveIntEnv("MAYA_SYNC_DAYS_FORWARD", DEFAULT_FORWARD)),
  );
  return utcRange(back, forward);
}

export async function POST(req: Request) {
  try {
    const ctx = await requireSupabaseHotel(await cookies());
    if (!ctx.ok) return ctx.response;

    let body: Body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text) as Body;
    } catch {
      body = {};
    }

    const resolved = await resolveMewsCredentials(ctx.supabase, ctx.hotelId, body.mews ?? null);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }

    const { start, end } = resolveFetchWindow(body);
    const { data: raw, windows } = await mewsFetchReservationsRange(resolved.creds, start, end);
    const parsed = parseMewsApiResponse(raw as Record<string, unknown>);

    let roomTypesUpserted = 0;
    let reservationRowsUpserted = 0;
    let duplicateRoomTypeRowsMerged = 0;

    if (parsed.roomTypes.length > 0) {
      const { rows: rtRows, merged: rtMerged } = dedupeByKey(
        parsed.roomTypes.map((rt) => ({
          hotel_id: ctx.hotelId,
          external_room_type_id: rt.external_room_type_id,
          name: rt.name,
          display_name: rt.display_name,
          is_active: true,
        })),
        (r) => `${r.hotel_id}:${r.external_room_type_id}`,
      );
      duplicateRoomTypeRowsMerged = rtMerged;
      roomTypesUpserted = rtRows.length;
      const { error: rtErr } = await ctx.supabase
        .from("room_types")
        .upsert(rtRows, { onConflict: "hotel_id,external_room_type_id" });
      if (rtErr) {
        return NextResponse.json({ error: rtErr.message }, { status: 500 });
      }
    }

    const { data: idRows, error: idErr } = await ctx.supabase
      .from("room_types")
      .select("id, external_room_type_id")
      .eq("hotel_id", ctx.hotelId);

    if (idErr) {
      return NextResponse.json({ error: idErr.message }, { status: 500 });
    }

    const idByExternal: Record<string, string> = {};
    for (const row of idRows ?? []) {
      if (row.external_room_type_id && row.id) {
        idByExternal[String(row.external_room_type_id)] = String(row.id);
      }
    }

    if (parsed.reservations.length > 0) {
      const resRows = parsed.reservations.map((r) => ({
        hotel_id: ctx.hotelId,
        external_reservation_id: r.external_reservation_id,
        room_type_id: r.external_room_type_id ? idByExternal[r.external_room_type_id] ?? null : null,
        stay_date: r.stay_date,
        booking_date: r.booking_date,
        booking_window_days: r.booking_window_days,
        current_rate: r.current_rate,
        base_rate: r.base_rate,
        raw_payload: r.raw_payload,
      }));
      reservationRowsUpserted = resRows.length;

      const { error: resErr } = await ctx.supabase
        .from("reservations")
        .upsert(resRows, { onConflict: "hotel_id,external_reservation_id,stay_date" });
      if (resErr) {
        return NextResponse.json({ error: resErr.message }, { status: 500 });
      }
    }

    if (resolved.connectionId) {
      await ctx.supabase
        .from("pms_connections")
        .update({
          status: "connected",
          last_sync_at: new Date().toISOString(),
          last_tested_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", resolved.connectionId);
    }

    return NextResponse.json({
      ok: true,
      fetchWindowUtc: { start, end },
      apiWindows: windows,
      roomTypesUpserted,
      reservationRowsUpserted,
      ingest: {
        duplicateRoomTypeRowsMerged,
        ...parsed.stats,
      },
      credentialSource: resolved.source,
    });
  } catch (error) {
    if (error instanceof MewsHttpError) {
      const status = error.status >= 500 ? 502 : 400;
      return NextResponse.json({ ok: false, error: error.message, mewsStatus: error.status }, { status });
    }
    const message = error instanceof Error ? error.message : "Mews sync failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
