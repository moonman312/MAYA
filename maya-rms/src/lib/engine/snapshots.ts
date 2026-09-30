/**
 * Stay-date snapshot writer and retention.
 *
 * Derives sellable_units / booked_units / booked_revenue per (stay_date, room_type)
 * from the reservations table and room_types.total_rooms.
 *
 * Implementation Guide §3.5, §11 step 1.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomTypeRow, SnapshotRow } from "./types";

/* ── Schema tolerance ──────────────────────────────────────────────────────
 *
 * Code and SQL ship separately and nobody promises the order. Every read of
 * a column or table that arrived in a migration has to be able to notice it
 * is running against the old schema, say so once in the log, and carry on
 * the way it did before that migration. These helpers are how each caller
 * recognises that case; the caller decides what "carry on" means.
 */

/** The migration files a pre-migration run should name in its log line. */
export const MIGRATIONS = {
  baseRateCalendar: "99_supabase_migration_base_rate_calendar_v1.sql",
  manualPrice: "99_supabase_migration_manual_price_v1.sql",
  countsAsRoom: "99_supabase_migration_room_type_counts_as_room_v1.sql",
  outOfService: "99_supabase_migration_room_type_out_of_service_v1.sql",
  largePropertyScale: "99_supabase_migration_large_property_scale_v1.sql",
  countsBookings: "99_supabase_migration_booking_speed_counts_bookings_v1.sql",
  pickupStacking: "99_supabase_migration_pickup_event_stacking_v1.sql",
  pickupWait: "99_supabase_migration_pickup_wait_v1.sql",
  undoOnCancellation: "99_supabase_migration_undo_on_cancellation_v1.sql",
  pricingCadence: "99_supabase_migration_pricing_cadence_v1.sql",
  ruleActivation: "99_supabase_migration_rule_activation_v1.sql",
  bookingHistoryCache: "99_supabase_migration_booking_history_cache_v1.sql",
  closedPeriods: "99_supabase_migration_onboarding_v1.sql",
  assumptionChallenges: "99_supabase_migration_assumption_challenges_v1.sql",
} as const;

/* ── The nights one run prices ─────────────────────────────────────────────
 *
 * A run prices either every night from its first to its last (the window) or
 * a set of nights (evaluateHotel's `nights` option: the nights whose inputs
 * changed plus a chunk of the daily pass). Reads keyed by a range of nights
 * ask for just the run's nights when that is cheaper: a short list goes in as
 * a filter, a range function is called once per stretch of consecutive
 * nights when there are few stretches, and otherwise the whole range is read
 * and the caller keys by night, as every caller already does.
 */

/** Sorted, distinct YYYY-MM-DD nights. */
export type NightSet = readonly string[];

/** Longest list of nights sent as an `in` filter (about 2.4 KB of URL). */
export const NIGHT_LIST_FILTER_MAX = 200;
/** Most stretches of consecutive nights read one call each before the whole range is read instead. */
export const NIGHT_SEGMENTS_MAX = 6;

/** Whether the nights are every night from the first to the last. */
export function isContiguousNights(nights: NightSet): boolean {
  for (let i = 1; i < nights.length; i++) {
    if (addUtcDays(nights[i - 1], 1) !== nights[i]) return false;
  }
  return true;
}

/** Stretches of consecutive nights, as [first, last] pairs. */
export function nightSegments(nights: NightSet): [string, string][] {
  const out: [string, string][] = [];
  for (const night of nights) {
    const last = out[out.length - 1];
    if (last && addUtcDays(last[1], 1) === night) last[1] = night;
    else if (!last || night > last[1]) out.push([night, night]);
  }
  return out;
}

/**
 * The ranges a range function is called over for these nights: one per
 * stretch when there are at most NIGHT_SEGMENTS_MAX, else the whole range.
 */
export function rangesForNights(nights: NightSet | undefined, firstDate: string, lastDate: string): [string, string][] {
  if (!nights || nights.length === 0) return [[firstDate, lastDate]];
  const segments = nightSegments(nights);
  return segments.length <= NIGHT_SEGMENTS_MAX ? segments : [[firstDate, lastDate]];
}

/**
 * Filters a query to the nights: the range, or the list itself when the
 * nights are not consecutive and the list is short enough for a URL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function filterNights(query: any, nights: NightSet | undefined, firstDate: string, lastDate: string, column = "stay_date"): any {
  if (nights && nights.length > 0 && nights.length <= NIGHT_LIST_FILTER_MAX && !isContiguousNights(nights)) {
    return query.in(column, nights as string[]);
  }
  return query.gte(column, firstDate).lte(column, lastDate);
}

/* ── Runs, for the pickup baseline's staleness guard ─────────────────────── */

/** How long a hotel may go without a successful run before a pickup baseline inside that stretch is stale. */
export const RUN_GAP_STALE_MS = 12 * 60 * 60 * 1000;

/** A stretch with no run of the hotel longer than RUN_GAP_STALE_MS: no run strictly between `from` and `to`. */
export type RunGap = { from: number; to: number };

let loggedRunGapsMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetRunGapsLogOnce(): void {
  loggedRunGapsMissing = false;
}

