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
  cloudbedsGetReservationsWithRateDetailsPage,
  cloudbedsTimestamp,
  cloudbedsGetRoomTypes,
  cloudbedsGetTaxesAndFees,
  CloudbedsHttpError,
  type CloudbedsReservation,
} from "./client.ts";
import {
  isAuthRevocation,
  markConnectionDisconnected,
} from "../pms/connection-health.ts";
import { raiseAlert } from "../pms/alerting.ts";
import {
  CLOUDBEDS_SYNC_BUDGET_MS,
  CLOUDBEDS_INCREMENTAL_OVERLAP_MS,
  CLOUDBEDS_FULL_SYNC_INTERVAL_MS,
  defaultCloudbedsBaseUrl,
  CLOUDBEDS_ACTIVE_STATUSES,
  CLOUDBEDS_CANCELED_STATUSES,
  CLOUDBEDS_RATE_DETAILS_PAGE_SIZE,
} from "./constants.ts";
import {
  cloudbedsRateDetailsToDetail,
  cloudbedsRoomRowIds,
  cloudbedsRoomSlots,
  cloudbedsStayDates,
  parseCloudbedsReservationDetail,
  parseCloudbedsRoomTypes,
} from "./etl.ts";
import type { CloudbedsParsedReservationRow, CloudbedsResolvedCredentials } from "./types.ts";
import { mwsEnv } from "../mews/env.ts";
import { persistPropertyId, resolveOAuthCredentials } from "../pms/oauth-credentials.ts";
import { proposeCountsAsRoom } from "../onboarding/analysis.ts";
import { dropUnchangedReservationRows } from "../pms/row-diff.ts";
import { decideSyncWindow } from "../pms/sync-mode.ts";
import { installCloudbedsRequestLogging } from "./request-log.ts";

const RECONCILE_IN_CHUNK = 200;
const PAGE_GUARD = 1000;
const DEFAULT_BACK = 30;
const DEFAULT_FORWARD = 396;
const MAX_BACK = 365;
const MAX_FORWARD = 730;

/**
 * Bookings one check-out slice may hold before the sweep narrows it. Ten
 * pages: at the latency measured for full rate-details pages that is well
 * inside one budget, so a slice always finishes and the cursor always moves.
 */
const SLICE_TARGET_BOOKINGS = 1000;
/** Upper bound on slices in one run, however narrow they get. */
const SLICE_GUARD = 800;
/** How far past the last check-in date an open-ended slice is assumed to reach, for sizing only. */
const OPEN_SLICE_REACH_DAYS = 31;
/** Marks a checkpoint as a check-out date, so neither path misreads the other's cursor. */
const CHECKOUT_CURSOR_PREFIX = "checkout:";
/**
 * Marks a per-booking sweep whose active pass is done and whose cancellation
 * pass ran out of time after the booking id that follows.
 */
const CANCEL_CURSOR_PREFIX = "cancel:";

type Json = Record<string, unknown>;

/** A write failed inside the sweep's slice callback; the run stops with it. */
class WindowWriteError extends Error {}

export type CloudbedsSyncOptions = {
  daysBack?: number;
  daysForward?: number;
  /**
   * Absolute time (ms) the run must stop reading by, when the caller has a
   * wall clock of its own (a scheduled invocation, an API route). The run
   * still never exceeds CLOUDBEDS_SYNC_BUDGET_MS.
   */
  deadlineAt?: number;
};

