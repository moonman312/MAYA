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
 * per stay date, how many rows there are and how many sit at each booking
 * window, so the database answers with exactly that (see
 * 99_supabase_migration_large_property_scale_v1.sql): a per-date summary for
 * the season model, then grouped windows for only the dates the horizon's
 * observations can consult. A 500-room property has over a million
 * room-nights in its history; the old row-by-row read threw past 100,000.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "@/lib/observations/calendar";
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
  observeBookingSpeed,
  type BookingSpeedObservation,
} from "@/lib/observations/expected-bookings";
import { bookingWindowOf, type StayDateWindows } from "@/lib/observations/booking-rows";
import {
  buildReinforcementModel,
  isDateReinforcementExcluded,
  isKnownChallengeReason,
  seasonExclusionPeriods,
  type AssumptionChallenge,
  type ChallengeScope,
} from "@/lib/observations/reinforcement";
import type { EngineRule } from "@/types/domain";
import { MIGRATIONS, fetchAllRows, isMissingFunctionError } from "./snapshots";
import type { RuleMetrics } from "./types";

export const HISTORY_YEARS_BACK = 3;
export const DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS = 7;
const PAGE = 1000;
/** Stay dates per booking_speed_windows call; each date comes back as one row. */
const WINDOW_DATES_CHUNK = 400;
/**
 * Before the migration, rows are read with keyset paging and folded into the
 * grouped form page by page, so memory stays flat. What grows is the number
 * of round trips, one per 1,000 rows. Past this many rows the run stops and
 * names the migration instead of spending the whole tick reading.
 */
export const PRE_MIGRATION_ROW_BUDGET = 500_000;

export type BookingSpeedContext = {
  /** Hotel-local evaluation date (YYYY-MM-DD). */
  asOf: string;
  /** Grouped rows per stay date: every date any loaded observation can consult. */
  windowsByDate: Map<string, StayDateWindows>;
  /**
   * The stay dates whose observations are fully covered by windowsByDate.
   * null means everything is loaded (tests build contexts this way).
   */
  loadedTargets?: ReadonlySet<string> | null;
  seasonModel: SeasonModel;
  /** Kept rows per past stay date: the season model's demand input. */
  dailyDemand: DailyDemand[];
  historyStart: string;
  historyEnd: string;
  isExcluded: (date: string) => boolean;
  selectionCache: Map<string, ComparableSelection>;
  observationCache: Map<string, BookingSpeedObservation>;
};

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

