/**
 * Booking Speed provider — the bridge between the evaluation engine and the
 * Observation Engine (../observations).
 * Deno-portable copy of src/lib/engine/booking-speed-provider.ts (import
 * paths only differ).
 *
 * Loaded once per evaluation run, and only when at least one active rule
 * actually carries a booking-speed condition — hotels without such rules
 * pay zero cost. One paged query pulls the slim reservation history, the
 * season model (level + weekly shape + booking pace) is built once, and
 * each (stay date, window) observation is computed once and memoized; the
 * same memo doubles as the audit snapshot source, so what a rule matched
 * on and what the audit records are the same object by construction.
 *
 * Observations are computed against a REDUCED row set per call (the target,
 * its comparables, and momentum's neighbor dates plus their year-ago
 * counterparts) — passing the full history to every observation would
 * re-group tens of thousands of rows hundreds of times per run.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "../observations/calendar.ts";
import { dailyPaceSeries } from "../observations/booking-pace.ts";
import {
  detectSeasons,
  type DailyDemand,
  type DatePeriod,
  type SeasonModel,
} from "../observations/seasons.ts";
import {
  selectComparableDates,
  type ComparableSelection,
} from "../observations/comparable-dates.ts";
import { MOMENTUM_RADIUS_DAYS, MOMENTUM_YEAR_OFFSET_DAYS } from "../observations/momentum.ts";
import {
  observeBookingSpeed,
  type BookingSpeedObservation,
  type SlimReservationRow,
} from "../observations/expected-bookings.ts";
import {
  buildReinforcementModel,
  isDateReinforcementExcluded,
  isKnownChallengeReason,
  seasonExclusionPeriods,
  type AssumptionChallenge,
  type ChallengeScope,
} from "../observations/reinforcement.ts";
import type { RuleMetrics } from "./types.ts";

export const HISTORY_YEARS_BACK = 3;
export const DEFAULT_BOOKING_SPEED_COOLDOWN_DAYS = 7;
const PAGE = 1000;
const MAX_PAGES = 100;

export type BookingSpeedContext = {
  /** Hotel-local evaluation date (YYYY-MM-DD). */
  asOf: string;
  rowsByDate: Map<string, SlimReservationRow[]>;
  seasonModel: SeasonModel;
  historyStart: string;
  historyEnd: string;
  isExcluded: (date: string) => boolean;
  selectionCache: Map<string, ComparableSelection>;
  observationCache: Map<string, BookingSpeedObservation>;
};

/**
 * Load everything booking-speed evaluation needs for one hotel run.
 * Returns null when the hotel has no reservation rows at all — conditions
 * then block with "insufficient_data" rather than matching on nothing.
 */
export async function loadBookingSpeedContext(
  supabase: SupabaseClient,
  hotelId: string,
  localDate: string,
  totalCapacity: number,
): Promise<BookingSpeedContext | null> {
  const historyStart = addDays(localDate, -(HISTORY_YEARS_BACK * 366));
  const historyEnd = addDays(localDate, -1);

  const rows: SlimReservationRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await supabase
      .from("reservations")
      .select("stay_date, booking_date, booking_window_days")
      .eq("hotel_id", hotelId)
      .gte("stay_date", historyStart)
      .order("stay_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    // A mid-run failure is not the end of the history. Treating it as one
    // silently truncated the reservation set, so every stay date past the
    // cut-off measured as having no bookings and read as Stalled.
    if (error) {
      throw new Error(`Failed to load booking history: ${error.message}`);
    }
    if (!data) break;
    for (const r of data) {
      rows.push({
        stay_date: String(r.stay_date),
        booking_date: r.booking_date != null ? String(r.booking_date) : null,
        booking_window_days:
          r.booking_window_days != null ? Number(r.booking_window_days) : null,
      });
    }
    if (data.length < PAGE) break;
    // Hitting the page ceiling means there is more history than we read, and
    // carrying on with a partial set would misreport pace for the tail of
    // the horizon. Say so rather than quietly measuring against a fragment.
    if (page === MAX_PAGES - 1) {
      throw new Error(
        `Booking history exceeded ${MAX_PAGES * PAGE} rows for hotel ${hotelId}; ` +
          `raise MAX_PAGES or narrow HISTORY_YEARS_BACK before trusting booking speed here.`,
      );
    }
  }
  if (rows.length === 0) return null;

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

  const rowsByDate = new Map<string, SlimReservationRow[]>();
  for (const row of rows) {
    const list = rowsByDate.get(row.stay_date);
    if (list) list.push(row);
    else rowsByDate.set(row.stay_date, [row]);
  }

  // Season inputs come from fully observed (past) dates only — future
  // dates' booking curves are still being written and would read as
  // artificially quiet/slow.
  const historyRows: SlimReservationRow[] = [];
  const daily: DailyDemand[] = [];
  for (const [stayDate, dateRows] of rowsByDate) {
    if (stayDate > historyEnd) continue;
    historyRows.push(...dateRows);
    daily.push({ stay_date: stayDate, value: dateRows.length });
  }
  daily.sort((a, b) => a.stay_date.localeCompare(b.stay_date));

  const pace = totalCapacity > 0 ? dailyPaceSeries(historyRows, totalCapacity) : [];
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

  return {
    asOf: localDate,
    rowsByDate,
    seasonModel,
    historyStart,
    historyEnd,
    isExcluded,
    selectionCache: new Map(),
    observationCache: new Map(),
  };
}

/** The dates an observation may consult: target, comparables, momentum neighbors, and their year-ago counterparts. */
function relevantRows(
  ctx: BookingSpeedContext,
  stayDate: string,
  selection: ComparableSelection,
): SlimReservationRow[] {
  const dates = new Set<string>([stayDate, addDays(stayDate, -MOMENTUM_YEAR_OFFSET_DAYS)]);
  for (const c of selection.comparables) dates.add(c.date);
  for (let offset = -MOMENTUM_RADIUS_DAYS; offset <= MOMENTUM_RADIUS_DAYS; offset++) {
    if (offset === 0) continue;
    const neighbor = addDays(stayDate, offset);
    dates.add(neighbor);
    dates.add(addDays(neighbor, -MOMENTUM_YEAR_OFFSET_DAYS));
  }
  const out: SlimReservationRow[] = [];
  for (const d of dates) {
    const list = ctx.rowsByDate.get(d);
    if (list) out.push(...list);
  }
  return out;
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

  const observation = observeBookingSpeed({
    rows: relevantRows(ctx, stayDate, selection),
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
