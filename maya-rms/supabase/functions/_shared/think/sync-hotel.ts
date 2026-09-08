/**
 * Full Think → Supabase sync for one hotel. Mirrors runMewsSyncForHotel:
 * writes into the same room_types / reservations tables, reconciles
 * cancellations and stale stay-nights, and stamps pms_connections
 * status/last_sync_at.
 *
 * Credentials come from the OAuth secret in Vault (auto-refreshed; Auth0
 * rotates the refresh token on every use, which oauth-credentials.ts already
 * persists). ⚠ The wire assumptions — parameter flattening, page-size
 * ceiling, sort grammar, billingType values — live behind their own VERIFY
 * live markers in client.ts and etl.ts, not here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildReservationRangeParams,
  thinkGetHotels,
  thinkGetReservationsPage,
  thinkGetRoomTypes,
  ThinkHttpError,
} from "./client.ts";
import {
  THINK_API_BASE_URL,
  THINK_FULL_SYNC_INTERVAL_MS,
  THINK_INCREMENTAL_OVERLAP_MS,
  THINK_PAGE_SIZE,
  THINK_SYNC_BUDGET_MS,
} from "./constants.ts";
import { parseThinkReservations, parseThinkRoomTypes, type ThinkParseStats } from "./etl.ts";
import type { ThinkCredentials } from "./types.ts";
import { mwsEnv } from "../mews/env.ts";
import { persistPropertyId, resolveOAuthCredentials } from "../pms/oauth-credentials.ts";
import { dropUnchangedReservationRows } from "../pms/row-diff.ts";
import { decideSyncWindow } from "../pms/sync-mode.ts";

const RECONCILE_IN_CHUNK = 200;
/** A pager that never says `last` should exhaust this, not the isolate. */
const PAGE_GUARD = 1000;
/** Match the Mews/Cloudbeds defaults so all three PMSes sweep the same book. */
const DEFAULT_BACK = 30;
const DEFAULT_FORWARD = 396;
const MAX_BACK = 365;
const MAX_FORWARD = 730;

export type ThinkSyncOptions = {
  daysBack?: number;
  daysForward?: number;
};

export type ThinkSyncSuccess = {
  ok: true;
  /** False when the budget expired before the range was covered. */
  windowFullyCovered: boolean;
  /** Stay dates for a sweep, updated-at instants for an incremental pull. */
  fetchWindow: { start: string; end: string };
  apiPages: number;
  roomTypesUpserted: number;
  reservationRowsUpserted: number;
  ingest: {
    duplicateRoomTypeRowsMerged: number;
    unchangedRowsSkipped: number;
    canceledReservationCount: number;
    skippedMissingReservationId: number;
    skippedNoStayNights: number;
    duplicateStayNightKeysMerged: number;
    rowsWithMissingRate: number;
    skippedCanceled: number;
    tokenRefreshed: boolean;
  };
};

