/**
 * Booking Speed provider — the bridge between the evaluation engine and the
 * Observation Engine (lib/observations).
 *
 * Loaded once per evaluation run, and only when at least one active rule
 * actually carries a booking-speed condition — hotels without such rules
 * pay zero cost. The season model (level + weekly shape + booking pace) is
 * built once, and each (stay date, window) observation is computed once and
 * memoized; the same memo doubles as the audit snapshot source, so what a
 * rule matched on and what the audit records are the same object by
 * construction.
 *
 * The history never comes into memory row by row. Every consumer only asks,
 * per stay date, whether there are rows and how many bookings sit at each
 * booking window, so the database answers with exactly that (see
 * 99_supabase_migration_large_property_scale_v1.sql and
 * 99_supabase_migration_booking_speed_counts_bookings_v1.sql): a per-date
 * summary for the season model, then grouped windows for only the dates the
 * horizon's observations can consult. A 500-room property has over a million
 * room-nights in its history; the old row-by-row read threw past 100,000.
 *
 * Booking speed counts bookings, not rooms: the rows of one reservation are
 * one booking at its earliest booking date (observations/booking-rows.ts
 * bookingKeyOf, the same rule as booking_key() in SQL). The season model's
 * inputs, how full a night got and how early, keep counting rooms against
 * room capacity.
 *
 * A rule measures only its own signal room types. Whether two dates are
 * comparable is a property of the calendar, so season detection and
 * comparable selection stay hotel-wide (one season model per run). What a
 * rule counts, the bookings on the target and on each comparable, comes from
 * its set: rules measuring every counting room type (the default) read the
 * hotel-wide windows exactly as before, and every other set gets its own
 * windows over the same dates, shared by every rule measuring that set.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, daysBetween } from "@/lib/observations/calendar";
import {
  dailyPaceSeriesFromIndex,
  milestoneRanks,
  paceScoreFromRankWindows,
} from "@/lib/observations/booking-pace";
import {
  detectSeasons,
  type DailyDemand,
  type DatePeriod,
  type SeasonModel,
} from "@/lib/observations/seasons";
import {
  selectComparableDates,
  type ComparableSelection,
} from "@/lib/observations/comparable-dates";
import { MOMENTUM_RADIUS_DAYS, MOMENTUM_YEAR_OFFSET_DAYS } from "@/lib/observations/momentum";
import {
  countFromInWindow,
  lastCountedDay,
  observeBookingSpeed,
  windowDaysFrom,
  type BookingSpeedObservation,
} from "@/lib/observations/expected-bookings";
import {
  StayDateWindowsBuilder,
  bookingKeyOf,
  bookingWindowOf,
  earliestBookingWindow,
  pickupInWindowIndexed,
  type SlimReservationRow,
  type StayDateWindows,
} from "@/lib/observations/booking-rows";
import {
  buildReinforcementModel,
  isDateReinforcementExcluded,
  isKnownChallengeReason,
  seasonExclusionPeriods,
  type AssumptionChallenge,
  type ChallengeScope,
} from "@/lib/observations/reinforcement";
import { MIGRATIONS, fetchAllRows, isMissingFunctionError } from "./snapshots";
import type { RuleMetrics } from "./types";

export const HISTORY_YEARS_BACK = 3;
export const DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS = 7;
const PAGE = 1000;
/** Stay dates per booking_speed_windows call; each date comes back as one row. */
const WINDOW_DATES_CHUNK = 400;
/**
 * Before the migration, rows are read in stay-date slices, each keyset paged
 * on (stay_date, id) and folded into the grouped form as it arrives, so
 * memory stays flat. A slice is sized from the rows per day seen so far,
 * aiming at about SLICE_TARGET_ROWS rows, and cut short at a page boundary
 * when it turns out denser: a small hotel reads a few long slices, a 500-room
 * one about a week at a time. Every page is a bounded
 * index range, so a page late in the history costs what the first one did,
 * and a row written mid-read can never shift a page onto rows already counted.
 */
const SLICE_TARGET_ROWS = 4_000;
const MAX_SLICE_DAYS = 366;

export type BookingSpeedContext = {
  /** Hotel-local evaluation date (YYYY-MM-DD). */
  asOf: string;
  /** Grouped bookings per stay date: every date any loaded observation can consult. */
  windowsByDate: Map<string, StayDateWindows>;
  /**
   * The stay dates whose observations are fully covered by windowsByDate.
   * null means everything is loaded (tests build contexts this way).
   */
  loadedTargets?: ReadonlySet<string> | null;
  seasonModel: SeasonModel;
  /** Kept rows (rooms, not bookings) per past stay date: the season model's demand input. */
  dailyDemand: DailyDemand[];
  historyStart: string;
  historyEnd: string;
  isExcluded: (date: string) => boolean;
  selectionCache: Map<string, ComparableSelection>;
  observationCache: Map<string, BookingSpeedObservation>;
  /**
   * signalSetKey of the hotel's counting room types. A rule measuring exactly
   * these reads windowsByDate. Unset when the context was built by hand
   * (tests), and then every observation is hotel-wide.
   */
  hotelSetKey?: string;
  /** Per other signal set (by signalSetKey): its windows over the same dates, see setIndexFrom. */
  setWindows?: Map<string, Map<string, StayDateWindows>>;
  /** The room type ids behind each key in setWindows, sorted. */
  setMeasuredIds?: Map<string, string[]>;
  /**
   * Room types that do not count as rooms. They are dropped from a rule's
   * signal set before it is keyed, the same way the history drops them, so
   * every read path measures the same rows.
   */
  excluded?: ReadonlySet<string>;
  /**
   * Per raise the horizon's readings count from (splitKey: its applied_at
   * and the set read), the bookings on each stay date asked for that were
   * first seen after it, loaded by loadSplitWindows. observeForStayDate
   * reads the raise's own day from here (observeBookingSpeed `split`). A
   * date with no such booking has no entry; splitLoaded says which dates
   * were read.
   */
  splitWindows?: Map<string, Map<string, StayDateWindows>>;
  /**
   * The stay dates read into each splitWindows key, those with no entry
   * included. Unset on a context built by hand (tests): every date of a
   * splitWindows key then counts as read.
   */
  splitLoaded?: Map<string, Set<string>>;
};

/** One key per set of room types, whatever order or repeats the ids come in. */
export function signalSetKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(",");
}

/**
 * The splitWindows key for a fire and the set it is read over ("" for the
 * hotel-wide history). The instant is keyed to the millisecond whatever
 * its spelling ("...Z" from a run, "...+00:00" back from PostgREST).
 */
export function splitKey(since: string, setKey: string): string {
  const ms = Date.parse(since);
  return `${Number.isNaN(ms) ? since : new Date(ms).toISOString()}|${setKey}`;
}

/** The split windows under `key` when `stayDate` was read into them (see splitLoaded), else null. */
function splitRead(ctx: BookingSpeedContext, key: string, stayDate: string): Map<string, StayDateWindows> | null {
  const windows = ctx.splitWindows?.get(key);
  if (!windows) return null;
  const read = ctx.splitLoaded?.get(key);
  return read && !read.has(stayDate) ? null : windows;
}