/** Test hook: forget that the pre-migration line was already logged. */
export function resetBookingSpeedLogOnce(): void {
  loggedPreMigration = false;
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

/** Grouped windows for exactly `dates`. null when the migration has not run. */
async function loadWindowsForDates(
  supabase: SupabaseClient,
  hotelId: string,
  dates: string[],
  exclude: string[],
): Promise<Map<string, StayDateWindows> | null> {
  const out = new Map<string, StayDateWindows>();
  for (let i = 0; i < dates.length; i += WINDOW_DATES_CHUNK) {
    const chunk = dates.slice(i, i + WINDOW_DATES_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .rpc("booking_speed_windows", { p_hotel_id: hotelId, p_dates: chunk, p_exclude: exclude })
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
        const bws = Array.isArray(r.bws) ? (r.bws as unknown[]) : [];
        const counts = Array.isArray(r.counts) ? (r.counts as unknown[]) : [];
        out.set(String(r.stay_date), {
          n: Number(r.n),
          windows: bws.map((bw, k) => ({ bw: bw == null ? null : Number(bw), n: Number(counts[k]) })),
        });
      }
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

/**
 * Pre-migration path: every row from `historyStart` to `upTo`, read with
 * keyset paging on (stay_date, id) and folded into the grouped form a page
 * at a time.
 */
async function loadWindowsByRows(
  supabase: SupabaseClient,
  hotelId: string,
  historyStart: string,
  upTo: string,
  excludeRoomTypeIds: ReadonlySet<string>,
): Promise<Map<string, StayDateWindows>> {
  const counts = new Map<string, Map<number | null, number>>();
  let rowsRead = 0;
  let cursor: { stay_date: string; id: string } | null = null;
  for (;;) {
    let q = supabase
      .from("reservations")
      .select("id, stay_date, booking_date, booking_window_days, room_type_id")
      .eq("hotel_id", hotelId)
      .gte("stay_date", historyStart)
      .lte("stay_date", upTo);
    if (cursor) {
      q = q.or(`stay_date.gt.${cursor.stay_date},and(stay_date.eq.${cursor.stay_date},id.gt.${cursor.id})`);
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
    const rows = data ?? [];
    for (const r of rows) {
      if (r.room_type_id != null && excludeRoomTypeIds.has(String(r.room_type_id))) continue;
      const stayDate = String(r.stay_date);
      const bw = bookingWindowOf({
        stay_date: stayDate,
        booking_date: r.booking_date != null ? String(r.booking_date) : null,
        booking_window_days: r.booking_window_days != null ? Number(r.booking_window_days) : null,
      });
      let byWindow = counts.get(stayDate);
      if (!byWindow) {
        byWindow = new Map();
        counts.set(stayDate, byWindow);
      }
      byWindow.set(bw, (byWindow.get(bw) ?? 0) + 1);
    }
    rowsRead += rows.length;
    if (rows.length < PAGE) break;
    // Carrying on with a partial set would misreport pace for the tail of
    // the horizon. Say so rather than quietly measuring against a fragment.
    if (rowsRead >= PRE_MIGRATION_ROW_BUDGET) {
      throw new Error(
        `Booking history for hotel ${hotelId} is over ${PRE_MIGRATION_ROW_BUDGET} rows; ` +
          `run ${MIGRATIONS.largePropertyScale} before trusting booking speed here.`,
      );
    }
    const last = rows[rows.length - 1];
    cursor = { stay_date: String(last.stay_date), id: String(last.id) };
  }
  const out = new Map<string, StayDateWindows>();
  for (const [stayDate, byWindow] of counts) {
    let n = 0;
    const windows: { bw: number | null; n: number }[] = [];
    for (const [bw, c] of byWindow) {
      n += c;
      windows.push({ bw, n: c });
    }
    out.set(stayDate, { n, windows });
  }
  return out;
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
 */
export async function loadBookingSpeedContext(
  supabase: SupabaseClient,
  hotelId: string,
  localDate: string,
  totalCapacity: number,
  excludeRoomTypeIds: ReadonlySet<string> = new Set(),
  horizonEnd: string = localDate,
): Promise<BookingSpeedContext | null> {
  const historyStart = addDays(localDate, -(HISTORY_YEARS_BACK * 366));
  const historyEnd = addDays(localDate, -1);
  const exclude = [...excludeRoomTypeIds].sort();
  const targets: string[] = [];
  for (let d = localDate; d <= horizonEnd; d = addDays(d, 1)) targets.push(d);

  // Season inputs come from fully observed (past) dates only — future
  // dates' booking curves are still being written and would read as
  // artificially quiet/slow.
  const daily: DailyDemand[] = [];
  let pace: DailyDemand[] = [];
  let windowsByDate: Map<string, StayDateWindows> | null = null;

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
    windowsByDate = await loadWindowsByRows(supabase, hotelId, historyStart, upTo, excludeRoomTypeIds);
    if (windowsByDate.size === 0 && !(await hasKeptRowAfter(supabase, hotelId, upTo, excludeRoomTypeIds))) {
      return null;
    }
    const history = new Map<string, StayDateWindows>();
    for (const [stayDate, entry] of windowsByDate) {
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
  };

  if (!windowsByDate) {
    // Now that the season model exists, each target's comparables are
    // known, so only the dates its observations can read are fetched.
    const wanted = new Set<string>();
    for (const target of targets) {
      for (const d of relevantDates(target, selectionFor(ctx, target))) {
        if (d >= historyStart) wanted.add(d);
      }
    }
    const loaded = await loadWindowsForDates(supabase, hotelId, [...wanted].sort(), exclude);
    ctx.windowsByDate =
      loaded ??
      (await loadWindowsByRows(
        supabase,
        hotelId,
        historyStart,
        addDays(horizonEnd, MOMENTUM_RADIUS_DAYS),
        excludeRoomTypeIds,
      ));
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

/** Memoized Layer 1 observation for one (stay date, trailing window). */
export function observeForStayDate(
  ctx: BookingSpeedContext,
  stayDate: string,
  windowDays: number,
): BookingSpeedObservation {
  const key = `${stayDate}|${windowDays}`;
  const hit = ctx.observationCache.get(key);
  if (hit) return hit;

  // Only the horizon's dates were loaded. Anything else would read missing
  // dates as having no bookings, so refuse rather than answer wrongly.
  if (ctx.loadedTargets && !ctx.loadedTargets.has(stayDate)) {
    throw new Error(`Booking speed history was not loaded for stay date ${stayDate}`);
  }

  const selection = selectionFor(ctx, stayDate);

  // The grouped index answers exactly what the rows did: every date the
  // observation consults (target, comparables, momentum neighbors and their
  // year-ago dates, see relevantDates) is in it, and nothing else is read.
  const observation = observeBookingSpeed({
    index: ctx.windowsByDate,
    target: stayDate,
    asOf: ctx.asOf,
    selection,
    windowDays,
    isExcluded: ctx.isExcluded,
  });
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
  };
}

/** Every observation consulted for a stay date this run — the audit snapshot. */
export function bookingSpeedAuditSnapshots(
  ctx: BookingSpeedContext,
  stayDate: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [key, observation] of ctx.observationCache) {
    if (key.startsWith(`${stayDate}|`)) {
      out.push(observation as unknown as Record<string, unknown>);
    }
  }
  return out;
}

/** True when a rule's last fire on this stay date is still inside its cooldown. */
export function isWithinCooldown(
  lastAppliedAt: string | undefined,
  nowIso: string,
  cooldownDays: number,
): boolean {
  if (!lastAppliedAt) return false;
  return Date.parse(nowIso) - Date.parse(lastAppliedAt) < cooldownDays * 86_400_000;
}

/**
 * How far back to look for prior fires when building the cooldown map.
 *
 * Must cover the LONGEST cooldown any active booking-speed rule actually
 * uses — a fixed 31-day lookback made a rule configured with a longer
 * cooldown invisible past that horizon, so isWithinCooldown would never see
 * its last fire and the rule would re-fire (stacking another persistent
 * pickup adjustment) weeks before its own cooldown said it should. 31 stays
 * the floor so ordinary cooldowns are unaffected; +1 pads the boundary.
 */
export function cooldownLookbackDays(
  rules: { condition: { booking_speed_operator?: string | null; booking_speed_cooldown_days?: number | null } }[],
): number {
  const maxCooldown = rules.reduce((max, r) => {
    if (!r.condition.booking_speed_operator) return max;
    const cd = r.condition.booking_speed_cooldown_days ?? DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS;
    return Math.max(max, cd);
  }, DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS);
  return Math.max(31, maxCooldown + 1);
}

/**
 * Most recent fire per `rule_id|stay_date` for the cooldown check.
 *
 * Only event-style booking-speed rules are ever looked up, and only for stay
 * dates from today on, so the read is narrowed to exactly those keys and
 * paged. Unpaged, a busy hotel's fires past PostgREST's 1,000-row cap were
 * invisible and those rules re-fired inside their cooldown. A failed read
 * throws: an empty map would lift every cooldown at once.
 */
export async function loadLastBookingSpeedFires(
  supabase: SupabaseClient,
  hotelId: string,
  rules: EngineRule[],
  localDate: string,
  nowIso: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ruleIds = rules
    .filter((r) => r.is_pickup_rule && r.condition.booking_speed_operator)
    .map((r) => r.id);
  if (ruleIds.length === 0) return out;
  const horizon = new Date(Date.parse(nowIso) - cooldownLookbackDays(rules) * 86_400_000).toISOString();
  const fires = await fetchAllRows(() =>
    supabase
      .from("pickup_event")
      .select("rule_id, stay_date, applied_at")
      .eq("hotel_id", hotelId)
      .in("rule_id", ruleIds)
      .gte("stay_date", localDate)
      .gte("applied_at", horizon)
      .order("id", { ascending: true }),
  );
  for (const f of fires) {
    const key = `${f.rule_id}|${f.stay_date}`;
    const prev = out.get(key);
    if (!prev || String(f.applied_at) > prev) out.set(key, String(f.applied_at));
  }
  return out;
}
