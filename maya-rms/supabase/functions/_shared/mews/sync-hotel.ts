import type { SupabaseClient } from "@supabase/supabase-js";
import { mewsFetchReservationsRange, MewsHttpError } from "./client.ts";
import { parseMewsApiResponse } from "./etl.ts";
import { mwsEnv } from "./env.ts";
import { resolveMewsCredentials } from "./resolve-credentials.ts";
import type { MewsCredentialsInput } from "./types.ts";

const RECONCILE_IN_CHUNK = 200;

function groupStayDatesByReservation(
  rows: { external_reservation_id: string; stay_date: string }[],
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!m.has(r.external_reservation_id)) {
      m.set(r.external_reservation_id, new Set());
    }
    m.get(r.external_reservation_id)!.add(r.stay_date);
  }
  return m;
}

async function deleteCanceledReservationRows(
  supabase: SupabaseClient,
  hotelId: string,
  canceledIds: string[],
): Promise<{ error: { message: string } | null }> {
  for (let i = 0; i < canceledIds.length; i += RECONCILE_IN_CHUNK) {
    const chunk = canceledIds.slice(i, i + RECONCILE_IN_CHUNK);
    const { error } = await supabase
      .from("reservations")
      .delete()
      .eq("hotel_id", hotelId)
      .in("external_reservation_id", chunk);
    if (error) return { error };
  }
  return { error: null };
}

async function deleteStaleStayNightsForActiveReservations(
  supabase: SupabaseClient,
  hotelId: string,
  activeByExternalId: Map<string, Set<string>>,
): Promise<{ error: { message: string } | null }> {
  for (const [extId, nights] of activeByExternalId) {
    if (nights.size === 0) continue;
    const list = [...nights].sort();
    const { error } = await supabase
      .from("reservations")
      .delete()
      .eq("hotel_id", hotelId)
      .eq("external_reservation_id", extId)
      .not("stay_date", "in", `(${list.join(",")})`);
    if (error) return { error };
  }
  return { error: null };
}

export type MewsSyncHotelOptions = {
  mews?: MewsCredentialsInput | null;
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
  const raw = mwsEnv(name)?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function dedupeByKey<T>(rows: T[], keyFn: (row: T) => string): { rows: T[]; merged: number } {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(keyFn(row), row);
  }
  return { rows: [...map.values()], merged: rows.length - map.size };
}

function resolveFetchWindow(options?: MewsSyncHotelOptions): { start: string; end: string } {
  const absStart = mwsEnv("MAYA_FETCH_START")?.trim();
  const absEnd = mwsEnv("MAYA_FETCH_END")?.trim();
  if (absStart && absEnd) {
    return { start: absStart, end: absEnd };
  }
  const back = Math.min(
    MAX_BACK,
    Math.max(1, options?.daysBack ?? readPositiveIntEnv("MAYA_SYNC_DAYS_BACK", DEFAULT_BACK)),
  );
  const forward = Math.min(
    MAX_FORWARD,
    Math.max(
      1,
      options?.daysForward ?? readPositiveIntEnv("MAYA_SYNC_DAYS_FORWARD", DEFAULT_FORWARD),
    ),
  );
  return utcRange(back, forward);
}

export type MewsSyncHotelSuccess = {
  ok: true;
  fetchWindowUtc: { start: string; end: string };
  apiWindows: number;
  roomTypesUpserted: number;
  reservationRowsUpserted: number;
  ingest: {
    duplicateRoomTypeRowsMerged: number;
    canceledReservationCount: number;
    skippedMissingReservationId: number;
    skippedNoStayNights: number;
    duplicateStayNightKeysMerged: number;
    rowsWithMissingRate: number;
    skippedCanceled: number;
  };
  credentialSource: string;
};

export type MewsSyncHotelFailure = {
  ok: false;
  error: string;
  mewsStatus?: number;
  retryAfterMs?: number;
};

/**
 * Full Mews → Supabase sync for one hotel (service-role or user-scoped Supabase client).
 */