let loggedPreMigration = false;

function logPreMigrationOnce(hotelId: string, error: unknown): void {
  if (loggedPreMigration) return;
  loggedPreMigration = true;
  console.error(
    JSON.stringify({
      fn: "loadBookingSpeedContext",
      step: "booking_speed_history",
      hotelId,
      schema: "pre-migration",
      message: `booking_speed_history_summary does not exist yet; reading the booking history row by row. Run ${MIGRATIONS.largePropertyScale}.`,
      migration: MIGRATIONS.largePropertyScale,
      error: error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error),
    }),
  );
}

let loggedNoSplit = false;

function logNoSplitOnce(hotelId: string, error: unknown): void {
  if (loggedNoSplit) return;
  loggedNoSplit = true;
  console.error(
    JSON.stringify({
      fn: "loadSplitWindows",
      step: "booking_speed_windows",
      hotelId,
      schema: "pre-migration",
      message: `booking_speed_windows takes no p_since yet; reading the day of each raise row by row. Run ${MIGRATIONS.countsBookings}.`,
      migration: MIGRATIONS.countsBookings,
      error: error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error),
    }),
  );
}

/** Test hook: forget that the pre-migration lines were already logged. */
export function resetBookingSpeedLogOnce(): void {
  loggedPreMigration = false;
  loggedNoSplit = false;
}

/** The dates an observation may consult: target, comparables, momentum neighbors, and their year-ago counterparts. */
export function relevantDates(stayDate: string, selection: ComparableSelection): Set<string> {
  const dates = new Set<string>([stayDate, addDays(stayDate, -MOMENTUM_YEAR_OFFSET_DAYS)]);
  for (const c of selection.comparables) dates.add(c.date);
  for (let offset = -MOMENTUM_RADIUS_DAYS; offset <= MOMENTUM_RADIUS_DAYS; offset++) {
    if (offset === 0) continue;
    const neighbor = addDays(stayDate, offset);
    dates.add(neighbor);
    dates.add(addDays(neighbor, -MOMENTUM_YEAR_OFFSET_DAYS));
  }
  return dates;
}

type SummaryRow = { stay_date: string; n: number; usable: number; rank_windows: (number | null)[] | null };

/**
 * Per-date summary of the history from `historyStart` on: row count, usable
 * windows, and the window at each pace milestone rank. null when the
 * migration has not run.
 */