export type CloudbedsSyncSuccess = {
  ok: true;
  /** False when the budget expired before the window was covered. */
  windowFullyCovered: boolean;
  /**
   * The checkpoint a truncated sweep left for the next run to resume from, or
   * null once the window is covered. Callers that loop until covered compare
   * it between runs to tell a slow sweep from a stuck one.
   */
  sweepCursor: string | null;
  /** Resolved, ready-to-use credentials (reused by the rate-push step). */
  creds: CloudbedsResolvedCredentials;
  fetchWindow: { checkInFrom: string; checkInTo: string };
  apiPages: number;
  roomTypesUpserted: number;
  reservationRowsUpserted: number;
  /** Room-nights this run read inside the window, written or already current. */
  windowRows: number;
  /** Earliest and latest stay night among them. */
  stayDates: { oldest: string | null; newest: string | null };
  ingest: {
    /** Which reservation source this run used. */
    source: "rate_details" | "per_booking";
    /** Why rate details was refused and the per-booking path ran instead. */
    rateDetailsRefused: string | null;
    reservationsDetailFetched: number;
    reservationsDetailFailed: number;
    canceledReservationsSeen: number;
    canceledRowIdsDeleted: number;
    canceledDetailFailed: number;
    canceledStatusListFailures: number;
    /** Active bookings the check-out filter returned whose check-in falls outside the window. */
    bookingsOutsideWindow: number;
    /** Bookings in a status that neither holds a room nor releases one. */
    bookingsWithUnknownStatus: number;
    duplicateStayNightKeysMerged: number;
    rowsWithMissingRate: number;
    unchangedRowsSkipped: number;
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

function addDaysYmd(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
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

function isActiveStatus(status: string | null): boolean {
  if (!status) return false;
  return (CLOUDBEDS_ACTIVE_STATUSES as readonly string[]).includes(status.trim().toLowerCase());
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
 * rejected status value can't fail the sync — the set once carried a spelling
 * the live API refuses, and an account that refuses one status should cost a
 * red row in its log, not every cancellation it has.
 */
async function listCanceledReservations(
  creds: CloudbedsResolvedCredentials,
  checkInFrom: string,
  checkInTo: string,
  /** Same watermark as the active pull: a cancellation IS a modification. */
  modifiedFrom?: string,
  deadlineAt: number = Infinity,
): Promise<{ items: CloudbedsReservation[]; pages: number; statusesFailed: number; truncated: boolean }> {
  const items: CloudbedsReservation[] = [];
  let pages = 0;
  let statusesFailed = 0;

  for (const status of CLOUDBEDS_CANCELED_STATUSES) {
    let pageNumber = 1;
    try {
      for (let guard = 0; guard < PAGE_GUARD; guard += 1) {
        if (Date.now() > deadlineAt) return { items, pages, statusesFailed, truncated: true };
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

  return { items, pages, statusesFailed, truncated: false };
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
 * The statuses a healthy run is allowed to turn back into 'connected'.
 *
 * 'pending' is a Marketplace property nobody has paid for yet; only activation
 * makes it live. 'disconnected' means the grant was withdrawn. A sync that
 * happens to succeed proves neither of those has changed — and the import
 * worker runs this same sync, so an unconditional stamp put an unpaid property
 * into the five-minute scheduler on its very first pass.
 */
const SYNC_MAY_MARK_CONNECTED = ["connected", "degraded", "error"];

/**
 * Stamp a finished run on the connection row.
 *
 * The status condition lives in the UPDATE, not in a read beforehand: an
 * activation or a disconnect that lands while the run is in flight must win,
 * and a status read at the start of a three-minute sweep is long stale by the
 * end of it. A row the condition skips still gets the watermark and checkpoint
 * — without them the next run would redo this one's work.
 */
async function stampConnection(
  supabase: SupabaseClient,
  connectionId: string,
  stamp: Record<string, unknown>,
): Promise<{ message: string } | null> {
  const { data, error } = await supabase
    .from("pms_connections")
    .update({ ...stamp, status: "connected" })
    .eq("id", connectionId)
    .in("status", SYNC_MAY_MARK_CONNECTED)
    .select("id");
  if (error) return error;
  if ((data ?? []).length > 0) return null;
  const { error: stampErr } = await supabase
    .from("pms_connections")
    .update(stamp)
    .eq("id", connectionId);
  return stampErr;
}

export type SyncMode = {
  incremental: boolean;
  /** Passed to Cloudbeds as modifiedFrom. Undefined means sweep everything. */
  modifiedFrom: string | undefined;
  reason: "first_run" | "full_sweep_due" | "window_requested" | "incremental";
};

/**
 * The shared decision (pms/sync-mode.ts), spelled the way Cloudbeds's wire
 * wants it — modifiedFrom in their space-separated timestamp format.
 */
export function decideSyncMode(args: {
  now: Date;
  watermark: Date | null;
  lastFullSyncAt: Date | null;
  windowRequested: boolean;
  overlapMs: number;
  fullSweepIntervalMs: number;
}): SyncMode {
  const decision = decideSyncWindow(args);
  return {
    incremental: decision.incremental,
    modifiedFrom: decision.modifiedSince ? cloudbedsTimestamp(decision.modifiedSince) : undefined,
    reason: decision.reason,
  };
}

/**
 * The order a multi-tick per-booking sweep walks reservations in — and
 * therefore what its cursor means. Cloudbeds ids are numeric strings, so
 * shorter-before-longer then lexicographic sorts them numerically without ever
 * parsing; anything non-numeric still gets a total, stable order, which is all
 * resume needs.
 */
export function sweepIdCompare(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * One DELETE per reservation here was most of a sync's round trips, spent on
 * rows that almost never exist — a booking only sheds nights when its dates
 * shrink. So read the stored nights back, diff against the active set, and
 * delete just the leftovers, grouped by night so a date change costs one
 * statement instead of one per booking.
 */
async function deleteStaleStayNights(
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

/* ── Writing the window ──────────────────────────────────────────────────── */

type BookingKind = "active" | "canceled" | "outside" | "unknown";

/**
 * Everything a run writes, fed a batch of bookings at a time.
 *
 * Only keys survive between batches: each active booking's stored nights and
 * each canceled booking's row ids. Payloads are parsed, diffed, written and
 * dropped per batch, so a full sweep of a large book no longer holds every
 * booking, every parsed row and every write payload at once.
 *
 * A booking read again in a later batch replaces what the earlier read said,
 * the way the one-pass sweep kept only the last copy of each booking: its
 * nights are taken from the newer read, and a booking that turned canceled
 * loses the nights the earlier batch wrote. Cancellations are deleted once,
 * at the end, and never for an id the run holds as active, so a booking
 * canceled in one batch and live again in the next keeps its rows (and the
 * base_rate the trigger pinned on their first insert).
 */
function createWindowWriter(supabase: SupabaseClient, hotelId: string, idByExternal: Record<string, string>) {
  const latest = new Map<string, BookingKind>();
  const extIdsByRid = new Map<string, string[]>();
  const canceledIdsByRid = new Map<string, string[]>();
  const looseCanceled = new Set<string>();
  const activeNights = new Map<string, Set<string>>();
  const stats = {
    upserted: 0,
    unchanged: 0,
    duplicateKeys: 0,
    missingRate: 0,
    canceledSeen: 0,
    outsideWindow: 0,
    unknownStatus: 0,
    activeBookings: 0,
    writeMs: 0,
    writtenRows: 0,
  };

  async function writeActive(entries: { rid: string; detail: Json }[]): Promise<{ message: string } | null> {
    const allRows: CloudbedsParsedReservationRow[] = [];
    for (const { rid, detail } of entries) {
      const rows = parseCloudbedsReservationDetail(detail).rows;
      allRows.push(...rows);
      extIdsByRid.set(rid, [...new Set(rows.map((r) => r.external_reservation_id))]);
    }
    // Dedupe to the reservations unique key (external_reservation_id, stay_date).
    const byKey = new Map<string, CloudbedsParsedReservationRow>();
    for (const r of allRows) byKey.set(`${r.external_reservation_id}:${r.stay_date}`, r);
    const rows = [...byKey.values()];
    stats.duplicateKeys += allRows.length - rows.length;
    stats.missingRate += rows.filter((r) => r.current_rate === null).length;
    for (const r of rows) {
      if (!activeNights.has(r.external_reservation_id)) activeNights.set(r.external_reservation_id, new Set());
      activeNights.get(r.external_reservation_id)!.add(r.stay_date);
    }
    if (rows.length === 0) return null;

    // current_rate is the room's own nightly rate from its first write, and
    // that matters beyond this row: the reservations_sync_base_rate trigger
    // copies it into base_rate on INSERT and never lets it change afterwards.
    const allRes = rows.map((r) => ({
      hotel_id: hotelId,
      external_reservation_id: r.external_reservation_id,
      room_type_id: r.external_room_type_id ? idByExternal[r.external_room_type_id] ?? null : null,
      stay_date: r.stay_date,
      booking_date: r.booking_date,
      booking_window_days: r.booking_window_days,
      current_rate: r.current_rate,
      raw_payload: r.raw_payload,
    }));
    const started = Date.now();
    // Most of a full sweep is rows that didn't move; writing them anyway is
    // WAL, realtime messages, and vacuum work for nothing.
    const diffed = await dropUnchangedReservationRows(supabase, hotelId, allRes);
    if (diffed.error) return diffed.error;
    stats.unchanged += diffed.unchanged;
    stats.upserted += diffed.rows.length;

    // Chunked upsert — a busy hotel produces thousands of room-nights.
    const UP_CHUNK = 500;
    for (let i = 0; i < diffed.rows.length; i += UP_CHUNK) {
      const { error: resErr } = await supabase
        .from("reservations")
        .upsert(diffed.rows.slice(i, i + UP_CHUNK), {
          onConflict: "hotel_id,external_reservation_id,stay_date",
        });
      if (resErr) return resErr;
    }

    // Prune stale nights for the bookings just written (date/rate changes).
    const touched = new Map<string, Set<string>>();
    for (const r of rows) touched.set(r.external_reservation_id, activeNights.get(r.external_reservation_id)!);
    const staleDel = await deleteStaleStayNights(supabase, hotelId, touched);
    if (staleDel.error) return staleDel.error;
    stats.writeMs += Date.now() - started;
    stats.writtenRows += allRes.length;
    return null;
  }

  function forget(rid: string): void {
    const prior = latest.get(rid);
    if (prior === "active") {
      stats.activeBookings -= 1;
      for (const extId of extIdsByRid.get(rid) ?? []) activeNights.delete(extId);
      extIdsByRid.delete(rid);
    } else if (prior === "canceled") {
      stats.canceledSeen -= 1;
      canceledIdsByRid.delete(rid);
    } else if (prior === "outside") {
      stats.outsideWindow -= 1;
    } else if (prior === "unknown") {
      stats.unknownStatus -= 1;
    }
  }

  return {
    stats,
    activeNights,
    /** Rate-details bookings: classify, then write the active ones. */
    async applyRateDetails(
      bookings: Map<string, Json>,
      checkInFrom: string,
      checkInTo: string,
    ): Promise<{ message: string } | null> {
      const active: { rid: string; detail: Json }[] = [];
      for (const [rid, row] of bookings) {
        forget(rid);
        const detail = cloudbedsRateDetailsToDetail(row);
        const status = typeof detail.status === "string" ? detail.status : null;
        if (isCanceledStatus(status)) {
          // Wherever its dates now fall: a canceled booking should hold no nights.
          stats.canceledSeen += 1;
          latest.set(rid, "canceled");
          canceledIdsByRid.set(rid, rowIdsForReservation(rid, detail));
          continue;
        }
        if (!isActiveStatus(status)) {
          stats.unknownStatus += 1;
          latest.set(rid, "unknown");
          continue;
        }
        const { checkIn } = cloudbedsStayDates(row);
        if (!checkIn || checkIn < checkInFrom || checkIn > checkInTo) {
          stats.outsideWindow += 1;
          latest.set(rid, "outside");
          continue;
        }
        stats.activeBookings += 1;
        latest.set(rid, "active");
        active.push({ rid, detail });
      }
      return writeActive(active);
    },
    /** Per-booking path: details already filtered to active bookings. */
    async applyDetails(details: Json[]): Promise<{ message: string } | null> {
      const entries = details.map((detail, i) => {
        const rid = parseCloudbedsReservationDetail(detail).reservationId ?? `__detail_${i}`;
        forget(rid);
        latest.set(rid, "active");
        stats.activeBookings += 1;
        return { rid, detail };
      });
      return writeActive(entries);
    },
    addCanceledIds(ids: Iterable<string>): void {
      for (const id of ids) looseCanceled.add(id);
    },
    /**
     * The run's cancellations. Never an id this run holds as booked: if a
     * status flipped between reads, the nights just confirmed win and the
     * next sync re-decides with a consistent read.
     */
    canceledIds(): string[] {
      const all = new Set(looseCanceled);
      for (const ids of canceledIdsByRid.values()) for (const id of ids) all.add(id);
      return [...all].filter((id) => !activeNights.has(id));
    },
    windowRows(): { count: number; oldest: string | null; newest: string | null } {
      let count = 0;
      let oldest: string | null = null;
      let newest: string | null = null;
      for (const dates of activeNights.values()) {
        count += dates.size;
        for (const d of dates) {
          if (!oldest || d < oldest) oldest = d;
          if (!newest || d > newest) newest = d;
        }
      }
      return { count, oldest, newest };
    },
  };
}

/* ── Reading the window ──────────────────────────────────────────────────── */

type WindowArgs = {
  creds: CloudbedsResolvedCredentials;
  checkInFrom: string;
  checkInTo: string;
  modifiedFrom: string | undefined;
  deadlineAt: number;
  /** Checkpoint from an earlier run of the same sweep, as stored. Null starts fresh. */
  storedCursor: string | null;
  checkpointable: boolean;
  /**
   * Called with the bookings read so far each time a check-out slice
   * completes (with the date it reached) and once at the end (with null),
   * so they are written and dropped instead of held for the whole sweep.
   */
  onBookings: (bookings: Map<string, Json>, reached: string | null) => Promise<void>;
  /** Estimated ms to write what has been read but not yet handed over. */
  pendingWriteMs: (pendingBookings: number) => number;
};

/** What one run read from the window, whichever source it came from. */
type WindowPull = {
  source: "rate_details" | "per_booking";
  /**
   * Active bookings inside the check-in window, in getReservation shape, for
   * a path that hands them over all at once. The rate-details path has
   * already passed its bookings to onBookings and leaves this empty.
   */
  details: Json[];
  /** Row ids of canceled and no-show bookings seen so far. */
  canceledRowIds: Set<string>;
  canceledSeen: number;
  detailFetched: number;
  detailFailed: number;
  bookingsOutsideWindow: number;
  bookingsWithUnknownStatus: number;
  pages: number;
  truncated: boolean;
  /** Checkpoint to store when truncated. */
  nextCursor: string | null;
  /**
   * The per-booking path lists cancellations separately, after the active rows
   * are written. Rate details has already seen them on the same pages.
   */
  listCancellations: (() => Promise<CancellationPass>) | null;
};

type CancellationPass = {
  pages: number;
  statusesFailed: number;
  detailFailed: number;
};

function parseCheckoutCursor(stored: string | null): string | null {
  if (!stored || !stored.startsWith(CHECKOUT_CURSOR_PREFIX)) return null;
  const day = stored.slice(CHECKOUT_CURSOR_PREFIX.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * The whole window from getReservationsWithRateDetails, a page of 100 bookings
 * per call.
 *
 * The server can only filter by check-out, so the sweep walks check-out dates:
 * everything checking out on or after the window's first check-in day comes
 * back (guests arriving in the window and guests already in the house), and
 * the check-in bound is applied here. Canceled and no-show bookings arrive on
 * the same pages, rooms and all, so no second pass is needed to find them.
 *
 * A very large book is split into consecutive check-out slices, each sized so
 * it finishes inside one budget, and the checkpoint is the check-out date the
 * last completed slice reached. Page numbers are never checkpointed: nothing
 * established that the endpoint returns pages in the same order on a later
 * call. Consecutive slices share their boundary day, so whether the upper
 * bound is inclusive or not no booking can fall between two of them.
 */
async function pullWithRateDetails(args: WindowArgs): Promise<WindowPull> {
  const { creds, checkInTo, checkInFrom, modifiedFrom, deadlineAt } = args;
  const resumeFrom = args.checkpointable ? parseCheckoutCursor(args.storedCursor) : null;
  const sizingHorizon = addDaysYmd(checkInTo, OPEN_SLICE_REACH_DAYS);

  const byId = new Map<string, Json>();
  let pages = 0;
  let pageMsTotal = 0;
  let truncated = false;
  let from = resumeFrom && resumeFrom > checkInFrom ? resumeFrom : checkInFrom;
  // Where this run started counts as the checkpoint until a slice completes,
  // so a run that finished none reports the same position twice and a caller
  // can see it is not moving.
  let reached = from;
  /** Null asks for everything from `from` on. */
  let width: number | null = null;

  sweep: for (let slice = 0; slice < SLICE_GUARD; slice += 1) {
    const to = width == null ? undefined : addDaysYmd(from, width);
    const openEnded = to === undefined || to >= sizingHorizon;
    const query = { checkOutFrom: from, checkOutTo: openEnded ? undefined : to, modifiedFrom };
    let sliceTotal: number | null = null;

    for (let pageNumber = 1; pageNumber <= PAGE_GUARD; pageNumber += 1) {
      // The budget covers writing what was read, not only reading it: a run
      // that reads right up to its deadline and then writes is a run that
      // gets killed before its writes finish.
      if (Date.now() + args.pendingWriteMs(byId.size) > deadlineAt) {
        truncated = true;
        break sweep;
      }
      const startedAt = Date.now();
      const page = await cloudbedsGetReservationsWithRateDetailsPage(creds, query, pageNumber);
      pages += 1;
      pageMsTotal += Date.now() - startedAt;
      for (const row of page.reservations) {
        const rid = reservationIdOf(row);
        if (rid) byId.set(rid, row);
      }
      if (pageNumber === 1 && page.total != null) {
        sliceTotal = page.total;
        const span = daysBetween(from, query.checkOutTo ?? sizingHorizon);
        const pagesStillToRead = Math.ceil(page.total / CLOUDBEDS_RATE_DETAILS_PAGE_SIZE) - 1;
        // Pages this run can still afford at the pace pages have actually
        // taken. A slice that cannot finish moves nothing, however much of it
        // was read, so a slow API has to mean smaller slices, not a stuck sweep.
        const affordable = Math.floor((deadlineAt - Date.now()) / Math.max(1, pageMsTotal / pages));
        const fits = page.total <= SLICE_TARGET_BOOKINGS && pagesStillToRead <= affordable;
        if (!fits && span > 1) {
          // What this page returned is kept; the slice is asked for again, narrower.
          const bookingsThatFit = Math.max(
            CLOUDBEDS_RATE_DETAILS_PAGE_SIZE,
            Math.min(SLICE_TARGET_BOOKINGS, Math.floor(affordable * 0.8) * CLOUDBEDS_RATE_DETAILS_PAGE_SIZE),
          );
          width = Math.max(1, Math.min(span - 1, Math.floor((span * bookingsThatFit) / page.total)));
          continue sweep;
        }
      }
      if (!page.hasMore) break;
    }

    if (query.checkOutTo === undefined) break;
    reached = query.checkOutTo;
    from = query.checkOutTo;
    // Written and checkpointed before the next slice is read.
    await args.onBookings(byId, reached);
    byId.clear();
    // Size the next slice from how full this one was, growing at most fourfold
    // so one sparse month cannot swallow a busy season whole.
    if (width != null && sliceTotal != null) {
      width = Math.max(1, Math.min(width * 4, Math.floor((width * SLICE_TARGET_BOOKINGS) / Math.max(sliceTotal, 1))));
    }
  }

  await args.onBookings(byId, null);
  byId.clear();

  return {
    source: "rate_details",
    details: [],
    canceledRowIds: new Set(),
    canceledSeen: 0,
    detailFetched: 0,
    detailFailed: 0,
    bookingsOutsideWindow: 0,
    bookingsWithUnknownStatus: 0,
    pages,
    truncated,
    nextCursor: truncated ? `${CHECKOUT_CURSOR_PREFIX}${reached}` : null,
    listCancellations: null,
  };
}

/**
 * The original path: list the window per status, then one getReservation per
 * booking. Kept only for a property whose account refuses rate details — at
 * 220ms a call it needs several runs for anything past a small hotel, which is
 * what the budget and the id checkpoint below are for.
 */
async function pullPerBooking(args: WindowArgs): Promise<WindowPull> {
  const { creds, checkInFrom, checkInTo, modifiedFrom, deadlineAt, checkpointable } = args;
  const stored = args.storedCursor;
  // A sweep whose active pass already finished and whose cancellation pass
  // ran out of time: skip straight to the cancellations, after that id.
  const cancelCursor =
    checkpointable && stored && stored.startsWith(CANCEL_CURSOR_PREFIX)
      ? stored.slice(CANCEL_CURSOR_PREFIX.length)
      : null;
  const sweepCursor =
    checkpointable && stored && !stored.startsWith(CHECKOUT_CURSOR_PREFIX) && cancelCursor === null
      ? stored
      : null;

  const listed = cancelCursor !== null
    ? { reservations: [] as CloudbedsReservation[], pages: 0, truncated: false }
    : await cloudbedsGetReservationsRange(
        creds,
        checkInFrom,
        checkInTo,
        CLOUDBEDS_ACTIVE_STATUSES,
        modifiedFrom,
        deadlineAt,
      );
  const { reservations: listItems, pages } = listed;

  // A sweep bigger than one budget finishes across several ticks, so its
  // order has to be one every tick agrees on — the API's own ordering is
  // whatever it feels like today. Sorted by id, "resume" is just "skip
  // everything at or below the cursor".
  if (checkpointable) {
    listItems.sort((a, b) => sweepIdCompare(reservationIdOf(a) ?? "", reservationIdOf(b) ?? ""));
  }

  const seenResIds = new Set<string>();
  const details: Json[] = [];
  const canceledRowIds = new Set<string>();
  let detailFetched = 0;
  let detailFailed = 0;
  let canceledSeen = 0;
  // A listing cut off by the deadline has read no details yet: the run stops
  // where it is and the next one lists again from its checkpoint.
  let truncated = listed.truncated === true;
  // Advances past failures too: a booking whose detail call keeps 500ing must
  // not wedge the sweep on itself forever — the next daily sweep retries it.
  let sweepReachedId: string | null = null;

  for (const item of truncated ? [] : listItems) {
    if (Date.now() > deadlineAt) {
      truncated = true;
      break;
    }
    const rid = reservationIdOf(item);
    if (!rid || seenResIds.has(rid)) continue;
    // Resume: everything at or below the cursor was covered by an earlier
    // tick of this same sweep.
    if (sweepCursor && sweepIdCompare(rid, sweepCursor) <= 0) continue;
    seenResIds.add(rid);
    const detail = await cloudbedsGetReservationDetail(creds, rid);
    sweepReachedId = rid;
    if (!detail) {
      detailFailed += 1;
      continue;
    }
    detailFetched += 1;
    const status = parseCloudbedsReservationDetail(detail).status;
    // The list was filtered to active statuses server-side, but a booking can
    // cancel between that page and this detail call — the detail is newer.
    if (isCanceledStatus(status)) {
      canceledSeen += 1;
      for (const id of rowIdsForReservation(rid, detail)) canceledRowIds.add(id);
      continue;
    }
    details.push(detail);
  }

  const pull: WindowPull = {
    source: "per_booking",
    details,
    canceledRowIds,
    canceledSeen,
    detailFetched,
    detailFailed,
    bookingsOutsideWindow: 0,
    bookingsWithUnknownStatus: 0,
    pages,
    truncated,
    nextCursor: truncated ? sweepReachedId ?? sweepCursor : null,
    listCancellations: null,
  };

  // A mid-flight sweep chunk skips the cancellation pass: it is unbudgeted
  // API work that would repeat on every chunk, and the completing chunk runs
  // it once for the whole sweep. Cancelled rows sit a few extra ticks; they
  // were already stale for however long the property waited to sync at all.
  if (!(truncated && checkpointable)) {
    pull.listCancellations = async () => {
      // Cancelling a booking modifies it, so the same watermark applies — and
      // the rows for anything cancelled before it were already removed on the
      // run that saw it.
      const canceledList = await listCanceledReservations(
        creds,
        checkInFrom,
        checkInTo,
        modifiedFrom,
        deadlineAt,
      );
      let canceledDetailFailed = 0;
      // Resumable only in a fixed order, the same one the active pass uses.
      if (checkpointable) {
        canceledList.items.sort((a, b) => sweepIdCompare(reservationIdOf(a) ?? "", reservationIdOf(b) ?? ""));
      }
      let cancelReached: string | null = cancelCursor;
      // A cut-off listing is only partly known, so it can be worked through
      // but not checkpointed past: the next run lists it again.
      let stoppedEarly = canceledList.truncated;
      for (const item of canceledList.items) {
        const rid = reservationIdOf(item);
        if (!rid || seenResIds.has(rid)) continue;
        if (cancelCursor && sweepIdCompare(rid, cancelCursor) <= 0) continue;
        if (Date.now() > deadlineAt) {
          stoppedEarly = true;
          break;
        }
        seenResIds.add(rid);
        if (!canceledList.truncated) cancelReached = rid;
        const detail = await cloudbedsGetReservationDetail(creds, rid);
        if (!detail) {
          // The list said canceled, so clear what the list item itself names —
          // the parent id plus whatever rooms[] it carries. A list item that names
          // no rooms leaves rooms 2..n of a multi-room cancellation behind until a
          // run whose detail call succeeds. (cloudbedsGetReservationDetail returns
          // null for a 5xx or timeout too, not only a genuinely missing booking.)
          canceledDetailFailed += 1;
          pull.canceledSeen += 1;
          for (const id of rowIdsForReservation(rid, item)) pull.canceledRowIds.add(id);
          continue;
        }
        const status = parseCloudbedsReservationDetail(detail).status;
        // Reinstated between the list page and here — leave its rows alone and let
        // the next sync pick it up as active. A detail payload with no status at all
        // does not overrule the list, which said canceled.
        if (status && !isCanceledStatus(status)) continue;
        pull.canceledSeen += 1;
        for (const id of rowIdsForReservation(rid, detail)) pull.canceledRowIds.add(id);
      }
      if (stoppedEarly) {
        // The run reports itself truncated so the watermark stays put. A
        // checkpointed sweep resumes the cancellations where they stopped
        // instead of redoing its whole active pass.
        pull.truncated = true;
        pull.nextCursor = checkpointable ? `${CANCEL_CURSOR_PREFIX}${cancelReached ?? ""}` : null;
      }
      return {
        pages: canceledList.pages,
        statusesFailed: canceledList.statusesFailed,
        detailFailed: canceledDetailFailed,
      };
    };
  }

  return pull;
}

/**
 * Whether rate details said no in words, rather than being unreachable.
 *
 * An account can lack the endpoint or a scope it needs, and Cloudbeds answer
 * that with a success:false body or a 4xx. That is a fact about the property,
 * so the sync carries on the slow way instead of stopping. A revoked grant,
 * throttling, a 5xx or a timeout is not: those fail the run as before, and the
 * next run tries rate details again.
 */
function rateDetailsRefused(error: unknown): error is CloudbedsHttpError {
  if (!(error instanceof CloudbedsHttpError)) return false;
  if (error.status === 429 || error.status >= 500 || error.status < 400) return false;
  return !isAuthRevocation(error.status, error.message);
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
      return {
        ok: false,
        error:
          "Could not resolve Cloudbeds propertyID. getHotels returned no properties, or " +
          "returned several — a group grant covers the whole group, so the property has to " +
          "be chosen deliberately rather than guessed. Reconnect from the Cloudbeds Marketplace.",
      };
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
      // Default counts_as_room for types nobody has classified yet. Separate
      // from the upsert on purpose: written there it would overwrite the
      // owner's answer every tick. "sync" mode: only ever writes `true` —
      // nobody is on the review screen to correct a guessed `false`.
      await proposeCountsAsRoom(supabase, hotelId, rtRows, "sync");
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

    // 6. Reservations for the check-in window, one row per room per night at
    //    that room's own nightly rate. See pullWithRateDetails.
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
      .select(
        "reservations_modified_through, last_full_sync_at, full_sweep_after_id, full_sweep_started_at",
      )
      .eq("hotel_id", hotelId)
      .eq("pms_type", "cloudbeds")
      .maybeSingle();

    const watermark = syncState?.reservations_modified_through
      ? new Date(String(syncState.reservations_modified_through))
      : null;
    const lastFull = syncState?.last_full_sync_at
      ? new Date(String(syncState.last_full_sync_at))
      : null;
    // An explicit window is a deliberate re-read of a period, so honour it in
    // full rather than filtering it down to what changed.
    const windowRequested = options?.daysBack != null || options?.daysForward != null;
    const { incremental, modifiedFrom } = decideSyncMode({
      now: runStartedAt,
      watermark,
      lastFullSyncAt: lastFull,
      windowRequested,
      overlapMs: CLOUDBEDS_INCREMENTAL_OVERLAP_MS,
      fullSweepIntervalMs: CLOUDBEDS_FULL_SYNC_INTERVAL_MS,
    });

    // Only on a full sweep. A property's tax configuration does not change
    // every five minutes, and calling it on every tick made a scope the
    // property has not granted look like a 5% failure rate across the whole
    // integration — the health classifier reads the request log, so a call we
    // expect to fail would permanently show every hotel as degraded.
    if (!incremental) {
      const taxes = await cloudbedsGetTaxesAndFees(creds);
      console.log(
        JSON.stringify({
          fn: "runCloudbedsSyncForHotel",
          step: "taxes_and_fees",
          hotelId,
          ...(taxes.ok ? { taxCount: taxes.taxes.length } : { unavailable: taxes.reason }),
        }),
      );
    }

    // Only the SCHEDULED full sweep checkpoints. An explicit window is a
    // one-shot re-read someone asked for, and incremental pulls are small
    // enough that resuming them buys nothing.
    const checkpointable = !incremental && !windowRequested;
    const storedCursor =
      checkpointable && syncState?.full_sweep_after_id
        ? String(syncState.full_sweep_after_id)
        : null;
    const sweepStartedAt =
      checkpointable && syncState?.full_sweep_started_at
        ? new Date(String(syncState.full_sweep_started_at))
        : null;

    // A budget, so a property too big for one run stops deliberately with what
    // it has and says so, rather than being killed with nothing written. Being
    // killed mid-loop used to mean the upsert below never ran and NOTHING was
    // written: such a hotel had no reservation data at all, re-attempted and
    // re-failed every five minutes, forever.
    const writer = createWindowWriter(supabase, hotelId, idByExternal);
    const sweepAnchor = (sweepStartedAt ?? runStartedAt).toISOString();
    let writeFailure: { message: string } | null = null;
    const windowArgs: WindowArgs = {
      creds,
      checkInFrom,
      checkInTo,
      modifiedFrom,
      deadlineAt: Math.min(Date.now() + CLOUDBEDS_SYNC_BUDGET_MS, options?.deadlineAt ?? Infinity),
      storedCursor,
      checkpointable,
      onBookings: async (bookings, reached) => {
        if (writeFailure || bookings.size === 0) return;
        writeFailure = await writer.applyRateDetails(bookings, checkInFrom, checkInTo);
        if (writeFailure) throw new WindowWriteError(writeFailure.message);
        // A slice is only checkpointed once its rows are written, so a run
        // killed after this point resumes past work that is really done.
        if (reached && checkpointable && connRow?.id) {
          const { error: cpErr } = await supabase
            .from("pms_connections")
            .update({ full_sweep_after_id: `${CHECKOUT_CURSOR_PREFIX}${reached}`, full_sweep_started_at: sweepAnchor })
            .eq("id", String(connRow.id));
          if (cpErr) console.error("cloudbeds sweep checkpoint failed:", cpErr.message);
        }
      },
      pendingWriteMs: (pending) => {
        const rowsPerBooking = writer.stats.activeBookings > 0
          ? writer.stats.writtenRows / Math.max(1, writer.stats.activeBookings)
          : 3;
        const msPerRow = writer.stats.writtenRows > 0 ? writer.stats.writeMs / writer.stats.writtenRows : 2;
        return pending * rowsPerBooking * msPerRow;
      },
    };

    let rateDetailsRefusal: string | null = null;
    let pull: WindowPull;
    try {
      pull = await pullWithRateDetails(windowArgs);
    } catch (error) {
      if (error instanceof WindowWriteError) return { ok: false, error: error.message };
      if (!rateDetailsRefused(error)) throw error;
      rateDetailsRefusal = error.message.slice(0, 300);
      console.error(
        JSON.stringify({
          fn: "runCloudbedsSyncForHotel",
          hotelId,
          warning: "getReservationsWithRateDetails refused for this property; syncing with one " +
            "getReservation per booking instead, which is far slower and may need several runs",
          status: error.status,
          refusal: rateDetailsRefusal,
        }),
      );
      await raiseAlert(supabase, {
        severity: "warn",
        key: `cloudbeds_rate_details_refused:${hotelId}`,
        title: "Cloudbeds refused rate details; syncing per booking",
        detail: rateDetailsRefusal,
        hotelId,
      });
      pull = await pullPerBooking(windowArgs);
    }

    if (pull.details.length > 0) {
      const err = await writer.applyDetails(pull.details);
      if (err) return { ok: false, error: err.message };
    }
    // The per-booking path hands its active details over at the end; they go
    // through the same writer, so both sources end in the same place.

    const bookingsWithUnknownStatus = pull.bookingsWithUnknownStatus + writer.stats.unknownStatus;
    if (bookingsWithUnknownStatus > 0) {
      console.warn(
        JSON.stringify({
          fn: "runCloudbedsSyncForHotel",
          hotelId,
          warning: "bookings in a status that neither holds nor releases a room were left as stored",
          count: bookingsWithUnknownStatus,
        }),
      );
    }

    const reservationRowsUpserted = writer.stats.upserted;
    const unchangedRowsSkipped = writer.stats.unchanged;
    const duplicateStayNightKeysMerged = writer.stats.duplicateKeys;
    const rowsWithMissingRate = writer.stats.missingRate;
    const window = writer.windowRows();

    // Cancellations drop out of every active listing, so without this their
    // room-nights stay in `reservations` forever and keep counting as booked.
    //
    // The per-booking path lists them only now, after the upsert, on purpose:
    // that pass hits the API again, and anything that isn't a rejected status
    // spelling rethrows. Fetching it first meant a 503 or an expired token on
    // THIS list threw away the active room-nights already parsed above. Failing
    // after the upsert still reports ok:false; it just doesn't discard good data.
    const cancellations = pull.listCancellations
      ? await pull.listCancellations()
      : { pages: 0, statusesFailed: 0, detailFailed: 0 };
    writer.addCanceledIds(pull.canceledRowIds);

    const canceledIds = writer.canceledIds();
    const canceledDel = await deleteCanceledReservationRows(supabase, hotelId, canceledIds);
    if (canceledDel.error) return { ok: false, error: canceledDel.error.message };

    const truncated = pull.truncated;
    // What a truncated sweep leaves for the next run. A chunk that completed no
    // slice keeps the checkpoint it resumed from rather than forgetting it.
    const savedCursor = checkpointable && truncated ? pull.nextCursor ?? storedCursor : null;

    // 7. Stamp connection status.
    if (connRow?.id) {
      const nowIso = new Date().toISOString();
      const pcErr = await stampConnection(supabase, String(connRow.id), {
        last_sync_at: nowIso,
        last_tested_at: nowIso,
        updated_at: nowIso,
        // Advance ONLY on a run that covered its window. A truncated run
        // stopped partway through, so moving the watermark past the bookings
        // it never reached would skip them permanently — the next incremental
        // pull would ask for changes since a moment it never actually finished
        // reading.
        //
        // Stamped with when the SWEEP started, not now: a checkpointed sweep
        // spans several ticks, and anything modified during any of them has
        // to fall inside the next incremental pull's range. For a single-tick
        // run that is just this run's own start.
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
        // The checkpoint itself: a truncated sweep records how far it got and
        // when the whole thing began; a completed one clears both so the next
        // daily sweep starts fresh.
        ...(checkpointable && truncated
          ? {
              full_sweep_after_id: savedCursor,
              full_sweep_started_at: (sweepStartedAt ?? runStartedAt).toISOString(),
            }
          : {}),
        // Cleared by ANY completed full run: a finished explicit-window run
        // advances the watermark past a mid-flight sweep's anchor, and
        // resuming that stale cursor later would stamp an old watermark and
        // force a redundant second sweep.
        ...(!truncated && !incremental
          ? { full_sweep_after_id: null, full_sweep_started_at: null }
          : {}),
      });
      if (pcErr) console.error("cloudbeds pms_connections status update failed:", pcErr.message);
    }

    return {
      ok: true,
      creds,
      // False when the budget ran out before the window was covered. A partial
      // sync that looks complete is worse than one that says so: the next tick
      // picks up where this stopped, but only if someone can tell.
      windowFullyCovered: !truncated,
      sweepCursor: savedCursor,
      fetchWindow: { checkInFrom, checkInTo },
      apiPages: pull.pages + cancellations.pages,
      roomTypesUpserted,
      reservationRowsUpserted,
      windowRows: window.count,
      stayDates: { oldest: window.oldest, newest: window.newest },
      ingest: {
        source: pull.source,
        rateDetailsRefused: rateDetailsRefusal,
        reservationsDetailFetched: pull.source === "rate_details" ? writer.stats.activeBookings : pull.detailFetched,
        reservationsDetailFailed: pull.detailFailed,
        canceledReservationsSeen: pull.canceledSeen + writer.stats.canceledSeen,
        canceledRowIdsDeleted: canceledIds.length,
        canceledDetailFailed: cancellations.detailFailed,
        canceledStatusListFailures: cancellations.statusesFailed,
        bookingsOutsideWindow: pull.bookingsOutsideWindow + writer.stats.outsideWindow,
        bookingsWithUnknownStatus,
        duplicateStayNightKeysMerged,
        rowsWithMissingRate,
        unchangedRowsSkipped,
        tokenRefreshed: resolved.refreshed,
      },
    };
  } catch (error) {
    if (error instanceof CloudbedsHttpError) {
      // A 401/403 on a data call is what a Marketplace disconnect looks like
      // from out here: the grant is gone but the access token has not expired,
      // so the token-refresh path never runs and never notices. Without this
      // the connection kept reporting "connected" while every call 401'd.
      if (isAuthRevocation(error.status, error.message)) {
        await markConnectionDisconnected(supabase, hotelId, "cloudbeds", error.message);
      }
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