export async function runMewsSyncForHotel(
  supabase: SupabaseClient,
  hotelId: string,
  options?: MewsSyncHotelOptions,
): Promise<MewsSyncHotelSuccess | MewsSyncHotelFailure> {
  try {
    const resolved = await resolveMewsCredentials(
      supabase,
      hotelId,
      options?.mews ?? null,
    );
    if ("error" in resolved) {
      return { ok: false, error: resolved.error };
    }

    const { data: hotelRow } = await supabase
      .from("hotels")
      .select("total_rooms_per_type")
      .eq("id", hotelId)
      .maybeSingle();

    const defaultRoomsPerCategory = hotelRow?.total_rooms_per_type ?? 100;

    const { start, end } = resolveFetchWindow(options);
    const { data: raw, windows } = await mewsFetchReservationsRange(resolved.creds, start, end);
    const parsed = parseMewsApiResponse(raw as Record<string, unknown>, {
      defaultRoomsPerCategory,
    });

    let roomTypesUpserted = 0;
    let reservationRowsUpserted = 0;
    let duplicateRoomTypeRowsMerged = 0;

    if (parsed.roomTypes.length > 0) {
      const { rows: rtRows, merged: rtMerged } = dedupeByKey(
        parsed.roomTypes.map((rt) => ({
          hotel_id: hotelId,
          external_room_type_id: rt.external_room_type_id,
          name: rt.name,
          display_name: rt.display_name,
          is_active: true,
          total_rooms: rt.total_rooms,
        })),
        (r) => `${r.hotel_id}:${r.external_room_type_id}`,
      );
      duplicateRoomTypeRowsMerged = rtMerged;
      roomTypesUpserted = rtRows.length;
      const { error: rtErr } = await supabase
        .from("room_types")
        .upsert(rtRows, { onConflict: "hotel_id,external_room_type_id" });
      if (rtErr) {
        return { ok: false, error: rtErr.message };
      }
    }

    const { data: idRows, error: idErr } = await supabase
      .from("room_types")
      .select("id, external_room_type_id")
      .eq("hotel_id", hotelId);

    if (idErr) {
      return { ok: false, error: idErr.message };
    }

    const idByExternal: Record<string, string> = {};
    for (const row of idRows ?? []) {
      if (row.external_room_type_id && row.id) {
        idByExternal[String(row.external_room_type_id)] = String(row.id);
      }
    }

    if (parsed.reservations.length > 0) {
      const resRows = parsed.reservations.map((r) => ({
        hotel_id: hotelId,
        external_reservation_id: r.external_reservation_id,
        room_type_id: r.external_room_type_id ? idByExternal[r.external_room_type_id] ?? null : null,
        stay_date: r.stay_date,
        booking_date: r.booking_date,
        booking_window_days: r.booking_window_days,
        current_rate: r.current_rate,
        raw_payload: r.raw_payload,
      }));
      reservationRowsUpserted = resRows.length;

      const { error: resErr } = await supabase
        .from("reservations")
        .upsert(resRows, { onConflict: "hotel_id,external_reservation_id,stay_date" });
      if (resErr) {
        return { ok: false, error: resErr.message };
      }

      const canceledDel = await deleteCanceledReservationRows(
        supabase,
        hotelId,
        parsed.canceledExternalIds,
      );
      if (canceledDel.error) {
        return { ok: false, error: canceledDel.error.message };
      }

      const activeNights = groupStayDatesByReservation(parsed.reservations);
      const staleDel = await deleteStaleStayNightsForActiveReservations(
        supabase,
        hotelId,
        activeNights,
      );
      if (staleDel.error) {
        return { ok: false, error: staleDel.error.message };
      }
    } else if (parsed.canceledExternalIds.length > 0) {
      const canceledDel = await deleteCanceledReservationRows(
        supabase,
        hotelId,
        parsed.canceledExternalIds,
      );
      if (canceledDel.error) {
        return { ok: false, error: canceledDel.error.message };
      }
    }

    if (resolved.connectionId) {
      const { error: pcErr } = await supabase
        .from("pms_connections")
        .update({
          status: "connected",
          last_sync_at: new Date().toISOString(),
          last_tested_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", resolved.connectionId);
      if (pcErr) {
        console.error("pms_connections status update failed:", pcErr.message);
      }
    }

    return {
      ok: true,
      fetchWindowUtc: { start, end },
      apiWindows: windows,
      roomTypesUpserted,
      reservationRowsUpserted,
      ingest: {
        duplicateRoomTypeRowsMerged,
        canceledReservationCount: parsed.canceledExternalIds.length,
        ...parsed.stats,
      },
      credentialSource: resolved.source,
    };
  } catch (error) {
    if (error instanceof MewsHttpError) {
      return {
        ok: false,
        error: error.message,
        mewsStatus: error.status,
        ...(error.retryAfterMs != null ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    const message = error instanceof Error ? error.message : "Mews sync failed.";
    return { ok: false, error: message };
  }
}