/**
 * The stretches of more than RUN_GAP_STALE_MS without a run of the hotel
 * between `from` and `to` (engine_run_gaps), both ends counting as runs.
 * Null before the migration: the caller then judges a baseline by the age
 * of its snapshot, as before. Throws on any other failure: judged that way
 * under the daily pass, most baselines read as stale and no pickup rule
 * fires.
 */
export async function loadRunGaps(
  supabase: SupabaseClient,
  hotelId: string,
  from: string,
  to: string,
): Promise<RunGap[] | null> {
  const { data, error } = await supabase.rpc("engine_run_gaps", {
    p_hotel_id: hotelId,
    p_from: from,
    p_to: to,
    p_min_gap_seconds: Math.round(RUN_GAP_STALE_MS / 1000),
  });
  if (error && !isMissingFunctionError(error)) {
    throw new Error(`Failed to load when pricing ran: ${error.message}`);
  }
  if (error || !Array.isArray(data)) {
    if (!loggedRunGapsMissing) {
      loggedRunGapsMissing = true;
      const missing = error && isMissingFunctionError(error);
      console.error(
        JSON.stringify({
          fn: "evaluateHotel",
          step: "engine_run_gaps",
          hotelId,
          ...(missing
            ? {
                schema: "pre-migration",
                message: `engine_run_gaps does not exist yet; a pickup baseline is stale when its snapshot is over 12 hours older than it. Run ${MIGRATIONS.pricingCadence}.`,
                migration: MIGRATIONS.pricingCadence,
              }
            : {}),
          error: error?.message ?? "no rows came back",
        }),
      );
    }
    return null;
  }
  const out: RunGap[] = [];
  for (const r of data as Record<string, unknown>[]) {
    const a = Date.parse(String(r.gap_from));
    const b = Date.parse(String(r.gap_to));
    if (Number.isFinite(a) && Number.isFinite(b)) out.push({ from: a, to: b });
  }
  return out;
}

/**
 * Whether a pickup count's window opens at a moment pricing was not
 * running (§16.3). The snapshot found under the baseline is over
 * RUN_GAP_STALE_MS older than it, and, when the run gaps were read, the
 * hotel had no run at all in the RUN_GAP_STALE_MS up to the baseline.
 *
 * The first test alone is what the engine always asked. It was an outage
 * test only while every run snapshotted every night: once most nights are
 * priced once a day, the latest snapshot of a quiet night is usually hours
 * old, and nothing is wrong. A run in the 12 hours up to the baseline says
 * pricing was running, so a night with no snapshot since had no booking
 * change since, and its older snapshot is its state at the baseline. The
 * gaps come from a read that starts well before any baseline (see
 * evaluateHotel), so "no run in the 12 hours" is exact.
 */
export function baselineIsStale(baselineTs: string, snapshotTs: string, gaps: readonly RunGap[] | null): boolean {
  const at = Date.parse(baselineTs);
  const old = at - Date.parse(snapshotTs) > RUN_GAP_STALE_MS;
  if (!old || gaps === null) return old;
  return gaps.some((g) => at > g.from + RUN_GAP_STALE_MS && at < g.to);
}

type PostgrestLike = { code?: string | null; message?: string | null } | null | undefined;

/** Preserves PostgREST's `code` so callers can tell a schema gap from an outage. */
export function postgrestError(error: { code?: string | null; message?: string | null }): Error {
  const err = new Error(error.message ?? "unknown error") as Error & { code?: string };
  if (error.code) err.code = String(error.code);
  return err;
}

function codeAndMessage(e: unknown): { code: string; message: string } {
  const like = (typeof e === "object" && e !== null ? e : {}) as PostgrestLike;
  return {
    code: String(like?.code ?? ""),
    message: String(like?.message ?? (e instanceof Error ? e.message : e ?? "")),
  };
}

/** `column x does not exist` — 42703 from a select or filter, PGRST204 from a write payload. */
export function isMissingColumnError(e: unknown): boolean {
  const { code, message } = codeAndMessage(e);
  return (
    code === "42703" ||
    code === "PGRST204" ||
    /column .* does not exist/i.test(message) ||
    /could not find the .* column/i.test(message)
  );
}

/**
 * A table no migration has created yet. Postgres itself says 42P01
 * (`relation x does not exist`), but PostgREST answers from its schema cache
 * first and reports an unknown table as PGRST205 (`Could not find the table
 * 'public.x' in the schema cache`) — that is the shape the client actually
 * sees on the current server, so both are recognised.
 */
export function isMissingRelationError(e: unknown): boolean {
  const { code, message } = codeAndMessage(e);
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /relation .* does not exist/i.test(message) ||
    /could not find the table/i.test(message)
  );
}

/**
 * An rpc no migration has created yet. PostgREST answers from its schema
 * cache (PGRST202, "Could not find the function"); Postgres itself says
 * 42883.
 */
export function isMissingFunctionError(e: unknown): boolean {
  const { code, message } = codeAndMessage(e);
  return code === "PGRST202" || code === "42883" || /could not find the function/i.test(message);
}

/**
 * A table, column or function no migration has created yet: the one failure
 * a read may carry on from, the way the hotel was priced before that
 * migration. Any other failure (a timeout, a refusal, a dropped connection)
 * says nothing about what the database holds. Read as "nothing there", it
 * priced a night without the price typed for it, the hotel's own rate or
 * its closed periods, and published that as a good run; so it stops the run
 * before anything is published, and the next run prices the same nights.
 */
