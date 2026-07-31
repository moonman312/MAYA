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
  cloudbedsGetReservationsPage,
  cloudbedsGetReservationsRange,
  cloudbedsTimestamp,
  cloudbedsGetRoomTypes,
  CloudbedsHttpError,
  type CloudbedsReservation,
} from "./client.ts";
import {
  CLOUDBEDS_SYNC_BUDGET_MS,
  CLOUDBEDS_INCREMENTAL_OVERLAP_MS,
  CLOUDBEDS_FULL_SYNC_INTERVAL_MS,
  defaultCloudbedsBaseUrl,
  CLOUDBEDS_ACTIVE_STATUSES,
  CLOUDBEDS_CANCELED_STATUSES,
} from "./constants.ts";
import {
  cloudbedsRoomRowIds,
  cloudbedsRoomSlots,
  parseCloudbedsReservationDetail,
  parseCloudbedsRoomTypes,
} from "./etl.ts";
import type { CloudbedsParsedReservationRow, CloudbedsResolvedCredentials } from "./types.ts";
import { mwsEnv } from "../mews/env.ts";
import { persistPropertyId, resolveOAuthCredentials } from "../pms/oauth-credentials.ts";
import { installCloudbedsRequestLogging } from "./request-log.ts";

const RECONCILE_IN_CHUNK = 200;
const PAGE_GUARD = 1000;
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
  /** False when the detail budget expired before the window was covered. */
  windowFullyCovered: boolean;
  /** Resolved, ready-to-use credentials (reused by the rate-push step). */
  creds: CloudbedsResolvedCredentials;
  fetchWindow: { checkInFrom: string; checkInTo: string };
  apiPages: number;
  roomTypesUpserted: number;
  reservationRowsUpserted: number;
  ingest: {
    reservationsDetailFetched: number;
    reservationsDetailFailed: number;
    canceledReservationsSeen: number;
    canceledRowIdsDeleted: number;
    canceledDetailFailed: number;
    canceledStatusListFailures: number;
    duplicateStayNightKeysMerged: number;
    rowsWithMissingRate: number;
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

function reservationIdOf(item: CloudbedsReservation): string {
  return String((item.reservationID ?? item.reservationId ?? item.id) ?? "");
}

function isCanceledStatus(status: string | null): boolean {
  if (!status) return false;
  return (CLOUDBEDS_CANCELED_STATUSES as readonly string[]).includes(status.trim().toLowerCase());
}

/**
 * Every external_reservation_id a booking's stored rows could be keyed by, so a
 * cancellation can delete them. Rows are per physical room, not per booking, so
 * the parent id alone matches nothing for a multi-room stay; it stays in the set
 * because rows written before the per-room keying existed are under it. The
 * per-room ids come from etl.ts rather than a second copy of its rule — a copy
 * that drifted by one slot would leave phantom booked nights behind forever.
 * They are derived from the payload's own room arrays rather than from parsed
 * rows because a canceled booking can keep its assignments while dropping
 * dailyRates, which leaves the parsed rows — and so the ids — empty.
 */
function rowIdsForReservation(rid: string, payload: Record<string, unknown>): string[] {
  return [rid, ...cloudbedsRoomRowIds(rid, cloudbedsRoomSlots(payload))];
}

/**
 * Enumerate canceled / no-show reservations over the same check-in window.
 * Paged per status by hand instead of via cloudbedsGetReservationsRange so one
 * rejected status value can't fail the sync: the canceled set carries both
 * "canceled" and "cancelled" and an account that only accepts one spelling
 * would otherwise 400 the whole run.
 */
async function listCanceledReservations(
  creds: CloudbedsResolvedCredentials,
  checkInFrom: string,
  checkInTo: string,
  /** Same watermark as the active pull: a cancellation IS a modification. */
  modifiedFrom?: string,
): Promise<{ items: CloudbedsReservation[]; pages: number; statusesFailed: number }> {
  const items: CloudbedsReservation[] = [];
  let pages = 0;
  let statusesFailed = 0;

  for (const status of CLOUDBEDS_CANCELED_STATUSES) {
    let pageNumber = 1;
    try {
      for (let guard = 0; guard < PAGE_GUARD; guard += 1) {
        const page = await cloudbedsGetReservationsPage(
          creds,
          checkInFrom,
          checkInTo,
          status,
          pageNumber,
          modifiedFrom,
        );
        pages += 1;
        items.push(...page.reservations);
        if (!page.hasMore) break;
        pageNumber += 1;
      }
    } catch (error) {
      // Only the rejected-spelling case is survivable. A 401, a 5xx or a timeout
      // here means the cancellation pass reconciled nothing, and swallowing it
      // would report a healthy sync that silently left phantom nights booked.
      const rejectedValue =
        error instanceof CloudbedsHttpError && (error.status === 400 || error.status === 422);
      if (!rejectedValue) throw error;
      statusesFailed += 1;
    }
  }

  return { items, pages, statusesFailed };
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

export type SyncMode = {
  incremental: boolean;
  /** Passed to Cloudbeds as modifiedFrom. Undefined means sweep everything. */
  modifiedFrom: string | undefined;
  reason: "first_run" | "full_sweep_due" | "window_requested" | "incremental";
};

/**
 * Whether this run pulls everything or only what changed.
 *
 * Pure so the decision can be tested, because getting it wrong is silent in both
 * directions: too eager and a hotel's bookings stop updating, too cautious and
 * the sync never finishes for anyone above thirty rooms.
 */
export function decideSyncMode(args: {
  now: Date;
  watermark: Date | null;
  lastFullSyncAt: Date | null;
  windowRequested: boolean;
  overlapMs: number;
  fullSweepIntervalMs: number;
}): SyncMode {
  const { now, watermark, lastFullSyncAt, windowRequested, overlapMs, fullSweepIntervalMs } = args;

  if (windowRequested) return { incremental: false, modifiedFrom: undefined, reason: "window_requested" };
  if (!watermark) return { incremental: false, modifiedFrom: undefined, reason: "first_run" };
  if (!lastFullSyncAt || now.getTime() - lastFullSyncAt.getTime() > fullSweepIntervalMs) {
    return { incremental: false, modifiedFrom: undefined, reason: "full_sweep_due" };
  }

  return {
    incremental: true,
    modifiedFrom: cloudbedsTimestamp(new Date(watermark.getTime() - overlapMs)),
    reason: "incremental",
  };
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
    // Mirror every Cloudbeds API call into pms_request_log (fire-and-forget).
    installCloudbedsRequestLogging(supabase, hotelId);

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

    // 4. Room types → room_types upsert. No is_active in the payload: PostgREST
    //    only touches the columns it is given, so a type the owner excluded (or
    //    the duplicate-dedup deactivated) is not resurrected and priced by the
    //    next 5-minute cron. New rows still default to active.
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

    // 6. Reservations. The Cloudbeds list endpoint is minimal (no room type, no
    //    nightly rate), so we use it only to enumerate reservation ids in the
    //    check-in window, then pull getReservation DETAIL per booking and
    //    explode assigned[] × dailyRates[] into per-room-night rows.
    const { checkInFrom, checkInTo } = resolveWindow(options);

    // Incremental unless there is a reason not to be. Re-fetching the whole book
    // every five minutes is what made this impossible above ~30 rooms; a
    // steady-state tick only needs the bookings somebody actually touched.
    //
    // A full sweep happens when there is no watermark (first run after connect),
    // when the last one is older than CLOUDBEDS_FULL_SYNC_INTERVAL_MS, or when
    // the caller asked for a specific window — an incremental pull cannot see a
    // booking nobody changed, so something has to look at everything sometimes.
    const runStartedAt = new Date();
    const { data: syncState } = await supabase
      .from("pms_connections")
      .select("reservations_modified_through, last_full_sync_at")
      .eq("hotel_id", hotelId)
      .eq("pms_type", "cloudbeds")
      .maybeSingle();

    const watermark = syncState?.reservations_modified_through
      ? new Date(String(syncState.reservations_modified_through))
      : null;
    const lastFull = syncState?.last_full_sync_at
      ? new Date(String(syncState.last_full_sync_at))
      : null;
    const { incremental, modifiedFrom } = decideSyncMode({
      now: runStartedAt,
      watermark,
      lastFullSyncAt: lastFull,
      // An explicit window is a deliberate re-read of a period, so honour it in
      // full rather than filtering it down to what changed.
      windowRequested: options?.daysBack != null || options?.daysForward != null,
      overlapMs: CLOUDBEDS_INCREMENTAL_OVERLAP_MS,
      fullSweepIntervalMs: CLOUDBEDS_FULL_SYNC_INTERVAL_MS,
    });

    const { reservations: listItems, pages } = await cloudbedsGetReservationsRange(
      creds,
      checkInFrom,
      checkInTo,
      CLOUDBEDS_ACTIVE_STATUSES,
      modifiedFrom,
    );

    const seenResIds = new Set<string>();
    const allRows: CloudbedsParsedReservationRow[] = [];
    const canceledRowIds = new Set<string>();
    let detailFetched = 0;
    let detailFailed = 0;
    let canceledSeen = 0;

    // A budget, because this loop is one Cloudbeds call per reservation and the
    // pacer spaces them 220ms apart. At 300s of wall clock that is ~1,360 calls,
    // which a 30-room property already exceeds — and being killed mid-loop used
    // to mean the upsert below never ran and NOTHING was written. A hotel above
    // that size therefore had no reservation data at all, re-attempted and
    // re-failed every five minutes, forever.
    //
    // Stopping deliberately, with what we have, is strictly better than being
    // stopped arbitrarily with nothing. `truncated` says the window was not
    // fully covered so the caller can decide whether to come straight back.
    const deadlineAt = Date.now() + CLOUDBEDS_SYNC_BUDGET_MS;
    let truncated = false;

    for (const item of listItems) {
      if (Date.now() > deadlineAt) {
        truncated = true;
        break;
      }
      const rid = reservationIdOf(item);
      if (!rid || seenResIds.has(rid)) continue;
      seenResIds.add(rid);
      const detail = await cloudbedsGetReservationDetail(creds, rid);
      if (!detail) {
        detailFailed += 1;
        continue;
      }
      detailFetched += 1;
      const parsed = parseCloudbedsReservationDetail(detail);
      // The list was filtered to active statuses server-side, but a booking can
      // cancel between that page and this detail call — the detail is newer.
      if (isCanceledStatus(parsed.status)) {
        canceledSeen += 1;
        for (const id of rowIdsForReservation(rid, detail)) canceledRowIds.add(id);
        continue;
      }
      allRows.push(...parsed.rows);
    }

    // Dedupe to the reservations unique key (external_reservation_id, stay_date).
    const byKey = new Map<string, CloudbedsParsedReservationRow>();
    for (const r of allRows) byKey.set(`${r.external_reservation_id}:${r.stay_date}`, r);
    const rows = [...byKey.values()];
    const duplicateStayNightKeysMerged = allRows.length - rows.length;
    const rowsWithMissingRate = rows.filter((r) => r.current_rate === null).length;

    let reservationRowsUpserted = 0;
    if (rows.length > 0) {
      const resRows = rows.map((r) => ({
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

      // Chunked upsert — a busy hotel produces thousands of room-nights.
      const UP_CHUNK = 500;
      for (let i = 0; i < resRows.length; i += UP_CHUNK) {
        const { error: resErr } = await supabase
          .from("reservations")
          .upsert(resRows.slice(i, i + UP_CHUNK), {
            onConflict: "hotel_id,external_reservation_id,stay_date",
          });
        if (resErr) return { ok: false, error: resErr.message };
      }
    }

    // Reconcile outside the upsert branch: a hotel whose entire book cancels
    // fetches zero active rows and still has to lose those nights.
    const activeNights = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!activeNights.has(r.external_reservation_id)) activeNights.set(r.external_reservation_id, new Set());
      activeNights.get(r.external_reservation_id)!.add(r.stay_date);
    }

    // Cancellations drop out of the active list entirely, so nothing above ever
    // sees them again — without this pass their room-nights stay in
    // `reservations` forever and keep counting as booked occupancy.
    //
    // Deliberately after the upsert: this pass hits the API again, and anything
    // that isn't a rejected status spelling rethrows. Fetching it first meant a
    // 503 or an expired token on THIS list threw away the active room-nights
    // already parsed above — every hotel losing a whole cron cycle's data (and
    // its rate push) over a cancellation-list hiccup. Failing after the upsert
    // still reports ok:false; it just doesn't discard good data to do it.
    // Cancelling a booking modifies it, so the same watermark applies — and the
    // rows for anything cancelled before it were already removed on the run that
    // saw it. Without this the cancelled sweep re-walks every cancellation the
    // property has ever had, on every tick, forever.
    const canceledList = await listCanceledReservations(creds, checkInFrom, checkInTo, modifiedFrom);
    let canceledDetailFailed = 0;
    for (const item of canceledList.items) {
      const rid = reservationIdOf(item);
      if (!rid || seenResIds.has(rid)) continue;
      seenResIds.add(rid);
      const detail = await cloudbedsGetReservationDetail(creds, rid);
      if (!detail) {
        // The list said canceled, so clear what the list item itself names —
        // the parent id plus whatever rooms[] it carries. A list item that names
        // no rooms leaves rooms 2..n of a multi-room cancellation behind until a
        // run whose detail call succeeds. (cloudbedsGetReservationDetail returns
        // null for a 5xx or timeout too, not only a genuinely missing booking.)
        canceledDetailFailed += 1;
        canceledSeen += 1;
        for (const id of rowIdsForReservation(rid, item)) canceledRowIds.add(id);
        continue;
      }
      const status = parseCloudbedsReservationDetail(detail).status;
      // Reinstated between the list page and here — leave its rows alone and let
      // the next sync pick it up as active. A detail payload with no status at all
      // does not overrule the list, which said canceled.
      if (status && !isCanceledStatus(status)) continue;
      canceledSeen += 1;
      for (const id of rowIdsForReservation(rid, detail)) canceledRowIds.add(id);
    }

    // Never delete an id this run just upserted. If a status flipped between the
    // two passes, the nights we just confirmed as booked win; the next sync
    // re-decides with a consistent read.
    const canceledIds = [...canceledRowIds].filter((id) => !activeNights.has(id));
    const canceledDel = await deleteCanceledReservationRows(supabase, hotelId, canceledIds);
    if (canceledDel.error) return { ok: false, error: canceledDel.error.message };

    // Prune stale nights for still-active bookings (date/rate changes).
    const staleDel = await deleteStaleStayNights(supabase, hotelId, activeNights);
    if (staleDel.error) return { ok: false, error: staleDel.error.message };

    // 7. Stamp connection status.
    if (connRow?.id) {
      const nowIso = new Date().toISOString();
      const { error: pcErr } = await supabase
        .from("pms_connections")
        .update({
          status: "connected",
          last_sync_at: nowIso,
          last_tested_at: nowIso,
          updated_at: nowIso,
          // Advance ONLY on a run that covered its window. A truncated run
          // stopped partway through the list, so moving the watermark past the
          // bookings it never reached would skip them permanently — the next
          // incremental pull would ask for changes since a moment it never
          // actually finished reading.
          //
          // Stamped with when this run STARTED, not now: anything modified while
          // it was running has to fall inside the next pull's range.
          ...(truncated
            ? {}
            : { reservations_modified_through: runStartedAt.toISOString() }),
          ...(!truncated && !incremental ? { last_full_sync_at: runStartedAt.toISOString() } : {}),
        })
        .eq("id", connRow.id);
      if (pcErr) console.error("cloudbeds pms_connections status update failed:", pcErr.message);
    }

    return {
      ok: true,
      creds,
      // False when the detail budget ran out before the window was covered. A
      // partial sync that looks complete is worse than one that says so: the
      // next tick picks up where this stopped, but only if someone can tell.
      windowFullyCovered: !truncated,
      fetchWindow: { checkInFrom, checkInTo },
      apiPages: pages + canceledList.pages,
      roomTypesUpserted,
      reservationRowsUpserted,
      ingest: {
        reservationsDetailFetched: detailFetched,
        reservationsDetailFailed: detailFailed,
        canceledReservationsSeen: canceledSeen,
        canceledRowIdsDeleted: canceledIds.length,
        canceledDetailFailed,
        canceledStatusListFailures: canceledList.statusesFailed,
        duplicateStayNightKeysMerged,
        rowsWithMissingRate,
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
