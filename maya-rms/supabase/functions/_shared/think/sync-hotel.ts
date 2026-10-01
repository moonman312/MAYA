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
  thinkGetRooms,
  thinkGetRoomTypes,
  ThinkHttpError,
} from "./client.ts";
import {
  thinkBaseUrlFor,
  THINK_FULL_SYNC_INTERVAL_MS,
  THINK_INCREMENTAL_OVERLAP_MS,
  THINK_PAGE_SIZE,
  THINK_SYNC_BUDGET_MS,
} from "./constants.ts";
import {
  countThinkRoomsByType,
  parseThinkReservations,
  parseThinkRoomTypes,
  type ThinkParseStats,
} from "./etl.ts";
import type { ThinkCredentials } from "./types.ts";
import {
  deleteThinkNights,
  isThinkLookupId,
  loadStoredThinkReservationsBetween,
  loadStoredThinkRows,
} from "./stored-rows.ts";
import { raiseAlert } from "../pms/alerting.ts";
import { addCalendarDays } from "../engine/timezone.ts";
import { mwsEnv } from "../mews/env.ts";
import { persistPropertyId, resolveOAuthCredentials } from "../pms/oauth-credentials.ts";
import { proposeCountsAsRoom } from "../onboarding/analysis.ts";
import { dropUnchangedReservationRows } from "../pms/row-diff.ts";
import { upsertRoomTypesKeepingCounts } from "../pms/room-type-upsert.ts";
import { decideSyncWindow } from "../pms/sync-mode.ts";
import { DEFAULT_SYNC_DAYS_FORWARD, MAX_SYNC_DAYS_FORWARD } from "../pms/pricing-window.ts";

const RECONCILE_IN_CHUNK = 200;
/**
 * Stored reservations a full sweep may find missing before it stops
 * believing itself: this many, or this share of the reservations stored with
 * nights to come, whichever is more. The same guard as the Cloudbeds sync's:
 * a sweep that comes back without a fifth of the book has gone wrong in a
 * way nobody thought of, and removing those nights would empty the hotel's
 * occupancy and send its prices down.
 */
const MISSING_RESERVATIONS_LIMIT = 5;
const MISSING_RESERVATIONS_SHARE = 0.2;
/** Pages of a narrow read for one missing reservation before it is left unconfirmed. */
const LOOKUP_PAGE_GUARD = 5;
/** A pager that never says `last` should exhaust this, not the isolate. */
const PAGE_GUARD = 1000;
/** Match the Mews/Cloudbeds defaults so all three PMSes sweep the same book. */
const DEFAULT_BACK = 30;
// The reads reach at least as far as the pricing window (pricing-window.ts).
const DEFAULT_FORWARD = DEFAULT_SYNC_DAYS_FORWARD;
const MAX_BACK = 365;
const MAX_FORWARD = MAX_SYNC_DAYS_FORWARD;

/**
 * The statuses a healthy run is allowed to turn back into 'connected'.
 * 'pending' waits on payment and only activation makes it live; 'disconnected'
 * means the grant was withdrawn. A sync that happens to succeed proves neither
 * has changed, and the import worker runs this same sync, so an unconditional
 * stamp put an unpaid property into the scheduler on its first pass. Same rule
 * as the Cloudbeds and Mews syncs.
 */
const SYNC_MAY_MARK_CONNECTED = ["connected", "degraded", "error"];

/**
 * Stamp a finished run on the connection row. The status condition lives in
 * the UPDATE rather than a read beforehand, so an activation or disconnect that
 * lands mid-run wins; a row it skips still gets the watermark and checkpoint,
 * or the next run would redo this one's work.
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

export type ThinkSyncOptions = {
  daysBack?: number;
  daysForward?: number;
  /** Absolute time (ms) to stop reading by; never later than THINK_SYNC_BUDGET_MS from the start. */
  deadlineAt?: number;
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
    /** Rooms stored under a reservation that its fresh answer no longer lists: removed. */
    roomsGone: number;
    /** What the full sweep found about stored reservations it did not return (see removeMissingReservations). */
    missingReservations: MissingReservationsCheck;
  };
};