export type ThinkSyncFailure = {
  ok: false;
  error: string;
  thinkStatus?: number;
  retryAfterMs?: number;
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = mwsEnv(name)?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function resolveStayWindow(
  options: ThinkSyncOptions | undefined,
  anchorMs: number,
): { start: string; end: string } {
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
  return {
    start: ymd(anchorMs - back * 86_400_000),
    end: ymd(anchorMs + forward * 86_400_000),
  };
}

function dedupeByKey<T>(rows: T[], keyFn: (row: T) => string): { rows: T[]; merged: number } {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(keyFn(row), row);
  }
  return { rows: [...map.values()], merged: rows.length - map.size };
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

/**
 * One DELETE per reservation here was most of a sync's round trips, spent on
 * rows that almost never exist — a booking only sheds nights when its dates
 * shrink. So read the stored nights back, diff against the active set, and
 * delete just the leftovers, grouped by night so a date change costs one
 * statement instead of one per booking.
 */
async function deleteStaleStayNightsForActiveReservations(
  supabase: SupabaseClient,
  hotelId: string,
  activeByExternalId: Map<string, Set<string>>,
): Promise<{ error: { message: string } | null }> {
  const extIds = [...activeByExternalId.keys()].filter(
    (id) => activeByExternalId.get(id)!.size > 0,
  );

  const READ_PAGE = 1000;
  const staleByDate = new Map<string, string[]>();
  for (let i = 0; i < extIds.length; i += RECONCILE_IN_CHUNK) {
    const chunk = extIds.slice(i, i + RECONCILE_IN_CHUNK);
    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await supabase
        .from("reservations")
        .select("external_reservation_id, stay_date")
        .eq("hotel_id", hotelId)
        .in("external_reservation_id", chunk)
        .range(from, from + READ_PAGE - 1);
      if (error) return { error };
      for (const row of data ?? []) {
        const extId = String(row.external_reservation_id);
        const stayDate = String(row.stay_date);
        if (activeByExternalId.get(extId)?.has(stayDate)) continue;
        const ids = staleByDate.get(stayDate);
        if (ids) ids.push(extId);
        else staleByDate.set(stayDate, [extId]);
      }
      if ((data ?? []).length < READ_PAGE) break;
    }
  }

  for (const [stayDate, ids] of staleByDate) {
    for (let i = 0; i < ids.length; i += RECONCILE_IN_CHUNK) {
      const { error } = await supabase
        .from("reservations")
        .delete()
        .eq("hotel_id", hotelId)
        .eq("stay_date", stayDate)
        .in("external_reservation_id", ids.slice(i, i + RECONCILE_IN_CHUNK));
      if (error) return { error };
    }
  }
  return { error: null };
}

