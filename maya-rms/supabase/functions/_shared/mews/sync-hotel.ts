import type { SupabaseClient } from "@supabase/supabase-js";
import { mewsWalkReservationWindows, MewsHttpError } from "./client.ts";
import {
  MEWS_FULL_SYNC_INTERVAL_MS,
  MEWS_INCREMENTAL_OVERLAP_MS,
  MEWS_SYNC_BUDGET_MS,
} from "./constants.ts";
import { parseMewsApiResponse } from "./etl.ts";
import { mwsEnv } from "./env.ts";
import { resolveMewsCredentials } from "./resolve-credentials.ts";
import type { MewsCredentialsInput } from "./types.ts";
import { dropUnchangedReservationRows } from "../pms/row-diff.ts";
import { decideSyncWindow } from "../pms/sync-mode.ts";

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

function utcRange(
  daysBack: number,
  daysForward: number,
  anchorMs = Date.now(),
): { start: string; end: string } {
  const start = new Date(anchorMs - daysBack * 86400000);
  const end = new Date(anchorMs + daysForward * 86400000);
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

function resolveFetchWindow(
  options?: MewsSyncHotelOptions,
  anchorMs?: number,
): { start: string; end: string } {
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
  return utcRange(back, forward, anchorMs);
}

export type MewsSyncHotelSuccess = {
  ok: true;
  fetchWindowUtc: { start: string; end: string };
  /** False when the budget expired before the range was covered. */
  windowFullyCovered: boolean;
  apiWindows: number;
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

    const { data: hotelRow, error: hotelErr } = await supabase
      .from("hotels")
      .select("total_rooms_per_type, timezone")
      .eq("id", hotelId)
      .maybeSingle();
    // Reading nothing is fine (defaults below); failing to read is not — the UTC
    // fallback would write shifted stay nights and then prune the correct ones as
    // stale. Skipping the tick is recoverable, that is not.
    if (hotelErr) {
      return { ok: false, error: hotelErr.message };
    }

    const defaultRoomsPerCategory = hotelRow?.total_rooms_per_type ?? 100;
    // Mews dates are UTC instants; stay nights belong to the hotel's calendar.
    const hotelTimeZone = hotelRow?.timezone ?? "UTC";

    // Same mode machinery as Cloudbeds, on the same columns: incremental unless
    // there is a reason not to be. Mews spells "changed since" as
    // TimeFilter: Updated over an interval, which the walk below passes through.
    const runStartedAt = new Date();
    const { data: syncState } = await supabase
      .from("pms_connections")
      .select(
        "reservations_modified_through, last_full_sync_at, full_sweep_after_id, full_sweep_started_at",
      )
      .eq("hotel_id", hotelId)
      .eq("pms_type", "mews")
      .maybeSingle();
    const watermark = syncState?.reservations_modified_through
      ? new Date(String(syncState.reservations_modified_through))
      : null;
    const lastFull = syncState?.last_full_sync_at
      ? new Date(String(syncState.last_full_sync_at))
      : null;
    const windowRequested = options?.daysBack != null || options?.daysForward != null;
    const decision = decideSyncWindow({
      now: runStartedAt,
      watermark,
      lastFullSyncAt: lastFull,
      windowRequested,
      overlapMs: MEWS_INCREMENTAL_OVERLAP_MS,
      fullSweepIntervalMs: MEWS_FULL_SYNC_INTERVAL_MS,
    });
    const incremental = decision.incremental;
    const checkpointable = !incremental && !windowRequested;
    const sweepFromIndex =
      checkpointable && syncState?.full_sweep_after_id
        ? Number.parseInt(String(syncState.full_sweep_after_id), 10) + 1 || 0
        : 0;
    const sweepStartedAt =
      checkpointable && syncState?.full_sweep_started_at
        ? new Date(String(syncState.full_sweep_started_at))
        : null;

    const fmtIso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    // Anchored to the sweep's own start when resuming, so every tick of one
    // sweep sees the SAME window grid — a now-anchored range would shift the
    // boundaries a few minutes each tick and make the resume index mean a
    // slightly different interval than the one already covered.
    const colliding = resolveFetchWindow(options, (sweepStartedAt ?? runStartedAt).getTime());
    // An Updated pull's interval is change-time, not stay-time — it runs from
    // just behind the watermark to now, regardless of how far out the stays are.
    const { start, end } = incremental
      ? { start: fmtIso(decision.modifiedSince!), end: fmtIso(runStartedAt) }
      : colliding;

    let roomTypesUpserted = 0;
    let reservationRowsUpserted = 0;
    let unchangedRowsSkipped = 0;
    let duplicateRoomTypeRowsMerged = 0;
    const stats = {
      skippedMissingReservationId: 0,
      skippedNoStayNights: 0,
      duplicateStayNightKeysMerged: 0,
      rowsWithMissingRate: 0,
      skippedCanceled: 0,
    };
    // What survives the walk: night keys and canceled ids, never payloads. A
    // 426-day range is 107 windows, and holding their raw responses at once was
    // hundreds of megabytes in one isolate — each window is parsed, written,
    // and dropped before the next arrives.
    const activeNights = new Map<string, Set<string>>();
    const canceledIds = new Set<string>();
    // Seeded from the DB up front, refreshed after each window's category
    // upserts: a window can carry reservations without a usable category
    // array, and mapping those against an empty seed would null out
    // room_type_id on rows that had it right.
    const idByExternal: Record<string, string> = {};
    const { data: seedIdRows, error: seedIdErr } = await supabase
      .from("room_types")
      .select("id, external_room_type_id")
      .eq("hotel_id", hotelId);
    if (seedIdErr) return { ok: false, error: seedIdErr.message };
    for (const row of seedIdRows ?? []) {
      if (row.external_room_type_id && row.id) {
        idByExternal[String(row.external_room_type_id)] = String(row.id);
      }
    }
    let walkError: string | null = null;
    const deadlineAt = Date.now() + MEWS_SYNC_BUDGET_MS;

    const walk = await mewsWalkReservationWindows(
      resolved.creds,
      start,
      end,
      async ({ raw }) => {
        const parsed = parseMewsApiResponse(raw as Record<string, unknown>, {
          defaultRoomsPerCategory,
          hotelTimeZone,
        });

        if (parsed.roomTypes.length > 0) {
          // No is_active in the payload: the column list PostgREST is given
          // comes from these keys, so a category the owner excluded (or a
          // duplicate finding deactivated) is not resurrected and priced by the
          // next cron. New rows still take the schema default and come in active.
          const { rows: rtRows, merged: rtMerged } = dedupeByKey(
            parsed.roomTypes.map((rt) => ({
              hotel_id: hotelId,
              external_room_type_id: rt.external_room_type_id,
              name: rt.name,
              display_name: rt.display_name,
              total_rooms: rt.total_rooms,
            })),
            (r) => `${r.hotel_id}:${r.external_room_type_id}`,
          );
          duplicateRoomTypeRowsMerged += rtMerged;
          roomTypesUpserted += rtRows.length;
          const { error: rtErr } = await supabase
            .from("room_types")
            .upsert(rtRows, { onConflict: "hotel_id,external_room_type_id" });
          if (rtErr) {
            walkError = rtErr.message;
            return false;
          }
          const { data: idRows, error: idErr } = await supabase
            .from("room_types")
            .select("id, external_room_type_id")
            .eq("hotel_id", hotelId);
          if (idErr) {
            walkError = idErr.message;
            return false;
          }
          for (const row of idRows ?? []) {
            if (row.external_room_type_id && row.id) {
              idByExternal[String(row.external_room_type_id)] = String(row.id);
            }
          }
        }

        for (const key of Object.keys(stats) as (keyof typeof stats)[]) {
          stats[key] += parsed.stats[key] ?? 0;
        }
        for (const id of parsed.canceledExternalIds) canceledIds.add(id);

        if (parsed.reservations.length > 0) {
          const allRes = parsed.reservations.map((r) => ({
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
          if (diffed.error) {
            walkError = diffed.error.message;
            return false;
          }
          const resRows = diffed.rows;
          unchangedRowsSkipped += diffed.unchanged;
          reservationRowsUpserted += resRows.length;
          const UP_CHUNK = 500;
          for (let i = 0; i < resRows.length; i += UP_CHUNK) {
            const { error: resErr } = await supabase
              .from("reservations")
              .upsert(resRows.slice(i, i + UP_CHUNK), {
                onConflict: "hotel_id,external_reservation_id,stay_date",
              });
            if (resErr) {
              walkError = resErr.message;
              return false;
            }
          }
          for (const r of parsed.reservations) {
            if (!activeNights.has(r.external_reservation_id)) {
              activeNights.set(r.external_reservation_id, new Set());
            }
            activeNights.get(r.external_reservation_id)!.add(r.stay_date);
          }
        }

        return Date.now() < deadlineAt;
      },
      { timeFilter: incremental ? "Updated" : undefined, fromIndex: sweepFromIndex },
    );
    if (walkError) return { ok: false, error: walkError };
    const truncated = !walk.completed;

    // Reconciles are scoped to what THIS invocation fetched — per-reservation
    // deletes for the nights and ids it saw — so running them on a mid-flight
    // sweep chunk is safe; earlier chunks reconciled their own.
    const canceledDel = await deleteCanceledReservationRows(supabase, hotelId, [...canceledIds]);
    if (canceledDel.error) return { ok: false, error: canceledDel.error.message };
    const staleDel = await deleteStaleStayNightsForActiveReservations(
      supabase,
      hotelId,
      activeNights,
    );
    if (staleDel.error) return { ok: false, error: staleDel.error.message };

    if (resolved.connectionId) {
      const nowIso = new Date().toISOString();
      const { error: pcErr } = await supabase
        .from("pms_connections")
        .update({
          status: "connected",
          last_sync_at: nowIso,
          last_tested_at: nowIso,
          updated_at: nowIso,
          // Same watermark discipline as Cloudbeds: advance only on a covered
          // window, stamped from when the SWEEP began so anything updated while
          // it ran lands in the next incremental pull.
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
          ...(checkpointable && truncated
            ? {
                full_sweep_after_id: String(walk.lastIndex),
                full_sweep_started_at: (sweepStartedAt ?? runStartedAt).toISOString(),
              }
            : {}),
          // Cleared by ANY completed full run, not just checkpointable ones: a
          // finished explicit-window run advances the watermark past whatever
          // sweep was mid-flight, and resuming that stale grid later would just
          // stamp an old watermark and force a redundant second sweep.
          ...(!truncated && !incremental
            ? { full_sweep_after_id: null, full_sweep_started_at: null }
            : {}),
        })
        .eq("id", resolved.connectionId);
      if (pcErr) {
        console.error("pms_connections status update failed:", pcErr.message);
      }
    }

    return {
      ok: true,
      fetchWindowUtc: { start, end },
      windowFullyCovered: !truncated,
      apiWindows: walk.windowsFetched,
      roomTypesUpserted,
      reservationRowsUpserted,
      ingest: {
        duplicateRoomTypeRowsMerged,
        unchangedRowsSkipped,
        canceledReservationCount: canceledIds.size,
        ...stats,
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