export type MissingReservationsCheck =
  | {
      checked: false;
      why: "incremental_read" | "read_cut_short" | "read_resumed" | "window_after_today" | "stored_read_failed";
    }
  | {
      checked: true;
      /** Reservations stored with a night from today to the end of the window. */
      stored: number;
      /** Of those, the ones the sweep did not return. */
      missing: number;
      /** Asked about again and gone from Think, or cancelled there: removed. */
      removed: number;
      /** Asked about again and still in Think: missed by the sweep, left as stored. */
      stillHeld: number;
      /** Not asked about, or no clear answer: left as stored, checked again on the next sweep. */
      unconfirmed: number;
      overLimit?: true;
      emptyRead?: true;
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

/**
 * Rooms per type from GET /rooms, or null when this run has no usable count.
 * Never fatal: the stored counts are right until something says otherwise,
 * and a sync that stopped over a count would stop pricing too.
 */
async function readThinkRoomCounts(
  creds: ThinkCredentials,
  thinkHotelId: string,
  hotelId: string,
  rtRaw: unknown[],
): Promise<Map<string, number> | null> {
  const known = new Set<string>();
  for (const rt of rtRaw) {
    const id = (rt as { id?: unknown } | null)?.id;
    if (typeof id === "string" || typeof id === "number") known.add(String(id));
  }
  try {
    const rooms = await thinkGetRooms(creds, thinkHotelId, THINK_PAGE_SIZE);
    const { counts, stats } = countThinkRoomsByType(rooms, known);
    if (!counts) {
      console.warn(JSON.stringify({
        fn: "think-sync",
        hotel: hotelId,
        warning: "rooms list had no countable room on a known type; stored room counts kept",
        stats,
      }));
    }
    return counts;
  } catch (e) {
    console.warn(JSON.stringify({
      fn: "think-sync",
      hotel: hotelId,
      warning: "rooms read failed; stored room counts kept",
      error: e instanceof Error ? e.message : String(e),
    }));
    return null;
  }
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
        // OFFSET pages need a total order: without one, rows written between
        // two pages can shift a row past the boundary and it is never seen.
        // This is the reservations unique key's order.
        .order("external_reservation_id", { ascending: true })
        .order("stay_date", { ascending: true })
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

/**
 * Stored rows of these reservations that their fresh answer no longer
 * accounts for (audit A2, ThinkReservations' side). A cancelled reservation
 * gives up every key stored under it, not only the keys of the rooms its
 * answer still lists: a room taken off it earlier is only in the table. A
 * reservation answered whole gives up the keys of rooms it no longer lists;
 * one that is not whole (a room the answer could not read) gives up nothing.
 * A key this run wrote is never given up. Returns the keys of each kind.
 */
async function storedRowsTheAnswerDropped(
  supabase: SupabaseClient,
  hotelId: string,
  answered: Map<string, { canceled: boolean; whole: boolean; keys: Set<string> }>,
  written: ReadonlyMap<string, Set<string>>,
): Promise<{ canceled: string[]; gone: string[]; error: { message: string } | null }> {
  const asked = [...answered].filter(([, a]) => a.canceled || a.whole).map(([id]) => id);
  const stored = await loadStoredThinkRows(supabase, hotelId, asked);
  if (stored.error) return { canceled: [], gone: [], error: stored.error };
  const canceled: string[] = [];
  const gone: string[] = [];
  for (const [id, keys] of stored.reservations) {
    const answer = answered.get(id);
    if (!answer) continue;
    for (const key of keys.keys()) {
      if (written.has(key)) continue;
      if (answer.canceled) canceled.push(key);
      else if (!answer.keys.has(key)) gone.push(key);
    }
  }
  return { canceled, gone, error: null };
}

/**
 * Stored reservations with nights still to come that a whole full sweep did
 * not return: deleted in ThinkReservations, which never lists them again
 * (audit A2, ThinkReservations' side).
 *
 * Only a sweep that vouches for what it leaves out gets here (the caller
 * checks: a full read, not resumed, not cut short, from a window that starts
 * no later than today). Even then absence is only a reason to ask. Think has
 * no read of one reservation by its id, so each missing reservation is
 * asked for again with a stay range of just its own stored nights, and its
 * nights from today on are removed only when that read comes back whole
 * without it, or has it cancelled. One the narrow read returns is left as
 * stored; so is one the question got no answer about. Nights already past
 * are history and stay, unless the reservation is cancelled, which removes
 * them as any cancellation does.
 *
 * Never throws and never fails the run: what it could not check this time
 * the next full sweep checks again.
 */
async function removeMissingReservations(args: {
  supabase: SupabaseClient;
  hotelId: string;
  creds: ThinkCredentials;
  thinkHotelId: string;
  /** The first night that counts as still to come. */
  today: string;
  /** The last night the sweep read. */
  through: string;
  seen: ReadonlySet<string>;
  deadlineAt: number;
}): Promise<MissingReservationsCheck> {
  const { supabase, hotelId, creds, thinkHotelId, today, through, seen, deadlineAt } = args;
  const log = (line: Record<string, unknown>, level: "log" | "error" = "log") =>
    console[level](JSON.stringify({ fn: "runThinkSyncForHotel", hotelId, step: "missing_reservations", ...line }));
  try {
    const stored = await loadStoredThinkReservationsBetween(supabase, hotelId, today, through);
    if (stored.error) {
      log({ error: stored.error.message }, "error");
      return { checked: false, why: "stored_read_failed" };
    }
    const missing = [...stored.reservations.keys()].filter((id) => !seen.has(id)).sort();
    const check = { checked: true as const, stored: stored.reservations.size, missing: missing.length, removed: 0, stillHeld: 0, unconfirmed: 0 };
    if (missing.length === 0) return check;

    const limit = Math.max(MISSING_RESERVATIONS_LIMIT, Math.floor(stored.reservations.size * MISSING_RESERVATIONS_SHARE));
    // A sweep that returned no reservation at all while MAYA holds some with
    // nights to come went wrong, whatever the count: on a small book every
    // stored reservation is within the limit.
    const emptyRead = seen.size === 0;
    if (missing.length > limit || emptyRead) {
      log(
        {
          stored: check.stored,
          missing: check.missing,
          limit,
          returned: seen.size,
          error: emptyRead
            ? "the full sweep returned no reservation while some are stored with nights to come; none removed"
            : "too many stored reservations missing from the sweep; none removed",
        },
        "error",
      );
      await raiseAlert(supabase, {
        severity: "warn",
        key: `think_missing_reservations:${hotelId}`,
        title: emptyRead ? "ThinkReservations read returned no reservations" : "ThinkReservations read left out too many stored reservations",
        detail:
          `${check.missing} of ${check.stored} stored reservations with nights to come were not in a full read ` +
          `(${emptyRead ? "the read returned no reservation at all" : `limit ${limit}`}). Nothing was removed. ` +
          `Compare the hotel's reservations in ThinkReservations with MAYA's.`,
        hotelId,
      });
      return { ...check, unconfirmed: missing.length, overLimit: true, ...(emptyRead ? { emptyRead: true } : {}) };
    }

    const gone: string[] = [];
    const cancelled: string[] = [];
    for (let i = 0; i < missing.length; i += 1) {
      if (Date.now() > deadlineAt) {
        check.unconfirmed += missing.length - i;
        break;
      }
      const id = missing[i];
      const nights = [...stored.reservations.get(id)!.values()].flatMap((n) => [...n]).sort();
      const answer = await lookUpThinkReservation(creds, thinkHotelId, id, nights[0], nights[nights.length - 1]);
      if (answer === "unknown") check.unconfirmed += 1;
      else if (answer === "gone") gone.push(id);
      else if (answer === "canceled") cancelled.push(id);
      else check.stillHeld += 1;
    }

    if (gone.length > 0) {
      const keys = gone.flatMap((id) => [...stored.reservations.get(id)!.keys()]);
      const del = await deleteThinkNights(supabase, hotelId, keys, today);
      if (del.error) {
        log({ error: del.error.message }, "error");
        check.unconfirmed += gone.length;
      } else {
        check.removed += gone.length;
      }
    }
    if (cancelled.length > 0) {
      const rows = await loadStoredThinkRows(supabase, hotelId, cancelled);
      const keys = [...rows.reservations.values()].flatMap((k) => [...k.keys()]);
      const del = rows.error ? { error: rows.error } : await deleteThinkNights(supabase, hotelId, keys);
      if (del.error) {
        log({ error: del.error.message }, "error");
        check.unconfirmed += cancelled.length;
      } else {
        check.removed += cancelled.length;
      }
    }
    // Reservation ids only: nothing about a guest.
    log({ ...check, removedReservations: [...gone, ...cancelled].slice(0, 20) }, check.stillHeld > 0 ? "error" : "log");
    return check;
  } catch (e) {
    log({ error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, "error");
    return { checked: false, why: "stored_read_failed" };
  }
}

/**
 * Asks Think again for one reservation, by a stay range of its own stored
 * nights (Think has no read of one reservation by id): "held" when the read
 * returns it in service, "canceled" when cancelled, "gone" when the read
 * comes back whole without it, "unknown" when it errs or runs past its page
 * guard.
 */
async function lookUpThinkReservation(
  creds: ThinkCredentials,
  thinkHotelId: string,
  id: string,
  firstNight: string,
  lastNight: string,
): Promise<"held" | "canceled" | "gone" | "unknown"> {
  try {
    // The end is read one day on, in case the range's end is exclusive.
    const range = buildReservationRangeParams({ stayFrom: firstNight, stayTo: addCalendarDays(lastNight, 1) });
    for (let page = 0; page < LOOKUP_PAGE_GUARD; page += 1) {
      const res = await thinkGetReservationsPage(creds, thinkHotelId, range, page, THINK_PAGE_SIZE);
      const parsed = parseThinkReservations(res.content, { hotelTimeZone: "UTC" });
      const found = parsed.seen.find((r) => r.id === id);
      if (found) return found.canceled ? "canceled" : "held";
      if (res.last) return "gone";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
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
      // The stored override only when it is ThinkReservations' own host (pms/base-url.ts).
      baseUrl: thinkBaseUrlFor(connRow?.base_url as string | null | undefined, hotelId),
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
    const roomCounts =
      rtRaw.length > 0 ? await readThinkRoomCounts(creds, thinkHotelId, hotelId, rtRaw) : null;
    const parsedRoomTypes = parseThinkRoomTypes(rtRaw, roomCounts);

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
      // Counted rooms are written every run; without a count the stored one
      // stands, and only a type never stored takes the hotel default.
      const { error: rtErr } = await upsertRoomTypesKeepingCounts(
        supabase,
        hotelId,
        rtRows,
        defaultRooms,
      );
      if (rtErr) return { ok: false, error: rtErr };
      // Default counts_as_room for types nobody has classified yet. Separate
      // from the upsert on purpose: written there it would overwrite the
      // owner's answer every tick. "sync" mode: only ever writes `true` —
      // nobody is on the review screen to correct a guessed `false`.
      await proposeCountsAsRoom(supabase, hotelId, rtRows, "sync");
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
    // Every reservation the run's answers named, and what each vouched for.
    const answered = new Map<string, { canceled: boolean; whole: boolean; keys: Set<string> }>();
    const deadlineAt = Math.min(Date.now() + THINK_SYNC_BUDGET_MS, options?.deadlineAt ?? Infinity);
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
      for (const r of parsed.seen) {
        // A reservation on two pages (its status flipped mid-walk): the
        // later answer decides, as the row writes do, and it is whole only
        // if every answer was.
        const prior = answered.get(r.id);
        answered.set(r.id, {
          canceled: r.canceled,
          whole: r.whole && (prior?.whole ?? true),
          keys: new Set([...(prior?.keys ?? []), ...r.rowKeys]),
        });
      }

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
    //
    // What is stored for each reservation answered is read back first, so a
    // cancellation clears every key stored for it, and a room the answer no
    // longer lists loses its nights (storedRowsTheAnswerDropped). A read
    // that fails stops the run: nothing is deleted on a guess.
    const dropped = await storedRowsTheAnswerDropped(supabase, hotelId, answered, activeNights);
    if (dropped.error) return { ok: false, error: dropped.error.message };
    for (const key of dropped.canceled) canceledKeys.add(key);
    const canceledIds = [...canceledKeys].filter((id) => !activeNights.has(id));
    const canceledDel = await deleteCanceledReservationRows(supabase, hotelId, canceledIds);
    if (canceledDel.error) return { ok: false, error: canceledDel.error.message };
    const goneKeys = dropped.gone.filter((key) => !canceledKeys.has(key));
    const goneDel = await deleteThinkNights(supabase, hotelId, goneKeys);
    if (goneDel.error) return { ok: false, error: goneDel.error.message };
    const staleDel = await deleteStaleStayNightsForActiveReservations(
      supabase,
      hotelId,
      activeNights,
    );
    if (staleDel.error) return { ok: false, error: staleDel.error.message };

    // A reservation deleted in Think is in no answer ever again, so only a
    // sweep of everything can notice it is gone, and only one that was
    // whole: a full read, from its first page, not cut short, over a window
    // that starts no later than today (UTC, as the window is). The nights it
    // asks about run from today to the window's end: a reservation holding
    // one stays on a night the sweep read, so the sweep had to return it.
    const today = ymd(runStartedAt.getTime());
    const skipMissing: Extract<MissingReservationsCheck, { checked: false }>["why"] | null = incremental
      ? "incremental_read"
      : truncated
        ? "read_cut_short"
        : sweepFromPage > 0
          ? "read_resumed"
          : stayWindow.start > today
            ? "window_after_today"
            : null;
    const missingReservations: MissingReservationsCheck = skipMissing
      ? { checked: false, why: skipMissing }
      : await removeMissingReservations({
          supabase,
          hotelId,
          creds,
          thinkHotelId,
          today,
          through: stayWindow.end,
          seen: new Set([...answered.keys()].filter(isThinkLookupId)),
          deadlineAt,
        });

    // 7. Stamp connection status.
    if (connRow?.id) {
      const nowIso = new Date().toISOString();
      const pcErr = await stampConnection(supabase, String(connRow.id), {
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
        // An incremental pull that ran out of time has no checkpoint to resume
        // from, so it would retry the same too-big pull every tick. Clearing
        // this makes the next run the checkpointed full sweep instead.
        ...(truncated && incremental ? { last_full_sync_at: null } : {}),
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
      });
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
        roomsGone: goneKeys.length,
        missingReservations,
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
