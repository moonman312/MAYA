/**
 * Full Cloudbeds → Supabase sync for one hotel. Mirrors runMewsSyncForHotel:
 * writes into the same room_types / reservations tables, reconciles cancellations
 * and stale stay-nights, and stamps pms_connections status/last_sync_at.
 *
 * Credentials come from the OAuth secret in Vault (auto-refreshed). ⚠ The
 * Cloudbeds API calls it wraps still need live verification (see client/etl).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cloudbedsDiscoverPropertyId,
  cloudbedsGetReservationDetail,
  cloudbedsGetReservationsRange,
  cloudbedsGetRoomTypes,
  CloudbedsHttpError,
} from "./client.ts";
import { defaultCloudbedsBaseUrl, CLOUDBEDS_ACTIVE_STATUSES, CLOUDBEDS_FETCH_RATE_DETAIL } from "./constants.ts";
import {
  parseCloudbedsReservations,
  parseCloudbedsRoomTypes,
  parseNightlyRatesFromDetail,
} from "./etl.ts";
import type { CloudbedsResolvedCredentials } from "./types.ts";
import { mwsEnv } from "../mews/env.ts";
import { persistPropertyId, resolveOAuthCredentials } from "../pms/oauth-credentials.ts";

const RECONCILE_IN_CHUNK = 200;
const DEFAULT_BACK = 30;
const DEFAULT_FORWARD = 396;
const MAX_BACK = 365;
const MAX_FORWARD = 730;

export type CloudbedsSyncOptions = {
  daysBack?: number;
  daysForward?: number;
};

export type CloudbedsSyncSuccess = {
  ok: true;
  fetchWindow: { checkInFrom: string; checkInTo: string };
  apiPages: number;
  roomTypesUpserted: number;
  reservationRowsUpserted: number;
  ingest: {
    canceledReservationCount: number;
    skippedMissingReservationId: number;
    skippedNoStayNights: number;
    duplicateStayNightKeysMerged: number;
    rowsWithMissingRate: number;
    skippedCanceled: number;
    tokenRefreshed: boolean;
  };
};

export type CloudbedsSyncFailure = {
  ok: false;
  error: string;
  cloudbedsStatus?: number;
  retryAfterMs?: number;
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = mwsEnv(name)?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolveWindow(options?: CloudbedsSyncOptions): { checkInFrom: string; checkInTo: string } {
  const back = Math.min(MAX_BACK, Math.max(1, options?.daysBack ?? readPositiveIntEnv("MAYA_SYNC_DAYS_BACK", DEFAULT_BACK)));
  const forward = Math.min(MAX_FORWARD, Math.max(1, options?.daysForward ?? readPositiveIntEnv("MAYA_SYNC_DAYS_FORWARD", DEFAULT_FORWARD)));
  const now = Date.now();
  return {
    checkInFrom: ymd(new Date(now - back * 86_400_000)),
    checkInTo: ymd(new Date(now + forward * 86_400_000)),
  };
}

function dedupeByKey<T>(rows: T[], keyFn: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(keyFn(r), r);
  return [...m.values()];
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

async function deleteStaleStayNights(
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

export async function runCloudbedsSyncForHotel(
  supabase: SupabaseClient,
  hotelId: string,
  options?: CloudbedsSyncOptions,
): Promise<CloudbedsSyncSuccess | CloudbedsSyncFailure> {
  try {
    // 1. Credentials (auto-refresh if near expiry).
    const resolved = await resolveOAuthCredentials(supabase, hotelId, "cloudbeds");
    if ("error" in resolved) return { ok: false, error: resolved.error };

    // 2. Base URL (pms_connections.base_url wins over env default).
    const { data: connRow } = await supabase
      .from("pms_connections")
      .select("id, base_url")
      .eq("hotel_id", hotelId)
      .eq("pms_type", "cloudbeds")
      .maybeSingle();
    const baseUrl = (connRow?.base_url || defaultCloudbedsBaseUrl()).replace(/\/$/, "");

    // 3. Property id (discover + persist if not stored on the secret).
    let propertyId = resolved.propertyId;
    if (!propertyId) {
      propertyId = await cloudbedsDiscoverPropertyId({
        accessToken: resolved.accessToken,
        tokenType: resolved.tokenType,
        baseUrl,
      });
      if (propertyId) await persistPropertyId(supabase, hotelId, "cloudbeds", propertyId);
    }
    if (!propertyId) {
      return { ok: false, error: "Could not resolve Cloudbeds propertyID (getUserInfo/getHotels returned none)." };
    }

    const creds: CloudbedsResolvedCredentials = {
      accessToken: resolved.accessToken,
      tokenType: resolved.tokenType,
      baseUrl,
      propertyId,
    };

    // 4. Room types → room_types upsert.
    const { data: hotelRow } = await supabase
      .from("hotels")
      .select("total_rooms_per_type")
      .eq("id", hotelId)
      .maybeSingle();
    const defaultRooms = hotelRow?.total_rooms_per_type ?? 100;

    const rtRaw = await cloudbedsGetRoomTypes(creds);
    const parsedRoomTypes = parseCloudbedsRoomTypes(rtRaw, defaultRooms);

    let roomTypesUpserted = 0;
    if (parsedRoomTypes.length > 0) {
      const rtRows = dedupeByKey(
        parsedRoomTypes.map((rt) => ({
          hotel_id: hotelId,
          external_room_type_id: rt.external_room_type_id,
          name: rt.name,
          display_name: rt.display_name,
          is_active: true,
          total_rooms: rt.total_rooms,
        })),
        (r) => `${r.hotel_id}:${r.external_room_type_id}`,
      );
      roomTypesUpserted = rtRows.length;
      const { error: rtErr } = await supabase
        .from("room_types")
        .upsert(rtRows, { onConflict: "hotel_id,external_room_type_id" });
      if (rtErr) return { ok: false, error: rtErr.message };
    }

    // 5. Map external room-type id → internal uuid.
    const { data: idRows, error: idErr } = await supabase
      .from("room_types")
      .select("id, external_room_type_id")
      .eq("hotel_id", hotelId);
    if (idErr) return { ok: false, error: idErr.message };
    const idByExternal: Record<string, string> = {};
    for (const row of idRows ?? []) {
      if (row.external_room_type_id && row.id) idByExternal[String(row.external_room_type_id)] = String(row.id);
    }

    // 6. Reservations across the check-in window.
    const { checkInFrom, checkInTo } = resolveWindow(options);
    const { reservations: resRaw, pages } = await cloudbedsGetReservationsRange(
      creds,
      checkInFrom,
      checkInTo,
      CLOUDBEDS_ACTIVE_STATUSES,
    );

    // 6b. Optionally fetch per-night rate detail (gated; rate-limit sensitive).
    let nightlyRateByResId: Map<string, Record<string, number>> | undefined;
    if (CLOUDBEDS_FETCH_RATE_DETAIL && resRaw.length > 0) {
      nightlyRateByResId = new Map();
      for (const r of resRaw) {
        const rid = String((r.reservationID ?? r.reservationId ?? r.id) ?? "");
        if (!rid) continue;
        const detail = await cloudbedsGetReservationDetail(creds, rid);
        const rates = parseNightlyRatesFromDetail(detail);
        if (rates) nightlyRateByResId.set(rid, rates);
      }
    }

    const parsed = parseCloudbedsReservations(resRaw, nightlyRateByResId);

    let reservationRowsUpserted = 0;
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
      if (resErr) return { ok: false, error: resErr.message };

      const canceledDel = await deleteCanceledReservationRows(supabase, hotelId, parsed.canceledExternalIds);
      if (canceledDel.error) return { ok: false, error: canceledDel.error.message };

      const activeNights = new Map<string, Set<string>>();
      for (const r of parsed.reservations) {
        if (!activeNights.has(r.external_reservation_id)) activeNights.set(r.external_reservation_id, new Set());
        activeNights.get(r.external_reservation_id)!.add(r.stay_date);
      }
      const staleDel = await deleteStaleStayNights(supabase, hotelId, activeNights);
      if (staleDel.error) return { ok: false, error: staleDel.error.message };
    } else if (parsed.canceledExternalIds.length > 0) {
      const canceledDel = await deleteCanceledReservationRows(supabase, hotelId, parsed.canceledExternalIds);
      if (canceledDel.error) return { ok: false, error: canceledDel.error.message };
    }

    // 7. Stamp connection status.
    if (connRow?.id) {
      const nowIso = new Date().toISOString();
      const { error: pcErr } = await supabase
        .from("pms_connections")
        .update({ status: "connected", last_sync_at: nowIso, last_tested_at: nowIso, updated_at: nowIso })
        .eq("id", connRow.id);
      if (pcErr) console.error("cloudbeds pms_connections status update failed:", pcErr.message);
    }

    return {
      ok: true,
      fetchWindow: { checkInFrom, checkInTo },
      apiPages: pages,
      roomTypesUpserted,
      reservationRowsUpserted,
      ingest: {
        canceledReservationCount: parsed.canceledExternalIds.length,
        ...parsed.stats,
        tokenRefreshed: resolved.refreshed,
      },
    };
  } catch (error) {
    if (error instanceof CloudbedsHttpError) {
      return {
        ok: false,
        error: error.message,
        cloudbedsStatus: error.status,
        ...(error.retryAfterMs != null ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    const message = error instanceof Error ? error.message : "Cloudbeds sync failed.";
    return { ok: false, error: message };
  }
}