export function isSchemaGapError(e: unknown): boolean {
  return isMissingColumnError(e) || isMissingRelationError(e) || isMissingFunctionError(e);
}

/** What a failed read said, for the error that stops the run. */
export function readErrorText(e: unknown): string {
  return codeAndMessage(e).message || "unknown error";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllRows(makeQuery: () => any, pageSize = 1000): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let from = 0;
  let guard = 0;
  for (;;) {
    // A backstop, not a stopping point: quietly returning the first million
    // rows would hand the caller a truncated set that looks complete.
    if (++guard > 1000) {
      throw new Error(`fetchAllRows read ${pageSize * 1000} rows and there are more; narrow the query.`);
    }
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw postgrestError(error);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** One open room_type_out_of_service row: `units` rooms unsellable on every night in the range. */
export type OutOfServiceRow = {
  room_type_id: string;
  start_date: string;
  end_date: string;
  units: number;
};

/**
 * Open out-of-service rows for the hotel that touch the horizon. A hotel
 * with none, or a database that has not run the migration yet, both come
 * back empty: pricing on the physical count is last week's behaviour, and
 * a missing table must never take the run down with it.
 *
 * Only the schema gap is tolerated. Any other failure (a timeout, an RLS
 * refusal) throws, same as loadActiveLadderEffects: quietly snapshotting the
 * physical count would read a renovated wing as empty rooms and push the
 * lower price as a successful run.
 */
export async function loadOutOfServiceRows(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<OutOfServiceRow[]> {
  try {
    const rows = await fetchAllRows(() =>
      supabase
        .from("room_type_out_of_service")
        .select("room_type_id, start_date, end_date, units")
        .eq("hotel_id", hotelId)
        .is("cleared_at", null)
        .lte("start_date", lastDate)
        .gte("end_date", firstDate)
        .order("id", { ascending: true }),
    );
    return rows
      .filter((r) => r.room_type_id && r.start_date && r.end_date)
      .map((r) => ({
        room_type_id: String(r.room_type_id),
        start_date: String(r.start_date),
        end_date: String(r.end_date),
        units: Math.max(0, Number(r.units ?? 0)),
      }));
  } catch (e) {
    if (!isMissingRelationError(e)) {
      throw new Error(
        `Failed to load rooms out of service: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.error(
      JSON.stringify({
        fn: "snapshotCurrentState",
        step: "room_type_out_of_service",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
        degradedToEmpty: true,
        schema: "pre-migration",
        message: `room_type_out_of_service does not exist yet; snapshotting the physical room count. Run ${MIGRATIONS.outOfService}.`,
        migration: MIGRATIONS.outOfService,
      }),
    );
    return [];
  }
}

/**
 * Sellable units for one (stay_date, room_type): the physical count minus
 * every open out-of-service row covering that night. Rows stack (two
 * renovations on the same wing add up) and the result never goes negative,
 * because computeOccupancy treats 0 as "nothing to sell" and skips the type.
 */
export function sellableUnitsFor(
  totalRooms: number,
  oosRows: OutOfServiceRow[],
  stayDate: string,
  roomTypeId: string,
): number {
  let out = 0;
  for (const r of oosRows) {
    if (r.room_type_id !== roomTypeId) continue;
    if (stayDate < r.start_date || stayDate > r.end_date) continue;
    out += r.units;
  }
  return Math.max(0, totalRooms - out);
}

/**
 * Insert one snapshot row per (stay_date, room_type) across the full horizon
 * for a single hotel. Uses a consistent snapshot_ts for the whole run.
 *
 * Callers pass only the room types that count as rooms; a court or meeting
 * room never gets a snapshot row, so it can never enter an occupancy
 * denominator. sellable_units is the SELLABLE count (see sellableUnitsFor),
 * which is why the metric built on it is called sellable occupancy.
 */
/** What the horizon's reservations add up to per `stay_date|room_type_id`. */
export type ReservationCells = {
  /** Room-nights and the sum of current_rate (null as 0). */
  booked: Map<string, { units: number; revenue: number }>;
  /** base_rate of the newest row (created_at, then lowest id), null when that row has none. */
  latestBase: Map<string, { base_rate: number | null; created_at: string }>;
};

let loggedReservationCellsMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetReservationCellsLogOnce(): void {
  loggedReservationCellsMissing = false;
}

/**
 * The horizon's reservations, grouped per cell in the database
 * (engine_reservation_cells). The engine used to read every room-night in the
 * horizon twice, once for the snapshot and once for base rates: on a
 * 500-room property that is over 100,000 rows each time. Null before the
 * migration; the caller reads the rows as it always did.
 */
export async function loadReservationCells(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
  /** The run's nights when they are not every night in the range (see rangesForNights). */
  nights?: NightSet,
): Promise<ReservationCells | null> {
  const booked = new Map<string, { units: number; revenue: number }>();
  const latestBase = new Map<string, { base_rate: number | null; created_at: string }>();
  for (const [from, to] of rangesForNights(nights, firstDate, lastDate)) {
    if (!(await readReservationCells(supabase, hotelId, from, to, booked, latestBase))) return null;
  }
  return { booked, latestBase };
}

async function readReservationCells(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
  booked: Map<string, { units: number; revenue: number }>,
  latestBase: Map<string, { base_rate: number | null; created_at: string }>,
): Promise<boolean> {
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .rpc("engine_reservation_cells", { p_hotel_id: hotelId, p_from: firstDate, p_to: lastDate })
      .order("stay_date", { ascending: true })
      .order("room_type_id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      if (!isMissingFunctionError(error)) {
        throw new Error(`Failed to load reservation cells: ${error.message}`);
      }
      if (!loggedReservationCellsMissing) {
        loggedReservationCellsMissing = true;
        console.error(
          JSON.stringify({
            fn: "evaluateHotel",
            step: "engine_reservation_cells",
            hotelId,
            schema: "pre-migration",
            message: `engine_reservation_cells does not exist yet; reading every room-night in the horizon. Run ${MIGRATIONS.largePropertyScale}.`,
            migration: MIGRATIONS.largePropertyScale,
            error: error.message,
          }),
        );
      }
      return false;
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      const key = `${r.stay_date}|${r.room_type_id}`;
      booked.set(key, { units: Number(r.units), revenue: Number(r.revenue) });
      latestBase.set(key, {
        base_rate: r.latest_base_rate != null ? Number(r.latest_base_rate) : null,
        created_at: String(r.latest_created_at ?? ""),
      });
    }
    if (rows.length < 1000) break;
  }
  return true;
}

/** Room nights on one night and room type, and the sum of their current_rate (null as 0). */
export type BookedCount = { units: number; revenue: number };

/** A night and an instant: the rows on the night first seen at or before it (loadBookedBefore). */
export type BookedBeforePair = { stayDate: string; at: string };

/** The loadBookedBefore key for a night and an instant, the instant to the millisecond whatever its spelling. */
export function bookedBeforeKey(stayDate: string, at: string): string {
  const ms = Date.parse(at);
  return `${stayDate}|${Number.isNaN(ms) ? at : new Date(ms).toISOString()}`;
}

let loggedBookedBeforeMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetBookedBeforeLogOnce(): void {
  loggedBookedBeforeMissing = false;
}

const BOOKED_BEFORE_CHUNK = 400;

/**
 * For each (night, instant) pair, the room nights on that night still
 * booked now whose row was first seen at or before the instant
 * (reservations.created_at: a cancelled room's row is deleted, a changed one
 * keeps its created_at), per room type, with their revenue. Keyed by
 * bookedBeforeKey, then room type id; a pair with no such row has an empty
 * map. The cancellation check reads this: at a fire's own instant it is what
 * was booked then minus what has cancelled since, and at the instant a
 * pickup count opened it is what came in before that.
 *
 * engine_booked_before (99_supabase_migration_undo_on_cancellation_v1.sql)
 * answers every pair in one call per chunk, one index probe on
 * (hotel_id, stay_date) each. Before that migration the rows of the nights
 * asked for are read and summed here instead, which gives the same answer.
 * Throws on any other failure: a check that quietly read nothing would take
 * changes off nights whose bookings are all still there.
 */
export async function loadBookedBefore(
  supabase: SupabaseClient,
  hotelId: string,
  pairs: readonly BookedBeforePair[],
): Promise<Map<string, Map<string, BookedCount>>> {
  const out = new Map<string, Map<string, BookedCount>>();
  const unique = new Map<string, BookedBeforePair>();
  for (const p of pairs) {
    const key = bookedBeforeKey(p.stayDate, p.at);
    if (!unique.has(key)) unique.set(key, { stayDate: p.stayDate, at: key.slice(p.stayDate.length + 1) });
  }
  const asked = [...unique.values()].sort(
    (a, b) => a.stayDate.localeCompare(b.stayDate) || a.at.localeCompare(b.at),
  );
  for (const p of asked) out.set(bookedBeforeKey(p.stayDate, p.at), new Map());
  if (asked.length === 0) return out;

  const add = (key: string, roomTypeId: string, units: number, revenue: number) => {
    const cell = out.get(key);
    if (!cell) return;
    const prev = cell.get(roomTypeId) ?? { units: 0, revenue: 0 };
    cell.set(roomTypeId, {
      units: prev.units + units,
      revenue: Math.round((prev.revenue + revenue) * 100) / 100,
    });
  };

  for (let i = 0; i < asked.length; i += BOOKED_BEFORE_CHUNK) {
    const chunk = asked.slice(i, i + BOOKED_BEFORE_CHUNK);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .rpc("engine_booked_before", {
          p_hotel_id: hotelId,
          p_stay_dates: chunk.map((p) => p.stayDate),
          p_at: chunk.map((p) => p.at),
        })
        .order("stay_date", { ascending: true })
        .order("as_of", { ascending: true })
        .order("room_type_id", { ascending: true })
        .range(from, from + 999);
      if (error) {
        if (!isMissingFunctionError(error)) {
          throw new Error(`Failed to recount bookings for cancellations: ${error.message}`);
        }
        if (!loggedBookedBeforeMissing) {
          loggedBookedBeforeMissing = true;
          console.error(
            JSON.stringify({
              fn: "evaluateHotel",
              step: "engine_booked_before",
              hotelId,
              schema: "pre-migration",
              message: `engine_booked_before does not exist yet; reading the rows of each night checked for cancellations. Run ${MIGRATIONS.undoOnCancellation}.`,
              migration: MIGRATIONS.undoOnCancellation,
              error: error.message,
            }),
          );
        }
        return loadBookedBeforeByRows(supabase, hotelId, asked, out, add);
      }
      const rows = (data ?? []) as Record<string, unknown>[];
      for (const r of rows) {
        if (r.room_type_id == null) continue;
        add(
          bookedBeforeKey(String(r.stay_date).slice(0, 10), String(r.as_of)),
          String(r.room_type_id),
          Number(r.units ?? 0),
          Number(r.revenue ?? 0),
        );
      }
      if (rows.length < 1000) break;
    }
  }
  return out;
}

/** loadBookedBefore before its function exists: the nights' rows, summed per pair. */
async function loadBookedBeforeByRows(
  supabase: SupabaseClient,
  hotelId: string,
  asked: BookedBeforePair[],
  out: Map<string, Map<string, BookedCount>>,
  add: (key: string, roomTypeId: string, units: number, revenue: number) => void,
): Promise<Map<string, Map<string, BookedCount>>> {
  for (const cell of out.values()) cell.clear();
  const byDate = new Map<string, string[]>();
  for (const p of asked) byDate.set(p.stayDate, [...(byDate.get(p.stayDate) ?? []), p.at]);
  const dates = [...byDate.keys()].sort();
  for (let i = 0; i < dates.length; i += BOOKED_BEFORE_CHUNK) {
    let rows: Record<string, unknown>[];
    try {
      rows = await fetchAllRows(() =>
        supabase
          .from("reservations")
          .select("id, stay_date, room_type_id, current_rate, created_at")
          .eq("hotel_id", hotelId)
          .in("stay_date", dates.slice(i, i + BOOKED_BEFORE_CHUNK))
          .order("id", { ascending: true }),
      );
    } catch (e) {
      throw new Error(`Failed to recount bookings for cancellations: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const r of rows) {
      if (r.room_type_id == null) continue;
      const stayDate = String(r.stay_date).slice(0, 10);
      const createdMs = Date.parse(String(r.created_at));
      for (const at of byDate.get(stayDate) ?? []) {
        if (!(createdMs <= Date.parse(at))) continue;
        add(bookedBeforeKey(stayDate, at), String(r.room_type_id), 1, Number(r.current_rate ?? 0));
      }
    }
  }
  return out;
}

/** The sum over `roomTypeIds` of one pair's counts, or null when the pair was not read. */
export function bookedBeforeOver(
  counts: ReadonlyMap<string, ReadonlyMap<string, BookedCount>>,
  stayDate: string,
  at: string,
  roomTypeIds: readonly string[],
): BookedCount | null {
  const cell = counts.get(bookedBeforeKey(stayDate, at));
  if (!cell) return null;
  let units = 0;
  let revenue = 0;
  for (const id of new Set(roomTypeIds)) {
    const c = cell.get(id);
    if (!c) continue;
    units += c.units;
    revenue += c.revenue;
  }
  return { units, revenue: Math.round(revenue * 100) / 100 };
}

export async function snapshotCurrentState(
  supabase: SupabaseClient,
  hotelId: string,
  snapshotTs: string,
  stayDates: string[],
  roomTypes: RoomTypeRow[],
  /** Booked units and revenue per cell when the caller already has them (loadReservationCells). */
  bookedByCell?: ReadonlyMap<string, { units: number; revenue: number }>,
  /** Build the rows without writing them (a dry run of the engine). */
  opts: { dryRun?: boolean } = {},
): Promise<SnapshotRow[]> {
  if (stayDates.length === 0 || roomTypes.length === 0) return [];

  // §15.8: same snapshot_ts must not duplicate rows on re-run.
  if (!opts.dryRun) {
    const { error: delErr } = await supabase
      .from("stay_date_snapshot")
      .delete()
      .eq("hotel_id", hotelId)
      .eq("snapshot_ts", snapshotTs);
    if (delErr) throw new Error(`Snapshot delete (idempotent) failed: ${delErr.message}`);
  }

  const rtIds = roomTypes.map((rt) => rt.id);
  const sortedDates = [...stayDates].sort();
  const oosRows = await loadOutOfServiceRows(
    supabase,
    hotelId,
    sortedDates[0],
    sortedDates[sortedDates.length - 1],
  );

  // Aggregate booked_units and booked_revenue per (stay_date, room_type_id)
  // Paged, with a stable order. An unpaginated select silently stops at
  // PostgREST's 1000-row cap, which for a 50-room property at 60% occupancy
  // is reached about 33 days out — every stay date beyond that then
  // snapshots as zero booked, so occupancy reads 0 and pickup deltas go
  // negative. Discount ladders wrongly activate and increase ladders wrongly
  // deactivate for the whole far horizon.
  let bookedMap: ReadonlyMap<string, { units: number; revenue: number }>;
  if (bookedByCell) {
    bookedMap = bookedByCell;
  } else {
    const agg = await fetchAllRows(() =>
      supabase
        .from("reservations")
        .select("stay_date, room_type_id, current_rate")
        .eq("hotel_id", hotelId)
        .in("stay_date", stayDates)
        .in("room_type_id", rtIds)
        .order("id", { ascending: true }),
    );

    const fromRows = new Map<string, { units: number; revenue: number }>();
    for (const row of agg ?? []) {
      const key = `${row.stay_date}|${row.room_type_id}`;
      const entry = fromRows.get(key) ?? { units: 0, revenue: 0 };
      entry.units += 1;
      entry.revenue += Number(row.current_rate ?? 0);
      fromRows.set(key, entry);
    }
    bookedMap = fromRows;
  }

  const rows: SnapshotRow[] = [];
  for (const sd of stayDates) {
    for (const rt of roomTypes) {
      const key = `${sd}|${rt.id}`;
      const booked = bookedMap.get(key) ?? { units: 0, revenue: 0 };
      rows.push({
        hotel_id: hotelId,
        snapshot_ts: snapshotTs,
        stay_date: sd,
        room_type_id: rt.id,
        sellable_units: sellableUnitsFor(rt.total_rooms, oosRows, sd, rt.id),
        booked_units: booked.units,
        booked_revenue: Math.round(booked.revenue * 100) / 100,
      });
    }
  }

  if (opts.dryRun) return rows;
  // Batch insert in chunks to avoid payload limits.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("stay_date_snapshot").insert(chunk);
    if (error) throw new Error(`Snapshot insert failed: ${error.message}`);
  }
  return rows;
}

export type SnapshotRowAt = {
  booked_units: number;
  booked_revenue: number;
  snapshot_ts: string;
};

/**
 * Find the nearest snapshot at or before the given timestamp for a set of
 * (hotel, stay_date, room_type) tuples. Throws on a failed read: a room
 * type left out of the answer reads as one with no snapshot, so occupancy
 * came out lower than it is and a change could come off for cancellations
 * that never happened.
 */
export async function findSnapshotAt(
  supabase: SupabaseClient,
  hotelId: string,
  stayDate: string,
  roomTypeIds: string[],
  atOrBefore: string,
): Promise<Map<string, SnapshotRowAt>> {
  const result = new Map<string, SnapshotRowAt>();

  for (const rtId of roomTypeIds) {
    const { data, error } = await supabase
      .from("stay_date_snapshot")
      .select("booked_units, booked_revenue, snapshot_ts")
      .eq("hotel_id", hotelId)
      .eq("stay_date", stayDate)
      .eq("room_type_id", rtId)
      .lte("snapshot_ts", atOrBefore)
      .order("snapshot_ts", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to load snapshots: ${error.message}`);

    if (data) {
      result.set(rtId, {
        booked_units: Number(data.booked_units),
        booked_revenue: Number(data.booked_revenue),
        snapshot_ts: String(data.snapshot_ts),
      });
    }
  }

  return result;
}

/**
 * Every snapshot read one evaluation run makes, without a round trip per cell.
 *
 * `written` answers from the rows this run inserted a moment ago. That is
 * exactly what the table returns for "latest snapshot at or before the run's
 * own timestamp": the run deleted any row at that timestamp, inserted one for
 * every (stay date, counting room type), and nothing newer can be at or
 * before it. It returns null when any asked-for cell was not written, and
 * the caller reads the table instead.
 *
 * `at` is findSnapshotAt with a memo. Snapshots are only inserted at the start
 * of a run and purged at its end, so a cell's answer for a timestamp cannot
 * change in between. `preload` fills the memo for a whole block of cells in
 * one call (snapshot_cells_at, from the large property migration) when many
 * cells share a baseline timestamp. `preloadAt` fills it for baselines that
 * are each some earlier run's own instant, where a row at exactly that time
 * is exactly what findSnapshotAt would find.
 */
export type SnapshotLookup = {
  written: (
    stayDate: string,
    roomTypeIds: string[],
    ts: string,
  ) => { snapshots: Map<string, SnapshotRowAt>; sellable: Map<string, number> } | null;
  at: (stayDate: string, roomTypeIds: string[], atOrBefore: string) => Promise<Map<string, SnapshotRowAt>>;
  sellableAt: (stayDate: string, roomTypeId: string, ts: string) => Promise<number>;
  preload: (atOrBefore: string, firstDate: string, lastDate: string, roomTypeIds: string[]) => Promise<void>;
  /**
   * Fills the memo for cells whose baseline is a run's own instant (a fire's
   * applied_at: its run wrote a snapshot for every night and counting room
   * type at exactly that time), many instants and nights to a request. A
   * cell with no row at that exact instant is left to `at`, which reads it
   * the old way.
   */
  preloadAt: (cells: { stayDate: string; roomTypeIds: string[]; ts: string }[]) => Promise<void>;
  /**
   * Whether a pickup baseline at `baselineTs`, answered by the snapshot at
   * `snapshotTs`, is too old to count (baselineIsStale over the run's gaps).
   */
  staleBaseline?: (baselineTs: string, snapshotTs: string) => boolean;
};

/** Instants per exact-snapshot read, which keeps the request line short. */
const EXACT_TERMS_PER_READ = 30;
/** Rows a chunk is expected to return before it is split, so one read is usually one page. */
const EXACT_ROWS_PER_READ = 1000;

let loggedSnapshotCellsMissing = false;

/** Test hook: forget that the pre-migration line was already logged. */
export function resetSnapshotLookupLogOnce(): void {
  loggedSnapshotCellsMissing = false;
}

export function createSnapshotLookup(
  supabase: SupabaseClient,
  hotelId: string,
  writtenTs: string,
  writtenRows: SnapshotRow[],
  /** The hotel's stretches without a run (loadRunGaps); null judges a baseline by its snapshot's age. */
  runGaps: readonly RunGap[] | null = null,
): SnapshotLookup {
  const writtenByCell = new Map<string, SnapshotRow>();
  for (const r of writtenRows) writtenByCell.set(`${r.stay_date}|${r.room_type_id}`, r);
  const memo = new Map<string, SnapshotRowAt | null>();
  const sellableMemo = new Map<string, number>();
  let rpcMissing = false;

  const cellKey = (stayDate: string, rtId: string, ts: string) => `${stayDate}|${rtId}|${ts}`;

  return {
    staleBaseline(baselineTs, snapshotTs) {
      return baselineIsStale(baselineTs, snapshotTs, runGaps);
    },

    written(stayDate, roomTypeIds, ts) {
      if (ts !== writtenTs) return null;
      const snapshots = new Map<string, SnapshotRowAt>();
      const sellable = new Map<string, number>();
      for (const rtId of roomTypeIds) {
        const row = writtenByCell.get(`${stayDate}|${rtId}`);
        if (!row) return null;
        snapshots.set(rtId, { booked_units: row.booked_units, booked_revenue: row.booked_revenue, snapshot_ts: ts });
        sellable.set(rtId, row.sellable_units);
      }
      return { snapshots, sellable };
    },

    async at(stayDate, roomTypeIds, atOrBefore) {
      const result = new Map<string, SnapshotRowAt>();
      for (const rtId of roomTypeIds) {
        const key = cellKey(stayDate, rtId, atOrBefore);
        let hit = memo.get(key);
        if (hit === undefined) {
          hit = (await findSnapshotAt(supabase, hotelId, stayDate, [rtId], atOrBefore)).get(rtId) ?? null;
          memo.set(key, hit);
        }
        if (hit) result.set(rtId, hit);
      }
      return result;
    },

    async sellableAt(stayDate, roomTypeId, ts) {
      const key = cellKey(stayDate, roomTypeId, ts);
      const hit = sellableMemo.get(key);
      if (hit !== undefined) return hit;
      const { data, error } = await supabase
        .from("stay_date_snapshot")
        .select("sellable_units")
        .eq("hotel_id", hotelId)
        .eq("stay_date", stayDate)
        .eq("room_type_id", roomTypeId)
        .eq("snapshot_ts", ts)
        .maybeSingle();
      // Not 0 rooms to sell: that takes the room type out of occupancy.
      if (error) throw new Error(`Failed to load snapshots: ${error.message}`);
      const value = data?.sellable_units ?? 0;
      sellableMemo.set(key, value);
      return value;
    },

    async preload(atOrBefore, firstDate, lastDate, roomTypeIds) {
      if (rpcMissing || roomTypeIds.length === 0) return;
      const found = new Map<string, SnapshotRowAt>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .rpc("snapshot_cells_at", {
            p_hotel_id: hotelId,
            p_ts: atOrBefore,
            p_from: firstDate,
            p_to: lastDate,
            p_room_types: roomTypeIds,
          })
          .order("stay_date", { ascending: true })
          .order("room_type_id", { ascending: true })
          .range(from, from + 999);
        if (error) {
          // Nothing is memoized from a failed or missing preload; each cell
          // is read on its own as before, and that read stops the run when
          // it fails too (findSnapshotAt).
          if (isMissingFunctionError(error)) {
            rpcMissing = true;
            if (!loggedSnapshotCellsMissing) {
              loggedSnapshotCellsMissing = true;
              console.error(
                JSON.stringify({
                  fn: "evaluateHotel",
                  step: "snapshot_cells_at",
                  hotelId,
                  schema: "pre-migration",
                  message: `snapshot_cells_at does not exist yet; baseline snapshots are read one cell at a time. Run ${MIGRATIONS.largePropertyScale}.`,
                  migration: MIGRATIONS.largePropertyScale,
                  error: error.message,
                }),
              );
            }
          } else {
            console.error(
              JSON.stringify({ fn: "evaluateHotel", step: "snapshot_cells_at", hotelId, error: error.message }),
            );
          }
          return;
        }
        const rows = (data ?? []) as Record<string, unknown>[];
        for (const r of rows) {
          found.set(`${r.stay_date}|${r.room_type_id}`, {
            booked_units: Number(r.booked_units),
            booked_revenue: Number(r.booked_revenue),
            snapshot_ts: String(r.snapshot_ts),
          });
        }
        if (rows.length < 1000) break;
      }
      const wanted = new Set(roomTypeIds);
      for (let d = firstDate; d <= lastDate; d = addUtcDays(d, 1)) {
        for (const rtId of wanted) {
          memo.set(cellKey(d, rtId, atOrBefore), found.get(`${d}|${rtId}`) ?? null);
        }
      }
    },

    async preloadAt(cells) {
      // Per instant: the nights and room types asked for, and the spellings
      // of it the callers use as memo keys. Rows come back in the database's
      // own spelling, so they are matched on the instant, not the text.
      type Want = { ms: number; iso: string; keys: Set<string>; nights: Set<string>; types: Set<string>; cells: Set<string> };
      const byMs = new Map<number, Want>();
      for (const c of cells) {
        const ms = Date.parse(c.ts);
        if (!Number.isFinite(ms) || ms >= Date.parse(writtenTs) || c.roomTypeIds.length === 0) continue;
        let w = byMs.get(ms);
        if (!w) {
          w = { ms, iso: new Date(ms).toISOString(), keys: new Set(), nights: new Set(), types: new Set(), cells: new Set() };
          byMs.set(ms, w);
        }
        w.keys.add(c.ts);
        w.nights.add(c.stayDate);
        for (const rtId of c.roomTypeIds) {
          if (memo.has(cellKey(c.stayDate, rtId, c.ts))) continue;
          w.types.add(rtId);
          w.cells.add(`${c.stayDate}|${rtId}`);
        }
      }
      const wants = [...byMs.values()].filter((w) => w.cells.size > 0).sort((a, b) => a.ms - b.ms);
      const chunks: Want[][] = [];
      let chunk: Want[] = [];
      let rows = 0;
      for (const w of wants) {
        const expected = w.nights.size * w.types.size;
        if (chunk.length > 0 && (chunk.length >= EXACT_TERMS_PER_READ || rows + expected > EXACT_ROWS_PER_READ)) {
          chunks.push(chunk);
          chunk = [];
          rows = 0;
        }
        chunk.push(w);
        rows += expected;
      }
      if (chunk.length > 0) chunks.push(chunk);

      for (const part of chunks) {
        const types = [...new Set(part.flatMap((w) => [...w.types]))].sort();
        const terms = part
          .map((w) => `and(snapshot_ts.eq.${w.iso},stay_date.in.(${[...w.nights].sort().join(",")}))`)
          .join(",");
        const byInstant = new Map(part.map((w) => [w.ms, w]));
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase
            .from("stay_date_snapshot")
            .select("stay_date, room_type_id, booked_units, booked_revenue, snapshot_ts")
            .eq("hotel_id", hotelId)
            .in("room_type_id", types)
            .or(terms)
            .order("snapshot_ts", { ascending: true })
            .order("stay_date", { ascending: true })
            .order("room_type_id", { ascending: true })
            .range(from, from + 999);
          if (error) {
            // Nothing is memoized from a failed read: `at` reads each cell,
            // and stops the run when that fails too (findSnapshotAt).
            console.error(JSON.stringify({ fn: "evaluateHotel", step: "snapshots_at_fires", hotelId, error: error.message }));
            break;
          }
          const got = (data ?? []) as Record<string, unknown>[];
          for (const r of got) {
            const w = byInstant.get(Date.parse(String(r.snapshot_ts)));
            const cell = `${r.stay_date}|${r.room_type_id}`;
            if (!w || !w.cells.has(cell)) continue;
            const row: SnapshotRowAt = {
              booked_units: Number(r.booked_units),
              booked_revenue: Number(r.booked_revenue),
              snapshot_ts: String(r.snapshot_ts),
            };
            for (const key of w.keys) memo.set(cellKey(String(r.stay_date), String(r.room_type_id), key), row);
          }
          if (got.length < 1000) break;
        }
      }
    },
  };
}

function addUtcDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Purge snapshots older than the retention window (default 60 days).
 */
/** §3.5 — default60d; pass max(pickup_window_days)+7 when known. */
export async function purgeOldSnapshots(
  supabase: SupabaseClient,
  hotelId: string,
  retentionDays: number = 60,
  opts: { sliceMs?: number; maxSlices?: number; budgetMs?: number } = {},
): Promise<boolean> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffMs = cutoff.getTime();

  // One unbounded delete after a backlog (a paused hotel, a long outage) can
  // be millions of rows in one statement: it times out, and it used to take
  // the audit and run-log purges down with it. Instead the oldest snapshots
  // go a slice of snapshot_ts at a time, up to a small budget per run; the
  // next run carries on. Each delete is a range on the primary key's
  // (hotel_id, snapshot_ts) prefix.
  const sliceMs = opts.sliceMs ?? 3_600_000;
  const maxSlices = opts.maxSlices ?? 24;
  const budgetMs = opts.budgetMs ?? 10_000;
  const started = Date.now();
  for (let slice = 0; slice < maxSlices; slice++) {
    const { data: oldest, error: readError } = await supabase
      .from("stay_date_snapshot")
      .select("snapshot_ts")
      .eq("hotel_id", hotelId)
      .lt("snapshot_ts", cutoff.toISOString())
      .order("snapshot_ts", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (readError) throw new Error(`Snapshot purge failed: ${readError.message}`);
    if (!oldest) return true;

    const sliceEnd = Math.min(Date.parse(String(oldest.snapshot_ts)) + sliceMs, cutoffMs);
    const { error } = await supabase
      .from("stay_date_snapshot")
      .delete()
      .eq("hotel_id", hotelId)
      .lt("snapshot_ts", new Date(sliceEnd).toISOString());
    if (error) throw new Error(`Snapshot purge failed: ${error.message}`);
    if (sliceEnd >= cutoffMs) return true;
    if (Date.now() - started > budgetMs) return false;
  }
  return false;
}