async function loadHistorySummary(
  supabase: SupabaseClient,
  hotelId: string,
  historyStart: string,
  exclude: string[],
  ranks: number[],
): Promise<SummaryRow[] | null> {
  const out: SummaryRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc("booking_speed_history_summary", {
        p_hotel_id: hotelId,
        p_from: historyStart,
        p_to: null,
        p_exclude: exclude,
        p_ranks: ranks,
      })
      .order("stay_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingFunctionError(error)) {
        logPreMigrationOnce(hotelId, error);
        return null;
      }
      throw new Error(`Failed to load booking history: ${error.message}`);
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      out.push({
        stay_date: String(r.stay_date),
        n: Number(r.n),
        usable: Number(r.usable),
        rank_windows: Array.isArray(r.rank_windows)
          ? (r.rank_windows as unknown[]).map((w) => (w == null ? null : Number(w)))
          : null,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** One grouped row of booking_speed_windows as the engine holds it. */
function windowsOf(r: Record<string, unknown>): StayDateWindows {
  const bws = Array.isArray(r.bws) ? (r.bws as unknown[]) : [];
  const counts = Array.isArray(r.counts) ? (r.counts as unknown[]) : [];
  return {
    n: Number(r.n),
    windows: bws.map((bw, k) => ({ bw: bw == null ? null : Number(bw), n: Number(counts[k]) })),
  };
}

/**
 * Grouped windows for exactly `dates`. null when the migration has not run.
 * With `include`, only rows of those room types count (never a row with no
 * room type), for a rule measuring part of the hotel.
 */
async function loadWindowsForDates(
  supabase: SupabaseClient,
  hotelId: string,
  dates: string[],
  exclude: string[],
  include?: string[],
): Promise<Map<string, StayDateWindows> | null> {
  const out = new Map<string, StayDateWindows>();
  for (let i = 0; i < dates.length; i += WINDOW_DATES_CHUNK) {
    const chunk = dates.slice(i, i + WINDOW_DATES_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .rpc("booking_speed_windows", {
          p_hotel_id: hotelId,
          p_dates: chunk,
          p_exclude: exclude,
          ...(include ? { p_include: include } : {}),
        })
        .order("stay_date", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        if (isMissingFunctionError(error)) {
          logPreMigrationOnce(hotelId, error);
          return null;
        }
        throw new Error(`Failed to load booking history: ${error.message}`);
      }
      const rows = (data ?? []) as Record<string, unknown>[];
      for (const r of rows) out.set(String(r.stay_date), windowsOf(r));
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

/** A (stay date, raise) pair whose day is split at the raise: see loadSplitWindows. */
type SplitPair = { stayDate: string; since: string };

/**
 * For each pair, the bookings on its stay date first seen after its
 * instant, grouped like loadWindowsForDates, by splitKey(since, "") then
 * stay date: booking_speed_windows with p_since, one instant per date
 * (99_supabase_migration_booking_speed_counts_bookings_v1.sql), so any
 * number of raises is one call per chunk of pairs. A pair with no such
 * booking has no row. null when the function predates p_since.
 */
async function loadSplitPairs(
  supabase: SupabaseClient,
  hotelId: string,
  pairs: SplitPair[],
  exclude: string[],
  include?: string[],
): Promise<Map<string, Map<string, StayDateWindows>> | null> {
  const out = new Map<string, Map<string, StayDateWindows>>();
  for (let i = 0; i < pairs.length; i += WINDOW_DATES_CHUNK) {
    const chunk = pairs.slice(i, i + WINDOW_DATES_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .rpc("booking_speed_windows", {
          p_hotel_id: hotelId,
          p_dates: chunk.map((p) => p.stayDate),
          p_exclude: exclude,
          ...(include ? { p_include: include } : {}),
          p_since: chunk.map((p) => p.since),
        })
        .order("stay_date", { ascending: true })
        .order("since", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        if (isMissingFunctionError(error)) {
          logNoSplitOnce(hotelId, error);
          return null;
        }
        throw new Error(`Failed to load booking history: ${error.message}`);
      }
      const rows = (data ?? []) as Record<string, unknown>[];
      for (const r of rows) {
        const key = splitKey(String(r.since), "");
        const byDate = out.get(key) ?? new Map<string, StayDateWindows>();
        byDate.set(String(r.stay_date), windowsOf(r));
        out.set(key, byDate);
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

/**
 * Pre-migration path: every row from `historyStart` to `upTo`, read in
 * stay-date slices and folded into the grouped form a page at a time.
 *
 * The keyset filter over the whole history, `stay_date > X or (stay_date = X
 * and id > Y)`, could not bound the index on its own, so each page rescanned
 * the history from the start. Inside a slice the stay-date range bounds it,
 * and the cursor only trims the slice, so pages stay cheap and a concurrent
 * write cannot double count or skip a row the way offset paging could.
 * There is no row budget any more: nothing but the per-date counts is held,
 * and a fixed ceiling failed every run for a full 500-room hotel.
 *
 * Rows arrive in stay-date order, so each night's rows are folded into one
 * booking per reservation (StayDateWindowsBuilder) and let go of as soon as
 * the next night starts: at most one night's bookings are held at a time.
 * `rooms` is the same history counted a row at a time, for the season model.
 *
 * `sets` are signal sets (by signalSetKey) folded in the same pass: a row
 * counts toward a set only when its room type is in it, so a row with no
 * room type only ever counts toward the hotel. `firstBySet` is each set's
 * earliest stay date read (see setIndexFrom).
 */
async function loadWindowsByRows(
  supabase: SupabaseClient,
  hotelId: string,
  historyStart: string,
  upTo: string,
  excludeRoomTypeIds: ReadonlySet<string>,
  sets: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Promise<{
  hotel: Map<string, StayDateWindows>;
  rooms: Map<string, StayDateWindows>;
  sets: Map<string, Map<string, StayDateWindows>>;
  firstBySet: Map<string, string | null>;
}> {
  const hotel = new StayDateWindowsBuilder("bookings");
  const rooms = new StayDateWindowsBuilder("rooms");
  const setBuilders = new Map<string, StayDateWindowsBuilder>(
    [...sets.keys()].map((k) => [k, new StayDateWindowsBuilder("bookings")]),
  );
  const firstBySet = new Map<string, string | null>([...sets.keys()].map((k) => [k, null]));
  let openDate: string | null = null;
  const fold = (r: Record<string, unknown>) => {
    if (r.room_type_id != null && excludeRoomTypeIds.has(String(r.room_type_id))) return;
    const stayDate = String(r.stay_date);
    if (openDate !== null && stayDate !== openDate) {
      hotel.seal(openDate);
      rooms.seal(openDate);
      for (const b of setBuilders.values()) b.seal(openDate);
    }
    openDate = stayDate;
    const row = {
      stay_date: stayDate,
      booking_date: r.booking_date != null ? String(r.booking_date) : null,
      booking_window_days: r.booking_window_days != null ? Number(r.booking_window_days) : null,
      external_reservation_id: r.external_reservation_id != null ? String(r.external_reservation_id) : null,
    };
    hotel.add(row);
    rooms.add(row);
    if (r.room_type_id == null) return;
    const roomTypeId = String(r.room_type_id);
    for (const [key, ids] of sets) {
      if (!ids.has(roomTypeId)) continue;
      setBuilders.get(key)!.add(row);
      const first = firstBySet.get(key);
      if (first == null || stayDate < first) firstBySet.set(key, stayDate);
    }
  };

  // Start small: nothing is known about the hotel's size yet.
  let sliceDays = 7;
  for (let sliceFrom = historyStart; sliceFrom <= upTo; ) {
    const end = addDays(sliceFrom, sliceDays - 1);
    let sliceTo = end < upTo ? end : upTo;
    let sliceRows = 0;
    // The cursor starts fresh in every slice.
    let cursor: { stayDate: string; id: string } | null = null;
    for (;;) {
      let q = supabase
        .from("reservations")
        .select("id, stay_date, booking_date, booking_window_days, room_type_id, external_reservation_id")
        .eq("hotel_id", hotelId)
        .gte("stay_date", sliceFrom)
        .lte("stay_date", sliceTo);
      if (cursor) {
        q = q.or(`stay_date.gt.${cursor.stayDate},and(stay_date.eq.${cursor.stayDate},id.gt.${cursor.id})`);
      }
      const { data, error } = await q
        .order("stay_date", { ascending: true })
        .order("id", { ascending: true })
        .limit(PAGE);
      // A mid-run failure is not the end of the history. Treating it as one
      // silently truncated the reservation set, so every stay date past the
      // cut-off measured as having no bookings and read as Stalled.
      if (error) {
        throw new Error(`Failed to load booking history: ${error.message}`);
      }
      const rows = (data ?? []) as Record<string, unknown>[];
      if (rows.length === PAGE && sliceRows + rows.length >= SLICE_TARGET_ROWS) {
        // Denser than the slice was sized for. Rows come in date order, so
        // everything read so far is also the start of a slice ending at this
        // page's last date: end it there, finish that date and move on. No
        // page ever sits deeper than about the target plus one night.
        const last = String(rows[rows.length - 1].stay_date);
        if (last < sliceTo) sliceTo = last;
      }
      for (const r of rows) fold(r);
      sliceRows += rows.length;
      if (rows.length < PAGE) break;
      const tail = rows[rows.length - 1];
      cursor = { stayDate: String(tail.stay_date), id: String(tail.id) };
    }
    const perDay = sliceRows / (daysBetween(sliceFrom, sliceTo) + 1);
    sliceDays = perDay > 0 ? Math.min(MAX_SLICE_DAYS, Math.max(1, Math.floor(SLICE_TARGET_ROWS / perDay))) : MAX_SLICE_DAYS;
    sliceFrom = addDays(sliceTo, 1);
  }

  // build() seals the last night and sorts the dates, so the maps never
  // depend on paging.
  return {
    hotel: hotel.build(),
    rooms: rooms.build(),
    sets: new Map([...setBuilders].map(([key, b]) => [key, b.build()])),
    firstBySet,
  };
}

/**
 * One signal set's index over the dates this run consults.
 *
 * "No rows" means something different for part of a hotel. A Suite date
 * that sold nothing while the hotel was open is a real zero; dropping it as
 * "no data" would lift the expectation and read the Suites as slower than
 * they are. But before the Suites had ever sold (a room type added last
 * year), a zero is not evidence either, and counting it would read them as
 * faster. So a date has data for the set when the hotel has rows that day
 * and the date is on or after `first`, the set's earliest stay date in the
 * whole history from historyStart. It is never taken from the consulted
 * dates alone: those depend on how far ahead the run prices, and the same
 * stay date has to read the same way on a 45-day run and a 365-day one.
 * The entry's `n` is the hotel's, marking that presence; its windows are the
 * set's own.
 */
export function setIndexFrom(
  hotel: ReadonlyMap<string, StayDateWindows>,
  set: ReadonlyMap<string, StayDateWindows>,
  consulted: ReadonlySet<string>,
  first: string | null,
): Map<string, StayDateWindows> {
  const out = new Map<string, StayDateWindows>();
  if (first === null) return out;
  for (const [d, entry] of hotel) {
    if (d < first || !consulted.has(d)) continue;
    out.set(d, { n: entry.n, windows: set.get(d)?.windows ?? [] });
  }
  return out;
}

/**
 * The earliest stay date on or after `from` with a row of one of `include`,
 * or null when there is none. `undefined` when the migration has not run.
 */
async function loadFirstStayDate(
  supabase: SupabaseClient,
  hotelId: string,
  from: string,
  include: string[],
): Promise<string | null | undefined> {
  const { data, error } = await supabase.rpc("booking_speed_first_stay_date", {
    p_hotel_id: hotelId,
    p_from: from,
    p_include: include,
  });
  if (error) {
    if (isMissingFunctionError(error)) {
      logPreMigrationOnce(hotelId, error);
      return undefined;
    }
    throw new Error(`Failed to load booking history: ${error.message}`);
  }
  const row = ((data ?? []) as Record<string, unknown>[])[0];
  return row?.first_stay_date != null ? String(row.first_stay_date) : null;
}

/**
 * Whether any kept row exists after `after`. Only asked when the pre-migration
 * read found nothing up to the end of the horizon, so "no history at all" is
 * still decided over every future row, as it always was.
 */
async function hasKeptRowAfter(
  supabase: SupabaseClient,
  hotelId: string,
  after: string,
  excludeRoomTypeIds: ReadonlySet<string>,
): Promise<boolean> {
  let q = supabase
    .from("reservations")
    .select("id")
    .eq("hotel_id", hotelId)
    .gt("stay_date", after);
  if (excludeRoomTypeIds.size > 0) {
    q = q.or(`room_type_id.is.null,room_type_id.not.in.(${[...excludeRoomTypeIds].join(",")})`);
  }
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`Failed to load booking history: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * loadSplitPairs read row by row, for a database whose booking_speed_windows
 * predates p_since: the rows of every stay date asked for in one paged
 * read, then for each raise the bookings on its dates first seen after it,
 * folded like loadWindowsByRows folds the history (the same builder, given
 * since). The kept rows are chosen exactly as the function chooses them:
 * `include` keeps only those room types, otherwise every row except the
 * excluded types (a row with no room type stays).
 */
async function loadSplitPairsByRows(
  supabase: SupabaseClient,
  hotelId: string,
  pairs: SplitPair[],
  excludeRoomTypeIds: ReadonlySet<string>,
  include: readonly string[] | null,
): Promise<Map<string, Map<string, StayDateWindows>>> {
  const dates = [...new Set(pairs.map((p) => p.stayDate))].sort();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    rows = await fetchAllRows(() =>
      supabase
        .from("reservations")
        .select("id, stay_date, booking_date, booking_window_days, room_type_id, external_reservation_id, created_at")
        .eq("hotel_id", hotelId)
        .in("stay_date", dates)
        .order("stay_date", { ascending: true })
        .order("id", { ascending: true }),
    );
  } catch (e) {
    throw new Error(`Failed to load booking history: ${e instanceof Error ? e.message : String(e)}`);
  }
  const wanted = include ? new Set(include) : null;
  const kept: SlimReservationRow[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const roomTypeId = r.room_type_id != null ? String(r.room_type_id) : null;
    if (wanted ? roomTypeId === null || !wanted.has(roomTypeId) : roomTypeId !== null && excludeRoomTypeIds.has(roomTypeId)) {
      continue;
    }
    kept.push({
      stay_date: String(r.stay_date),
      booking_date: r.booking_date != null ? String(r.booking_date) : null,
      booking_window_days: r.booking_window_days != null ? Number(r.booking_window_days) : null,
      external_reservation_id: r.external_reservation_id != null ? String(r.external_reservation_id) : null,
      created_at: r.created_at != null ? String(r.created_at) : null,
    });
  }
  const datesBySince = new Map<string, { since: string; dates: Set<string> }>();
  for (const p of pairs) {
    const key = splitKey(p.since, "");
    const entry = datesBySince.get(key) ?? { since: p.since, dates: new Set<string>() };
    entry.dates.add(p.stayDate);
    datesBySince.set(key, entry);
  }
  const out = new Map<string, Map<string, StayDateWindows>>();
  for (const [key, { since, dates: asked }] of datesBySince) {
    const builder = new StayDateWindowsBuilder("bookings", since);
    for (const row of kept) if (asked.has(row.stay_date)) builder.add(row);
    out.set(key, builder.build());
  }
  return out;
}

/** One raise a reading counts from on a night, and the room types the rule measures. */
export type SplitNeed = { since: string; stayDate: string; signalIds: readonly string[] };

/**
 * Load into ctx.splitWindows, for every raise in `needs`, the bookings on
 * the nights it is asked for that were first seen after it, over the set
 * each rule reads (the hotel-wide history, or a set of room types, keyed
 * as observeForStayDate keys them). One read per set however many raises
 * and nights (loadSplitPairs: booking_speed_windows given each night's
 * instant, or row by row while the function predates p_since). What was
 * read is kept per raise and set with the nights it was read for
 * (splitLoaded): a raise and set already read for some nights is read
 * again for the others only, and merged in. Throws on a failed read, like
 * every other history read: an observation that quietly counted the
 * raise's whole day would re-count the burst it fired on.
 */
export async function loadSplitWindows(
  supabase: SupabaseClient,
  hotelId: string,
  ctx: BookingSpeedContext,
  needs: readonly SplitNeed[],
): Promise<void> {
  const splitWindows = (ctx.splitWindows ??= new Map());
  const splitLoaded = (ctx.splitLoaded ??= new Map());
  type Group = { include: string[] | null; pairs: Map<string, SplitPair> };
  const groups = new Map<string, Group>();
  for (const need of needs) {
    const kept = ctx.excluded ? need.signalIds.filter((id) => !ctx.excluded!.has(id)) : [...need.signalIds];
    const key = signalSetKey(kept);
    const setPart = ctx.hotelSetKey !== undefined && key !== ctx.hotelSetKey ? key : "";
    if (splitLoaded.get(splitKey(need.since, setPart))?.has(need.stayDate)) continue;
    let group = groups.get(setPart);
    if (!group) {
      group = { include: setPart ? setPart.split(",") : null, pairs: new Map() };
      groups.set(setPart, group);
    }
    group.pairs.set(`${need.stayDate}|${splitKey(need.since, "")}`, { stayDate: need.stayDate, since: need.since });
  }
  const exclude = [...(ctx.excluded ?? [])].sort();
  for (const [setPart, group] of groups) {
    const pairs = [...group.pairs.values()].sort(
      (a, b) => a.stayDate.localeCompare(b.stayDate) || Date.parse(a.since) - Date.parse(b.since),
    );
    const loaded =
      (await loadSplitPairs(supabase, hotelId, pairs, exclude, group.include ?? undefined)) ??
      (await loadSplitPairsByRows(supabase, hotelId, pairs, ctx.excluded ?? new Set(), group.include));
    for (const { stayDate, since } of pairs) {
      const key = splitKey(since, setPart);
      const windows = splitWindows.get(key) ?? new Map<string, StayDateWindows>();
      const read = splitLoaded.get(key) ?? new Set<string>();
      const entry = loaded.get(splitKey(since, ""))?.get(stayDate);
      if (entry) windows.set(stayDate, entry);
      read.add(stayDate);
      splitWindows.set(key, windows);
      splitLoaded.set(key, read);
    }
  }
}

/**
 * Load everything booking-speed evaluation needs for one hotel run.
 * Returns null when the hotel has no reservation rows at all — conditions
 * then block with "insufficient_data" rather than matching on nothing.
 *
 * `excludeRoomTypeIds` are the room types that do not count as rooms. Their
 * bookings are dropped from the history because `totalCapacity` is summed
 * without them: a court selling six slots a night against a 20-room
 * capacity would otherwise read as the hotel filling up. A row with no
 * room type is kept — there is no evidence it was not a room.
 *
 * `horizonEnd` is the last stay date this run prices. Observations can be
 * taken for any stay date from `localDate` through it, and no other.
 *
 * `countingRoomTypeIds` are the room types that count as rooms, and
 * `signalSets` the signal room types of every Booking Speed rule. A set
 * equal to the counting types is the hotel-wide history; any other set gets
 * its own windows (see setIndexFrom). Ids in `excludeRoomTypeIds` are dropped
 * from every set first.
 */
export async function loadBookingSpeedContext(
  supabase: SupabaseClient,
  hotelId: string,
  localDate: string,
  totalCapacity: number,
  excludeRoomTypeIds: ReadonlySet<string> = new Set(),
  horizonEnd: string = localDate,
  countingRoomTypeIds: readonly string[] = [],
  signalSets: readonly (readonly string[])[] = [],
): Promise<BookingSpeedContext | null> {
  const historyStart = addDays(localDate, -(HISTORY_YEARS_BACK * 366));
  const historyEnd = addDays(localDate, -1);
  const exclude = [...excludeRoomTypeIds].sort();
  const hotelSetKey = signalSetKey(countingRoomTypeIds);
  const setIds = new Map<string, ReadonlySet<string>>();
  for (const ids of signalSets) {
    const kept = ids.filter((id) => !excludeRoomTypeIds.has(id));
    const key = signalSetKey(kept);
    if (key !== hotelSetKey && key !== "") setIds.set(key, new Set(kept));
  }
  const targets: string[] = [];
  for (let d = localDate; d <= horizonEnd; d = addDays(d, 1)) targets.push(d);

  // Season inputs come from fully observed (past) dates only — future
  // dates' booking curves are still being written and would read as
  // artificially quiet/slow.
  const daily: DailyDemand[] = [];
  let pace: DailyDemand[] = [];
  let windowsByDate: Map<string, StayDateWindows> | null = null;
  let setRows: Map<string, Map<string, StayDateWindows>> | null = null;
  let setFirst: Map<string, string | null> | null = null;

  const ranks = totalCapacity > 0 ? milestoneRanks(totalCapacity) : [];
  const summary = await loadHistorySummary(supabase, hotelId, historyStart, exclude, ranks);
  if (summary) {
    if (summary.length === 0) return null;
    for (const row of summary) {
      if (row.stay_date > historyEnd) continue;
      daily.push({ stay_date: row.stay_date, value: row.n });
      // dailyPaceSeries only scores dates that have a usable window.
      if (totalCapacity > 0 && row.usable > 0) {
        pace.push({ stay_date: row.stay_date, value: paceScoreFromRankWindows(row.rank_windows ?? []) });
      }
    }
  } else {
    // Momentum reaches MOMENTUM_RADIUS_DAYS past the last priced date; no
    // observation reads anything later.
    const upTo = addDays(horizonEnd, MOMENTUM_RADIUS_DAYS);
    const byRows = await loadWindowsByRows(supabase, hotelId, historyStart, upTo, excludeRoomTypeIds, setIds);
    windowsByDate = byRows.hotel;
    setRows = byRows.sets;
    setFirst = byRows.firstBySet;
    if (windowsByDate.size === 0 && !(await hasKeptRowAfter(supabase, hotelId, upTo, excludeRoomTypeIds))) {
      return null;
    }
    // The season model reads rooms, as the summary function gives it: how
    // full each past night got, and how early.
    const history = new Map<string, StayDateWindows>();
    for (const [stayDate, entry] of byRows.rooms) {
      if (stayDate > historyEnd) continue;
      history.set(stayDate, entry);
      daily.push({ stay_date: stayDate, value: entry.n });
    }
    if (totalCapacity > 0) pace = dailyPaceSeriesFromIndex(history, totalCapacity);
  }
  daily.sort((a, b) => a.stay_date.localeCompare(b.stay_date));
  pace.sort((a, b) => a.stay_date.localeCompare(b.stay_date));

  const { data: closed } = await supabase
    .from("hotel_closed_periods")
    .select("start_date, end_date")
    .eq("hotel_id", hotelId);
  const exclusions: DatePeriod[] = (closed ?? []).map((p) => ({
    start_date: String(p.start_date),
    end_date: String(p.end_date),
  }));

  // Owner-raised challenges: every flagged date stops being comparable
  // immediately; corroborated recurring windows widen that to every year,
  // and improve_future promotions also come out of season detection's input.
  // (other_text is deliberately not selected — the model never reads it.)
  const { data: challengeRows } = await supabase
    .from("assumption_challenges")
    .select("id, challenged_date, reason_key, scope, created_at")
    .eq("hotel_id", hotelId);
  const challenges: AssumptionChallenge[] = (challengeRows ?? [])
    .filter((c) => isKnownChallengeReason(String(c.reason_key)))
    .map((c) => {
      // created_at truncates to a UTC date; for hotels west of UTC an
      // evening challenge lands "tomorrow" and the model's freshness filter
      // would drop it as future-dated, breaking the promised next-run
      // effect. Clamp to the hotel-local evaluation date — a challenge can
      // never be fresher than the run reading it.
      const raised = String(c.created_at).slice(0, 10);
      return {
        id: String(c.id),
        date: String(c.challenged_date),
        reasonKey: String(c.reason_key),
        scope: String(c.scope) as ChallengeScope,
        raisedAt: raised > localDate ? localDate : raised,
      };
    });
  const reinforcement = buildReinforcementModel(challenges, { now: localDate });

  const isExcluded = (date: string) =>
    exclusions.some((p) => date >= p.start_date && date <= p.end_date) ||
    isDateReinforcementExcluded(reinforcement, date);

  // Season detection skips closed periods, every individually flagged date
  // (a flagged date stops being season-modeling input immediately — the
  // module's contract), and any challenge windows that earned
  // improve_future promotion.
  const seasonExclusions = exclusions
    .concat(
      [...reinforcement.instanceExclusions].map((d) => ({ start_date: d, end_date: d })),
    )
    .concat(
      seasonExclusionPeriods(
        reinforcement,
        Number(historyStart.slice(0, 4)),
        Number(historyEnd.slice(0, 4)),
      ),
    );
  const seasonModel = detectSeasons(daily, {
    exclusions: seasonExclusions,
    ...(pace.length > 0 ? { pace } : {}),
  });

  const ctx: BookingSpeedContext = {
    asOf: localDate,
    windowsByDate: windowsByDate ?? new Map(),
    loadedTargets: new Set(targets),
    seasonModel,
    dailyDemand: daily,
    historyStart,
    historyEnd,
    isExcluded,
    selectionCache: new Map(),
    observationCache: new Map(),
    hotelSetKey,
    setWindows: new Map(),
    setMeasuredIds: new Map([...setIds.keys()].map((k) => [k, k.split(",")])),
    excluded: excludeRoomTypeIds,
  };

  // Now that the season model exists, each target's comparables are known,
  // so only the dates its observations can read are fetched.
  let wanted: Set<string> | null = null;
  if (!windowsByDate || setIds.size > 0) {
    wanted = new Set<string>();
    for (const target of targets) {
      for (const d of relevantDates(target, selectionFor(ctx, target))) {
        if (d >= historyStart) wanted.add(d);
      }
    }
  }

  if (!windowsByDate && wanted) {
    const dates = [...wanted].sort();
    const readByRows = () =>
      loadWindowsByRows(
        supabase,
        hotelId,
        historyStart,
        addDays(horizonEnd, MOMENTUM_RADIUS_DAYS),
        excludeRoomTypeIds,
        setIds,
      );
    const loaded = await loadWindowsForDates(supabase, hotelId, dates, exclude);
    if (loaded) {
      ctx.windowsByDate = loaded;
      const sets = new Map<string, Map<string, StayDateWindows>>();
      const firsts = new Map<string, string | null>();
      for (const [key, ids] of setIds) {
        const include = [...ids].sort();
        const got = await loadWindowsForDates(supabase, hotelId, dates, exclude, include);
        const first = got ? await loadFirstStayDate(supabase, hotelId, historyStart, include) : undefined;
        if (!got || first === undefined) {
          // The windows function predates include lists: one rows pass
          // answers every set.
          sets.clear();
          break;
        }
        sets.set(key, got);
        firsts.set(key, first);
      }
      if (sets.size === setIds.size) {
        setRows = sets;
        setFirst = firsts;
      } else {
        const byRows = await readByRows();
        setRows = byRows.sets;
        setFirst = byRows.firstBySet;
      }
    } else {
      const byRows = await readByRows();
      ctx.windowsByDate = byRows.hotel;
      setRows = byRows.sets;
      setFirst = byRows.firstBySet;
    }
  }

  if (wanted && setRows) {
    for (const key of setIds.keys()) {
      ctx.setWindows!.set(
        key,
        setIndexFrom(ctx.windowsByDate, setRows.get(key) ?? new Map(), wanted, setFirst?.get(key) ?? null),
      );
    }
  }

  return ctx;
}

function selectionFor(ctx: BookingSpeedContext, stayDate: string): ComparableSelection {
  let selection = ctx.selectionCache.get(stayDate);
  if (!selection) {
    selection = selectComparableDates(stayDate, {
      seasonModel: ctx.seasonModel,
      historyStart: ctx.historyStart,
      historyEnd: ctx.historyEnd,
      isExcluded: ctx.isExcluded,
    });
    ctx.selectionCache.set(stayDate, selection);
  }
  return selection;
}

/**
 * Whether a rule reads complete hotel days only, its stretch ending
 * yesterday: a rule that cuts does, on the night and on every night it is
 * compared with alike (Jake, 2026-09-17: slowdown checks count full hotel
 * days ending yesterday, speed-up checks may count today so far). A rule
 * that raises counts today so far.
 */
export function countsCompleteDays(direction?: "increase" | "decrease" | null): boolean {
  return direction === "decrease";
}

/**
 * Whether a rule that counts from a change inside its window still needs
 * the bookings since then to beat what a night like it gets in its whole
 * window (observeBookingSpeed wholeWindowBar): a rule that raises on "at
 * least" a pace, which fewer bookings can only make harder to reach. So
 * after 10 bookings at once raise the rule for 10 in a week, 3 more don't
 * raise the rule for 5 and 5 more do (Jake's examples, 2026-09-24): read
 * against what a night like it gets in the hours since the raise, about
 * none, the 3 would read much faster. A rule that cuts, or raises on "at
 * most" or "exactly" a pace, compares the same days on both sides, since
 * a few days against a whole window's usual would read slow and make
 * those conditions easier to meet.
 */
export function keepsWholeWindowBar(
  direction?: "increase" | "decrease" | null,
  operator?: string | null,
): boolean {
  return !countsCompleteDays(direction) && operator === "at_least";
}

/**
 * Memoized Layer 1 observation for one (stay date, trailing window) over the
 * rule's signal room types. Without them, or when they are the hotel's
 * counting types, it is the hotel-wide observation, keyed as it always was.
 * Any other set is keyed by the set too, so rules sharing a set share the
 * work, and the observation names the room types it measured. Room types
 * that do not count as rooms are dropped from the set first, as the load did.
 *
 * `direction` is the rule's. A rule that cuts reads complete days only
 * (countsCompleteDays): its stretch ends yesterday, and the observation is
 * keyed apart from a raise rule's on the same window.
 *
 * `countFrom` is the first booking date a rule may count on a night it
 * already raised or cut (bookingSpeedCountFrom in pickup.ts), and `since`
 * the raise it is the day of: that day counts only the bookings first seen
 * after the fire, from ctx.splitWindows (loadSplitWindows must have loaded
 * that fire over this set and night first, or this throws). Without
 * `since`, countFrom's day counts whole; a cut rule never passes one, and
 * one passed with a cut is ignored. When countFrom cuts the window short or
 * splits its first day, the observation counts only those days on the
 * target, and is keyed by them too: a rule on the same window may count
 * from elsewhere on another room type, or in the other direction. Its
 * comparables are read over those same days, or with `wholeWindowBar`
 * (keepsWholeWindowBar: a rule that raises on "at least" a pace) over the
 * rule's whole window, keyed apart; one passed with a cut is ignored. The
 * cut observation says whether a raise or a cut started it (countedAfter),
 * so the drill-down can say which. A countFrom that leaves no whole day to
 * count throws; the engine checks windowDaysFrom first.
 */
export function observeForStayDate(
  ctx: BookingSpeedContext,
  stayDate: string,
  windowDays: number,
  signalIds?: readonly string[],
  countFrom?: string | null,
  direction?: "increase" | "decrease" | null,
  since?: string | null,
  wholeWindowBar?: boolean,
): BookingSpeedObservation {
  const setKey =
    signalIds && ctx.hotelSetKey !== undefined
      ? signalSetKey(ctx.excluded ? signalIds.filter((id) => !ctx.excluded!.has(id)) : signalIds)
      : null;
  const measuresSet = setKey !== null && setKey !== ctx.hotelSetKey;
  const completeDays = countsCompleteDays(direction);
  const last = lastCountedDay(ctx.asOf, completeDays);
  const splits = since && !completeDays ? since : null;
  // A countFrom before the window's first day changes nothing, and so does
  // one on it with no fire to split that day by: both share the plain
  // observation. No "|" in the window part: the audit snapshot filter reads
  // the set key after the second one.
  const inWindow = countFromInWindow(windowDays, last, countFrom);
  const cutFrom = countFrom && inWindow && (splits || windowDaysFrom(windowDays, last, countFrom) < windowDays) ? countFrom : null;
  const cutSince = cutFrom && splits ? splits : null;
  const whole = cutFrom !== null && wholeWindowBar === true && !completeDays;
  const countedAfter: BookingSpeedObservation["countedAfter"] | null = cutFrom
    ? direction === "decrease"
      ? "cut"
      : "raise"
    : null;
  // Complete days ("c") end yesterday: never the same reading as today's.
  const stretchKey = `${windowDays}${completeDays ? "c" : ""}`;
  const windowKey = cutFrom
    ? `${stretchKey}>${cutFrom}${cutSince ? `@${cutSince}` : ""}:${countedAfter}${whole ? ":whole" : ""}`
    : stretchKey;
  const key = measuresSet ? `${stayDate}|${windowKey}|${setKey}` : `${stayDate}|${windowKey}`;
  const hit = ctx.observationCache.get(key);
  if (hit) return hit;
  const index = measuresSet ? ctx.setWindows?.get(setKey) : ctx.windowsByDate;
  if (!index) {
    throw new Error(`Booking speed history was not loaded for room types ${setKey}`);
  }
  const splitIndex = cutSince ? splitRead(ctx, splitKey(cutSince, measuresSet ? setKey : ""), stayDate) : null;
  if (cutSince && !splitIndex) {
    throw new Error(`Booking speed history was not loaded for the fire at ${cutSince} on ${stayDate}, room types ${setKey ?? "all"}`);
  }

  // Only the horizon's dates were loaded. Anything else would read missing
  // dates as having no bookings, so refuse rather than answer wrongly.
  if (ctx.loadedTargets && !ctx.loadedTargets.has(stayDate)) {
    throw new Error(`Booking speed history was not loaded for stay date ${stayDate}`);
  }

  const selection = selectionFor(ctx, stayDate);

  // The grouped index answers exactly what the rows did: every date the
  // observation consults (target, comparables, momentum neighbors and their
  // year-ago dates, see relevantDates) is in it, and nothing else is read.
  const observed = observeBookingSpeed({
    index,
    target: stayDate,
    asOf: ctx.asOf,
    selection,
    windowDays,
    completeDays,
    countFrom: cutFrom,
    split: cutSince && splitIndex ? { since: cutSince, index: splitIndex } : null,
    wholeWindowBar: whole,
    isExcluded: ctx.isExcluded,
  });
  const stamped = countedAfter ? { ...observed, countedAfter } : observed;
  const observation = measuresSet
    ? { ...stamped, measuredRoomTypeIds: ctx.setMeasuredIds?.get(setKey) ?? setKey.split(",") }
    : stamped;
  ctx.observationCache.set(key, observation);
  return observation;
}

/** Flatten an observation into the compact RuleMetrics shape conditions match against. */
export function bookingSpeedMetrics(
  observation: BookingSpeedObservation,
): NonNullable<RuleMetrics["booking_speed"]> {
  return {
    speed: observation.classification.speed,
    rank: observation.classification.rank,
    label: observation.classification.label,
    recent: observation.recentBookings,
    expected: observation.expectedBookings,
    window_days: observation.windowDays,
    method: observation.method,
    ...(observation.countedFrom
      ? {
          counted_from: observation.countedFrom,
          full_window_days: observation.fullWindowDays,
          ...(observation.countedSince ? { counted_since: observation.countedSince } : {}),
          ...(observation.expectedOverFullWindow ? { expected_over_full_window: true as const } : {}),
        }
      : {}),
    ...(observation.countedThrough ? { counted_through: observation.countedThrough } : {}),
  };
}

/**
 * Every observation consulted for a stay date this run — the audit snapshot.
 * Hotel-wide observations always belong; one over a narrower set only when
 * its key is in `allowedSetKeys`, so a cell records the sets of the rules
 * that change it and not another rule's.
 */
export function bookingSpeedAuditSnapshots(
  ctx: BookingSpeedContext,
  stayDate: string,
  allowedSetKeys?: ReadonlySet<string>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const prefix = `${stayDate}|`;
  for (const [key, observation] of ctx.observationCache) {
    if (!key.startsWith(prefix)) continue;
    const bar = key.indexOf("|", prefix.length);
    if (bar !== -1 && !allowedSetKeys?.has(key.slice(bar + 1))) continue;
    out.push(observation as unknown as Record<string, unknown>);
  }
  return out;
}

/** True while `anchorAt` is less than `waitDays` whole days (in milliseconds) before `nowIso`. */
export function isWithinCooldown(
  lastAppliedAt: string | null | undefined,
  nowIso: string,
  cooldownDays: number,
): boolean {
  if (!lastAppliedAt) return false;
  return Date.parse(nowIso) - Date.parse(lastAppliedAt) < cooldownDays * 86_400_000;
}

/**
 * Bookings still on the books for `stayDate` whose booking date falls in
 * [windowFrom, windowTo] (hotel dates, both included), over the rule's
 * signal room types: the count observeForStayDate called recentBookings when
 * the window ended on windowTo, re-read from this run's history, in the same
 * unit (a reservation with several rooms is one booking, and stays one until
 * its last room on the night cancels). Bookings made after the window can't
 * move it. With `since` (the fire's window_since), windowFrom's day is read
 * as the fire counted it: only the bookings first seen after that instant,
 * from ctx.splitWindows (loadSplitWindows must have loaded that fire over
 * this set). windowTo's day is read whole, as the fire's own day belongs to
 * it; bookingsStillBookedFromFire leaves out what came after the fire.
 *
 * null when this run did not load the night, the set's history or that
 * split: nothing can be said, so nothing is taken off on it.
 */
export function bookingsInFrozenWindow(
  ctx: BookingSpeedContext,
  stayDate: string,
  windowFrom: string,
  windowTo: string,
  signalIds?: readonly string[],
  since?: string | null,
): number | null {
  const frozen = frozenWindowOf(ctx, stayDate, windowFrom, windowTo, signalIds);
  if (!frozen) return null;
  const { index, setPart, daysOut, days } = frozen;
  if (!since) return pickupInWindowIndexed(index, stayDate, daysOut, days);
  const split = splitRead(ctx, splitKey(since, setPart), stayDate);
  if (!split) return null;
  return pickupInWindowIndexed(index, stayDate, daysOut, days - 1) + pickupInWindowIndexed(split, stayDate, daysOut + days - 1, 1);
}

/**
 * The bookings a fire counted in its frozen window that are still on the
 * books: bookingsInFrozenWindow, less the bookings in that window first
 * seen after the fire itself (`firedAt`, its applied_at; late arrivals with
 * a booking date inside the window, and later bookings on the fire's own
 * day), read from ctx.splitWindows at that instant (loadSplitWindows must
 * have loaded it over this set and night). So it only ever goes down, and
 * only when bookings the fire counted cancel, however long after: what the
 * fire saw, minus what has cancelled since. null when anything it needs was
 * not loaded.
 */
export function bookingsStillBookedFromFire(
  ctx: BookingSpeedContext,
  stayDate: string,
  windowFrom: string,
  windowTo: string,
  signalIds: readonly string[] | undefined,
  since: string | null | undefined,
  firedAt: string,
): number | null {
  const counted = bookingsInFrozenWindow(ctx, stayDate, windowFrom, windowTo, signalIds, since);
  if (counted === null) return null;
  const frozen = frozenWindowOf(ctx, stayDate, windowFrom, windowTo, signalIds);
  if (!frozen) return null;
  const after = splitRead(ctx, splitKey(firedAt, frozen.setPart), stayDate);
  if (!after) return null;
  return counted - pickupInWindowIndexed(after, stayDate, frozen.daysOut, frozen.days);
}

/**
 * One reservation row on a night, as the booking it belongs to: its key
 * (bookingKeyOf its PMS id, or the row's own id for a row without one), its
 * room type, its booking window on the night (bookingWindowOf) and when it
 * first reached MAYA.
 */
export type NightBookingRow = {
  key: string;
  room_type_id: string | null;
  bw: number | null;
  created_at: string | null;
};

/**
 * Every row on each of `stayDates` now, as NightBookingRow, in one paged
 * read: what a change's booking speed window is recorded from
 * (windowBookingKeys) and what its cancellation check finds still booked
 * (bookingKeysOnNight). Throws on a failed read.
 */
export async function loadNightBookingRows(
  supabase: SupabaseClient,
  hotelId: string,
  stayDates: readonly string[],
): Promise<Map<string, NightBookingRow[]>> {
  const out = new Map<string, NightBookingRow[]>();
  const dates = [...new Set(stayDates)].sort();
  if (dates.length === 0) return out;
  for (const d of dates) out.set(d, []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    rows = await fetchAllRows(() =>
      supabase
        .from("reservations")
        .select("id, stay_date, booking_date, booking_window_days, room_type_id, external_reservation_id, created_at")
        .eq("hotel_id", hotelId)
        .in("stay_date", dates)
        .order("stay_date", { ascending: true })
        .order("id", { ascending: true }),
    );
  } catch (e) {
    throw new Error(`Failed to load the nights' bookings: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const r of rows as Record<string, unknown>[]) {
    const stayDate = String(r.stay_date).slice(0, 10);
    const list = out.get(stayDate);
    if (!list) continue;
    const ext = r.external_reservation_id != null ? String(r.external_reservation_id) : "";
    list.push({
      key: ext !== "" ? bookingKeyOf(ext) : `row ${String(r.id)}`,
      room_type_id: r.room_type_id != null ? String(r.room_type_id) : null,
      bw: bookingWindowOf({
        stay_date: stayDate,
        booking_date: r.booking_date != null ? String(r.booking_date).slice(0, 10) : null,
        booking_window_days: r.booking_window_days != null ? Number(r.booking_window_days) : null,
      }),
      created_at: r.created_at != null ? String(r.created_at) : null,
    });
  }
  return out;
}

/**
 * Which rows a rule measuring `signalIds` reads, the way its observation
 * does (frozenWindowOf): the room types it measures, less those that don't
 * count as rooms; the hotel-wide history (every row but those, a row with
 * no room type included) when that is all of the hotel's.
 */
function measuredRow(ctx: BookingSpeedContext, signalIds: readonly string[]): (roomTypeId: string | null) => boolean {
  const kept = ctx.excluded ? signalIds.filter((id) => !ctx.excluded!.has(id)) : [...signalIds];
  if (ctx.hotelSetKey !== undefined && signalSetKey(kept) !== ctx.hotelSetKey) {
    const set = new Set(kept);
    return (id) => id !== null && set.has(id);
  }
  return (id) => id === null || !ctx.excluded?.has(id);
}

/**
 * The bookings a booking speed reading counted in its window, by key, from
 * `rows` (loadNightBookingRows for `stayDate`): those on the room types it
 * measures (measuredRow) whose booking window falls in [windowFrom,
 * windowTo] (hotel dates, both included), and with `since`, on windowFrom's
 * day only those first seen after it, as observeForStayDate counts them. A
 * booking is one however many rooms it holds, at its earliest booking date,
 * first seen at its earliest row. Sorted. null for a window that doesn't
 * read (it ends after the night, or has no day).
 */
export function windowBookingKeys(
  ctx: BookingSpeedContext,
  rows: readonly NightBookingRow[],
  stayDate: string,
  windowFrom: string,
  windowTo: string,
  signalIds: readonly string[],
  since: string | null,
): string[] | null {
  const daysOut = daysBetween(windowTo, stayDate);
  const days = daysBetween(windowFrom, windowTo) + 1;
  if (daysOut < 0 || days < 1) return null;
  const measured = measuredRow(ctx, signalIds);
  const bookings = new Map<string, { bw: number | null; firstSeen: number }>();
  for (const row of rows) {
    if (!measured(row.room_type_id)) continue;
    const at = row.created_at ? Date.parse(row.created_at) : NaN;
    const seen = Number.isNaN(at) ? -Infinity : at;
    const prev = bookings.get(row.key);
    bookings.set(
      row.key,
      prev
        ? { bw: earliestBookingWindow(prev.bw, row.bw), firstSeen: Math.min(prev.firstSeen, seen) }
        : { bw: row.bw, firstSeen: seen },
    );
  }
  const sinceMs = since ? Date.parse(since) : null;
  const splitBw = daysOut + days - 1;
  const out: string[] = [];
  for (const [key, { bw, firstSeen }] of bookings) {
    if (bw === null || bw < daysOut || bw > splitBw) continue;
    if (sinceMs !== null && bw === splitBw && !(firstSeen > sinceMs)) continue;
    out.push(key);
  }
  return out.sort();
}

/** The bookings with a row on the night now over the room types a rule measures (measuredRow), by key. */
export function bookingKeysOnNight(
  ctx: BookingSpeedContext,
  rows: readonly NightBookingRow[],
  signalIds: readonly string[],
): Set<string> {
  const measured = measuredRow(ctx, signalIds);
  const out = new Set<string>();
  for (const row of rows) if (measured(row.room_type_id)) out.add(row.key);
  return out;
}

/** Where a frozen window is read from: the set's index, its splitWindows key part, and the window as offsets. */
function frozenWindowOf(
  ctx: BookingSpeedContext,
  stayDate: string,
  windowFrom: string,
  windowTo: string,
  signalIds?: readonly string[],
): { index: Map<string, StayDateWindows>; setPart: string; daysOut: number; days: number } | null {
  if (ctx.loadedTargets && !ctx.loadedTargets.has(stayDate)) return null;
  const setKey =
    signalIds && ctx.hotelSetKey !== undefined
      ? signalSetKey(ctx.excluded ? signalIds.filter((id) => !ctx.excluded!.has(id)) : signalIds)
      : null;
  const measuresSet = setKey !== null && setKey !== ctx.hotelSetKey;
  const index = measuresSet ? ctx.setWindows?.get(setKey) : ctx.windowsByDate;
  if (!index) return null;
  const daysOut = daysBetween(windowTo, stayDate);
  const days = daysBetween(windowFrom, windowTo) + 1;
  if (daysOut < 0 || days < 1) return null;
  return { index, setPart: measuresSet ? setKey : "", daysOut, days };
}