export async function runThinkSyncForHotel(
  supabase: SupabaseClient,
  hotelId: string,
  options?: ThinkSyncOptions,
): Promise<ThinkSyncSuccess | ThinkSyncFailure> {
  try {
    // 1. Credentials (auto-refresh if near expiry — with 1-day tokens the
    //    refresh fires roughly once a day per hotel, not every tick).
    const resolved = await resolveOAuthCredentials(supabase, hotelId, "think");
    if ("error" in resolved) return { ok: false, error: resolved.error };

    // 2. Connection row: base_url override plus the sync-state columns, in
    //    one read — it is the same row the stamp at the bottom updates.
    const { data: connRow } = await supabase
      .from("pms_connections")
      .select(
        "id, base_url, reservations_modified_through, last_full_sync_at, full_sweep_after_id, full_sweep_started_at",
      )
      .eq("hotel_id", hotelId)
      .eq("pms_type", "think")
      .maybeSingle();

    const creds: ThinkCredentials = {
      accessToken: resolved.accessToken,
      baseUrl: (connRow?.base_url || THINK_API_BASE_URL).replace(/\/$/, ""),
    };

    // 3. The hotel id for API paths — Think spells it externalId, and it is
    //    what every {hotelId} path segment wants from an OAuth consumer
    //    (see thinkGetHotels). Discovered once and persisted onto the Vault
    //    secret, same as the Cloudbeds propertyID. Only a sole-hotel token
    //    self-discovers: picking one of several would quietly sync some other
    //    property's book into this hotel, so that case has to be pinned by
    //    hand and says so.
    let thinkHotelId = resolved.propertyId;
    if (!thinkHotelId) {
      const hotels = await thinkGetHotels(creds);
      if (hotels.length === 1) {
        thinkHotelId = hotels[0].externalId;
        await persistPropertyId(supabase, hotelId, "think", thinkHotelId);
      } else if (hotels.length === 0) {
        return {
          ok: false,
          error:
            "Think returned no hotels for this token (or none carries an externalId) — finish the Think-side setup, then reconnect via OAuth.",
        };
      } else {
        return {
          ok: false,
          error: `Think token reads ${hotels.length} hotels — store the externalId of the right one as this connection's propertyId so the sync knows which book to pull.`,
        };
      }
    }

    const { data: hotelRow, error: hotelErr } = await supabase
      .from("hotels")
      .select("total_rooms_per_type, timezone")
      .eq("id", hotelId)
      .maybeSingle();
    // Reading nothing is fine (defaults below); failing to read is not — the
    // UTC fallback would date a west-of-Greenwich hotel's evening bookings a
    // day late and then prune the correct nights as stale. Skipping the tick
    // is recoverable, that is not.
    if (hotelErr) {
      return { ok: false, error: hotelErr.message };
    }

    const defaultRooms = hotelRow?.total_rooms_per_type ?? 100;
    // Think bookings are civil days already; createdAt and billingDate are
    // instants the ETL folds onto this calendar.
    const hotelTimeZone = hotelRow?.timezone ?? "UTC";

    // 4. Room types → room_types upsert, once per run. No is_active in the
    //    payload: the column list PostgREST is given comes from these keys,
    //    so a type the owner excluded (or a duplicate finding deactivated) is
    //    not resurrected and priced by the next cron. New rows still take the
    //    schema default and come in active.
    const rtRaw = await thinkGetRoomTypes(creds, thinkHotelId);
    const parsedRoomTypes = parseThinkRoomTypes(rtRaw, defaultRooms);

    let roomTypesUpserted = 0;
    let duplicateRoomTypeRowsMerged = 0;
    if (parsedRoomTypes.length > 0) {
      const { rows: rtRows, merged: rtMerged } = dedupeByKey(
        parsedRoomTypes.map((rt) => ({
          hotel_id: hotelId,
          external_room_type_id: rt.external_room_type_id,
          name: rt.name,
          display_name: rt.display_name,
          total_rooms: rt.total_rooms,
        })),
        (r) => `${r.hotel_id}:${r.external_room_type_id}`,
      );
      duplicateRoomTypeRowsMerged = rtMerged;
      roomTypesUpserted = rtRows.length;
      const { error: rtErr } = await supabase
        .from("room_types")
        .upsert(rtRows, { onConflict: "hotel_id,external_room_type_id" });
      if (rtErr) return { ok: false, error: rtErr.message };
    }

    // 5. Map external room-type id → internal uuid. Read back from the DB
    //    rather than built from the fetched list: a reservation can name a
    //    type /room_types no longer returns, and mapping it against only
    //    today's list would null out room_type_id on rows that had it right.
    const { data: idRows, error: idErr } = await supabase
      .from("room_types")
      .select("id, external_room_type_id")
      .eq("hotel_id", hotelId);
    if (idErr) return { ok: false, error: idErr.message };
    const idByExternal: Record<string, string> = {};
    for (const row of idRows ?? []) {
      if (row.external_room_type_id && row.id) {
        idByExternal[String(row.external_room_type_id)] = String(row.id);
      }
    }

    // 6. Reservations. Same mode machinery as Cloudbeds and Mews, on the same
    //    columns: incremental unless there is a reason not to be. Think
    //    spells "changed since" as an updated_at range on the reservations
    //    query itself, so both modes walk the same paged endpoint.
    const runStartedAt = new Date();
    const watermark = connRow?.reservations_modified_through
      ? new Date(String(connRow.reservations_modified_through))
      : null;
    const lastFull = connRow?.last_full_sync_at
      ? new Date(String(connRow.last_full_sync_at))
      : null;
    // An explicit window is a deliberate re-read of a period, so honour it in
    // full rather than filtering it down to what changed.
    const windowRequested = options?.daysBack != null || options?.daysForward != null;
    const decision = decideSyncWindow({
      now: runStartedAt,
      watermark,
      lastFullSyncAt: lastFull,
      windowRequested,
      overlapMs: THINK_INCREMENTAL_OVERLAP_MS,
      fullSweepIntervalMs: THINK_FULL_SYNC_INTERVAL_MS,
    });
    const incremental = decision.incremental;

    // Only the SCHEDULED full sweep checkpoints. An explicit window is a
    // one-shot re-read someone asked for, and incremental pulls are small
    // enough that resuming them buys nothing. The checkpoint is a PAGE index:
    // the stable sort is what makes "page N" mean the same slice next tick.
    const checkpointable = !incremental && !windowRequested;
    const sweepFromPage =
      checkpointable && connRow?.full_sweep_after_id
        ? Number.parseInt(String(connRow.full_sweep_after_id), 10) + 1 || 0
        : 0;
    const sweepStartedAt =
      checkpointable && connRow?.full_sweep_started_at
        ? new Date(String(connRow.full_sweep_started_at))
        : null;

    // Anchored to the sweep's own start when resuming, so every tick of one
    // sweep pages the SAME stay range — a now-anchored range would shift the
    // bounds a few minutes each tick, which is enough to slide reservations
    // across page boundaries and make the resume index mean a slightly
    // different slice than the one already covered.
    const stayWindow = resolveStayWindow(options, (sweepStartedAt ?? runStartedAt).getTime());
    // An updated_at pull's range is change-time, not stay-time — it runs from
    // just behind the watermark to now, regardless of how far out the stays
    // are. Cancellations need no pass of their own here (unlike Cloudbeds):
    // canceling a reservation modifies it, so it arrives IN this pull with
    // status canceled and the ETL surfaces it through canceledExternalIds.
    const rangeParams = incremental
      ? buildReservationRangeParams({
          updatedFrom: decision.modifiedSince!,
          updatedTo: runStartedAt,
        })
      : buildReservationRangeParams({ stayFrom: stayWindow.start, stayTo: stayWindow.end });
    const fetchWindow = incremental
      ? { start: decision.modifiedSince!.toISOString(), end: runStartedAt.toISOString() }
      : stayWindow;

    let reservationRowsUpserted = 0;
    let unchangedRowsSkipped = 0;
    const stats: ThinkParseStats = {
      skippedMissingReservationId: 0,
      skippedNoStayNights: 0,
      duplicateStayNightKeysMerged: 0,
      rowsWithMissingRate: 0,
      skippedCanceled: 0,
    };
    // What survives the walk: night keys and canceled ids, never payloads —
    // each page is parsed, written, and dropped before the next arrives, so a
    // multi-thousand-reservation sweep never holds more than one page of raw
    // API response at a time.
    const activeNights = new Map<string, Set<string>>();
    const canceledKeys = new Set<string>();
    const deadlineAt = Date.now() + THINK_SYNC_BUDGET_MS;
    let truncated = false;
    let pagesFetched = 0;
    let lastCompletedPage = sweepFromPage - 1;

    for (let page = sweepFromPage; ; page += 1) {
      const pageRes = await thinkGetReservationsPage(
        creds,
        thinkHotelId,
        rangeParams,
        page,
        THINK_PAGE_SIZE,
      );
      pagesFetched += 1;

      const parsed = parseThinkReservations(pageRes.content, { hotelTimeZone });
      for (const key of Object.keys(stats) as (keyof ThinkParseStats)[]) {
        stats[key] += parsed.stats[key] ?? 0;
      }
      for (const id of parsed.canceledExternalIds) canceledKeys.add(id);

      if (parsed.rows.length > 0) {
        const allRes = parsed.rows.map((r) => ({
          hotel_id: hotelId,
          external_reservation_id: r.external_reservation_id,
          room_type_id: r.external_room_type_id
            ? idByExternal[r.external_room_type_id] ?? null
            : null,
          stay_date: r.stay_date,
          booking_date: r.booking_date,
          booking_window_days: r.booking_window_days,
          current_rate: r.current_rate,
          raw_payload: r.raw_payload,
        }));
        // Most of a full sweep is rows that didn't move; writing them anyway
        // is WAL, realtime messages, and vacuum work for nothing.
        const diffed = await dropUnchangedReservationRows(supabase, hotelId, allRes);
        if (diffed.error) return { ok: false, error: diffed.error.message };
        unchangedRowsSkipped += diffed.unchanged;
        reservationRowsUpserted += diffed.rows.length;
        const UP_CHUNK = 500;
        for (let i = 0; i < diffed.rows.length; i += UP_CHUNK) {
          const { error: resErr } = await supabase
            .from("reservations")
            .upsert(diffed.rows.slice(i, i + UP_CHUNK), {
              onConflict: "hotel_id,external_reservation_id,stay_date",
            });
          if (resErr) return { ok: false, error: resErr.message };
        }
        for (const r of parsed.rows) {
          if (!activeNights.has(r.external_reservation_id)) {
            activeNights.set(r.external_reservation_id, new Set());
          }
          activeNights.get(r.external_reservation_id)!.add(r.stay_date);
        }
      }

      // The page just landed is fully written before the budget is consulted,
      // so a checkpoint always names work that is actually done. Stopping
      // deliberately, with what we have, beats being killed arbitrarily with
      // a page half-applied.
      lastCompletedPage = page;
      if (pageRes.last) break;
      if (Date.now() >= deadlineAt || pagesFetched >= PAGE_GUARD) {
        truncated = true;
        break;
      }
    }

    // Reconciles are scoped to what THIS invocation fetched, so running them
    // on a mid-flight sweep chunk is safe; earlier chunks reconciled their
    // own. canceledExternalIds carries the bare reservation id next to the
    // per-booking composites so rows keyed by any earlier scheme die with the
    // stay. Drop any key this run actively wrote before deleting: if a status
    // flipped mid-pull, the nights just confirmed as booked win, and the next
    // sync re-decides with a consistent read.
    const canceledIds = [...canceledKeys].filter((id) => !activeNights.has(id));
    const canceledDel = await deleteCanceledReservationRows(supabase, hotelId, canceledIds);
    if (canceledDel.error) return { ok: false, error: canceledDel.error.message };
    const staleDel = await deleteStaleStayNightsForActiveReservations(
      supabase,
      hotelId,
      activeNights,
    );
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
          // Same watermark discipline as Cloudbeds and Mews: advance only on
          // a covered window, stamped from when the SWEEP began so anything
          // updated while it ran lands in the next incremental pull.
          ...(truncated
            ? {}
            : {
                reservations_modified_through: (checkpointable && sweepStartedAt
                  ? sweepStartedAt
                  : runStartedAt
                ).toISOString(),
              }),
          ...(!truncated && !incremental
            ? {
                last_full_sync_at: (checkpointable && sweepStartedAt
                  ? sweepStartedAt
                  : runStartedAt
                ).toISOString(),
              }
            : {}),
          // The checkpoint itself: a truncated sweep records the last page it
          // finished and when the whole thing began; a completed one clears
          // both so the next daily sweep starts fresh.
          ...(checkpointable && truncated
            ? {
                full_sweep_after_id: String(lastCompletedPage),
                full_sweep_started_at: (sweepStartedAt ?? runStartedAt).toISOString(),
              }
            : {}),
          // Cleared by ANY completed full run, not just checkpointable ones:
          // a finished explicit-window run advances the watermark past
          // whatever sweep was mid-flight, and resuming that stale grid later
          // would just stamp an old watermark and force a redundant second
          // sweep.
          ...(!truncated && !incremental
            ? { full_sweep_after_id: null, full_sweep_started_at: null }
            : {}),
        })
        .eq("id", connRow.id);
      if (pcErr) {
        console.error("think pms_connections status update failed:", pcErr.message);
      }
    }

    return {
      ok: true,
      // A partial sync that looks complete is worse than one that says so:
      // the next tick picks up where this stopped, but only if someone can
      // tell.
      windowFullyCovered: !truncated,
      fetchWindow,
      apiPages: pagesFetched,
      roomTypesUpserted,
      reservationRowsUpserted,
      ingest: {
        duplicateRoomTypeRowsMerged,
        unchangedRowsSkipped,
        canceledReservationCount: canceledIds.length,
        tokenRefreshed: resolved.refreshed,
        ...stats,
      },
    };
  } catch (error) {
    if (error instanceof ThinkHttpError) {
      return {
        ok: false,
        error: error.message,
        thinkStatus: error.status,
        ...(error.retryAfterMs != null ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    const message = error instanceof Error ? error.message : "Think sync failed.";
    return { ok: false, error: message };
  }
}
