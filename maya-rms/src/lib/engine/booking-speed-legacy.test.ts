/**
 * The Booking Speed history path as it was before grouped windows: flat
 * rows, per-row scans. Kept verbatim (comments trimmed) so the equivalence
 * tests compare old code with new code, not new code with itself. Also the
 * seeded fixture generator both equivalence suites share.
 */
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, holidayContextForDate } from "@/lib/observations/calendar";
import { classifyBookingSpeed } from "@/lib/observations/booking-speed";
import { PACE_OCCUPANCY_MILESTONES } from "@/lib/observations/booking-pace";
import { round2, trimmedMean, type SlimReservationRow } from "@/lib/observations/booking-rows";
import { selectComparableDates, type ComparableSelection } from "@/lib/observations/comparable-dates";
import { detectSeasons, type DailyDemand, type DatePeriod } from "@/lib/observations/seasons";
import {
  MOMENTUM_ASSUMED_COMPARABLE_COUNT,
  MOMENTUM_MIN_NEIGHBORS,
  MOMENTUM_RADIUS_DAYS,
  MOMENTUM_RATIO_CEILING,
  MOMENTUM_RATIO_FLOOR,
  MOMENTUM_YEAR_OFFSET_DAYS,
} from "@/lib/observations/momentum";
import {
  buildReinforcementModel,
  isDateReinforcementExcluded,
  seasonExclusionPeriods,
  type AssumptionChallenge,
  type ChallengeScope,
} from "@/lib/observations/reinforcement";
import { HISTORY_YEARS_BACK } from "./booking-speed-provider";
import type { FakeRow } from "./fake-supabase.test";

/* ── legacy: the row-by-row implementation this change replaced ─────── */

export const legacy = {
  bookingWindowOf(row: SlimReservationRow): number | null {
    if (row.booking_date) return daysBetween(row.booking_date, row.stay_date);
    if (typeof row.booking_window_days === "number") return row.booking_window_days;
    return null;
  },
  pickupInWindow(rows: SlimReservationRow[], stayDate: string, daysOut: number, windowDays: number): number {
    let count = 0;
    for (const row of rows) {
      if (row.stay_date !== stayDate) continue;
      const bw = legacy.bookingWindowOf(row);
      if (bw === null) continue;
      if (bw >= daysOut && bw < daysOut + windowDays) count++;
    }
    return count;
  },
  hasAnyRow(rows: SlimReservationRow[], stayDate: string): boolean {
    return rows.some((r) => r.stay_date === stayDate);
  },
  dailyPaceSeries(rows: SlimReservationRow[], capacity: number): DailyDemand[] {
    const byDate = new Map<string, number[]>();
    for (const row of rows) {
      const bw = legacy.bookingWindowOf(row);
      if (bw === null || bw < 0) continue;
      const list = byDate.get(row.stay_date);
      if (list) list.push(bw);
      else byDate.set(row.stay_date, [bw]);
    }
    const out: DailyDemand[] = [];
    for (const [stay_date, windows] of byDate) {
      windows.sort((a, b) => b - a);
      const ms = PACE_OCCUPANCY_MILESTONES.map((t) => ({ threshold: t, daysOut: null as number | null }));
      let cumulative = 0;
      let next = 0;
      for (const bw of windows) {
        cumulative++;
        while (next < ms.length && cumulative >= Math.ceil(ms[next].threshold * capacity)) {
          ms[next].daysOut = bw;
          next++;
        }
        if (next >= ms.length) break;
      }
      out.push({ stay_date, value: ms.reduce((s, m) => s + (m.daysOut ?? 0), 0) });
    }
    return out.sort((a, b) => a.stay_date.localeCompare(b.stay_date));
  },
  momentum(rows: SlimReservationRow[], target: string, asOf: string, windowDays: number, isExcluded: (d: string) => boolean) {
    const usableDate = (d: string) => !isExcluded(d) && holidayContextForDate(d) === null;
    const neighbors: string[] = [];
    for (let offset = -MOMENTUM_RADIUS_DAYS; offset <= MOMENTUM_RADIUS_DAYS; offset++) {
      if (offset === 0) continue;
      const d = addDays(target, offset);
      if (d < asOf) continue;
      if (!usableDate(d)) continue;
      neighbors.push(d);
    }
    let neighborsUsed = 0;
    let matchedRecentTotal = 0;
    let matchedHistoricalTotal = 0;
    const pairs: { date: string; bookings: number; yearAgoDate: string; yearAgoBookings: number }[] = [];
    const neighborRecentPaces: number[] = [];
    for (const neighbor of neighbors) {
      const recent = legacy.pickupInWindow(rows, neighbor, daysBetween(asOf, neighbor), windowDays);
      neighborsUsed++;
      neighborRecentPaces.push(recent);
      const priorAsOf = addDays(asOf, -MOMENTUM_YEAR_OFFSET_DAYS);
      const priorNeighbor = addDays(neighbor, -MOMENTUM_YEAR_OFFSET_DAYS);
      const priorDaysOut = daysBetween(priorAsOf, priorNeighbor);
      if (priorDaysOut >= 0 && legacy.hasAnyRow(rows, priorNeighbor) && usableDate(priorNeighbor)) {
        const historical = legacy.pickupInWindow(rows, priorNeighbor, priorDaysOut, windowDays);
        matchedRecentTotal += recent;
        matchedHistoricalTotal += historical;
        pairs.push({ date: neighbor, bookings: recent, yearAgoDate: priorNeighbor, yearAgoBookings: historical });
      }
    }
    if (neighborsUsed < MOMENTUM_MIN_NEIGHBORS) return null;
    const momentumRatio =
      pairs.length > 0 && matchedHistoricalTotal > 0
        ? Math.min(MOMENTUM_RATIO_CEILING, Math.max(MOMENTUM_RATIO_FLOOR, matchedRecentTotal / matchedHistoricalTotal))
        : 1;
    const priorAsOf = addDays(asOf, -MOMENTUM_YEAR_OFFSET_DAYS);
    const priorTarget = addDays(target, -MOMENTUM_YEAR_OFFSET_DAYS);
    const priorTargetDaysOut = daysBetween(priorAsOf, priorTarget);
    let naiveBaselineBookings: number;
    let baselineSource: "target_year_ago" | "neighbor_pace";
    let baselineDate: string | null;
    if (priorTargetDaysOut >= 0 && legacy.hasAnyRow(rows, priorTarget) && usableDate(priorTarget)) {
      naiveBaselineBookings = legacy.pickupInWindow(rows, priorTarget, priorTargetDaysOut, windowDays);
      baselineSource = "target_year_ago";
      baselineDate = priorTarget;
    } else {
      naiveBaselineBookings = trimmedMean(neighborRecentPaces);
      baselineSource = "neighbor_pace";
      baselineDate = null;
    }
    return {
      expectedBookings: round2(Math.max(0, naiveBaselineBookings * momentumRatio)),
      momentumRatio: round2(momentumRatio),
      neighborsUsed,
      matchedPairs: pairs.length,
      pairs,
      naiveBaselineBookings: round2(naiveBaselineBookings),
      baselineSource,
      baselineDate,
    };
  },
  observe(rows: SlimReservationRow[], target: string, asOf: string, selection: ComparableSelection, windowDays: number, isExcluded: (d: string) => boolean) {
    const daysOut = daysBetween(asOf, target);
    const byStayDate = new Map<string, SlimReservationRow[]>();
    for (const row of rows) {
      const list = byStayDate.get(row.stay_date);
      if (list) list.push(row);
      else byStayDate.set(row.stay_date, [row]);
    }
    const rowsFor = (date: string) => byStayDate.get(date) ?? [];
    const recentBookings = legacy.pickupInWindow(rowsFor(target), target, daysOut, windowDays);
    const perComparable = selection.comparables.map((c) => ({
      date: c.date,
      bookings: legacy.pickupInWindow(rowsFor(c.date), c.date, daysOut, windowDays),
      tier: c.tier,
      reasons: c.reasons,
      hasData: legacy.hasAnyRow(rows, c.date),
    }));
    const usable = perComparable.filter((c) => c.hasData);
    const base = { target, asOf, daysOut, windowDays, recentBookings, perComparable, selection };
    if (usable.length > 0) {
      const expectedBookings = round2(trimmedMean(usable.map((c) => c.bookings)));
      return {
        ...base,
        expectedBookings,
        method: "comparable",
        classification: classifyBookingSpeed({ recentBookings, expectedBookings, comparableCount: usable.length }),
      };
    }
    const momentum = legacy.momentum(rows, target, asOf, windowDays, isExcluded);
    if (momentum) {
      return {
        ...base,
        expectedBookings: momentum.expectedBookings,
        method: "momentum",
        momentum,
        classification: classifyBookingSpeed({
          recentBookings,
          expectedBookings: momentum.expectedBookings,
          comparableCount: MOMENTUM_ASSUMED_COMPARABLE_COUNT,
        }),
      };
    }
    return {
      ...base,
      expectedBookings: 0,
      method: "insufficient_data",
      classification: classifyBookingSpeed({ recentBookings, expectedBookings: 0, comparableCount: 0 }),
    };
  },
  /** The old loadBookingSpeedContext + observeForStayDate, over an in-memory table. */
  run(
    reservations: FakeRow[],
    closed: DatePeriod[],
    challengeRows: FakeRow[],
    localDate: string,
    capacity: number,
    exclude: Set<string>,
    targets: string[],
    windows: number[],
  ) {
    const historyStart = addDays(localDate, -(HISTORY_YEARS_BACK * 366));
    const historyEnd = addDays(localDate, -1);
    const rows: SlimReservationRow[] = reservations
      .filter((r) => r.hotel_id === "h1" && String(r.stay_date) >= historyStart)
      .sort((a, b) => String(a.stay_date).localeCompare(String(b.stay_date)) || String(a.id).localeCompare(String(b.id)))
      .filter((r) => !(r.room_type_id != null && exclude.has(String(r.room_type_id))))
      .map((r) => ({
        stay_date: String(r.stay_date),
        booking_date: r.booking_date != null ? String(r.booking_date) : null,
        booking_window_days: r.booking_window_days != null ? Number(r.booking_window_days) : null,
      }));
    if (rows.length === 0) return null;
    const challenges: AssumptionChallenge[] = challengeRows.map((c) => {
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
      closed.some((p) => date >= p.start_date && date <= p.end_date) || isDateReinforcementExcluded(reinforcement, date);
    const rowsByDate = new Map<string, SlimReservationRow[]>();
    for (const row of rows) {
      const list = rowsByDate.get(row.stay_date);
      if (list) list.push(row);
      else rowsByDate.set(row.stay_date, [row]);
    }
    const historyRows: SlimReservationRow[] = [];
    const daily: DailyDemand[] = [];
    for (const [stayDate, dateRows] of rowsByDate) {
      if (stayDate > historyEnd) continue;
      historyRows.push(...dateRows);
      daily.push({ stay_date: stayDate, value: dateRows.length });
    }
    daily.sort((a, b) => a.stay_date.localeCompare(b.stay_date));
    const pace = capacity > 0 ? legacy.dailyPaceSeries(historyRows, capacity) : [];
    const seasonExclusions = closed
      .concat([...reinforcement.instanceExclusions].map((d) => ({ start_date: d, end_date: d })))
      .concat(seasonExclusionPeriods(reinforcement, Number(historyStart.slice(0, 4)), Number(historyEnd.slice(0, 4))));
    const seasonModel = detectSeasons(daily, { exclusions: seasonExclusions, ...(pace.length > 0 ? { pace } : {}) });
    const observations = new Map<string, unknown>();
    const selections = new Map<string, ComparableSelection>();
    for (const target of targets) {
      const selection = selectComparableDates(target, { seasonModel, historyStart, historyEnd, isExcluded });
      selections.set(target, selection);
      const dates = new Set<string>([target, addDays(target, -MOMENTUM_YEAR_OFFSET_DAYS)]);
      for (const c of selection.comparables) dates.add(c.date);
      for (let offset = -MOMENTUM_RADIUS_DAYS; offset <= MOMENTUM_RADIUS_DAYS; offset++) {
        if (offset === 0) continue;
        const n = addDays(target, offset);
        dates.add(n);
        dates.add(addDays(n, -MOMENTUM_YEAR_OFFSET_DAYS));
      }
      const relevant: SlimReservationRow[] = [];
      for (const d of dates) relevant.push(...(rowsByDate.get(d) ?? []));
      for (const w of windows) {
        observations.set(`${target}|${w}`, legacy.observe(relevant, target, localDate, selection, w, isExcluded));
      }
    }
    return { daily, pace, seasonModel, observations, selections, isExcluded };
  },
};

/* ── seeded fixtures ─────────────────────────────────────────────────── */

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Fixture = {
  name: string;
  localDate: string;
  capacity: number;
  exclude: Set<string>;
  reservations: FakeRow[];
  closed: FakeRow[];
  challenges: FakeRow[];
};

export function makeFixture(
  seed: number,
  capacity: number,
  opts: { thin?: boolean; futureOnly?: boolean; closedHorizon?: boolean } = {},
): Fixture {
  const r = rng(seed);
  const localDate = "2026-09-16";
  const types = ["rt-a", "rt-b", "rt-court"];
  const reservations: FakeRow[] = [];
  let id = 0;
  const first = opts.futureOnly ? 0 : -(3 * 366 + 20);
  // Keep the row count test-sized: occupancy scales down as capacity grows.
  const perNight = Math.max(1, Math.min(capacity, Math.round(40 * (opts.thin ? 0.2 : 1))));
  for (let off = first; off <= 400; off++) {
    if (opts.thin && r() < 0.6) continue;
    const stay = addDays(localDate, off);
    const season = 0.5 + 0.5 * Math.sin((off / 365) * 2 * Math.PI);
    const count = Math.floor(perNight * (0.2 + 0.8 * season) * r() + 0.5);
    for (let k = 0; k < count; k++) {
      const lead = Math.floor(r() * r() * 240);
      const bookingDate = addDays(stay, -lead + (r() < 0.04 ? 5 : 0));
      // Future stays are only booked up to today.
      if (bookingDate > localDate) continue;
      const roll = r();
      reservations.push({
        id: `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
        hotel_id: "h1",
        stay_date: stay,
        booking_date: roll < 0.2 ? null : bookingDate,
        booking_window_days: roll < 0.1 ? null : Math.max(0, lead - (r() < 0.3 ? 2 : 0)),
        room_type_id: r() < 0.1 ? null : types[Math.floor(r() * types.length)],
      });
    }
  }
  // Another hotel's rows must never leak in.
  reservations.push({ id: "ffffffff-0000-4000-8000-000000000001", hotel_id: "h2", stay_date: "2026-01-10", booking_date: null, booking_window_days: 3, room_type_id: null });
  return {
    name: `seed ${seed}, capacity ${capacity}${opts.thin ? ", thin" : ""}${opts.futureOnly ? ", future only" : ""}${opts.closedHorizon ? ", closed horizon" : ""}`,
    localDate,
    capacity,
    exclude: new Set(["rt-court"]),
    reservations,
    closed: [
      { hotel_id: "h1", start_date: "2025-01-05", end_date: "2025-01-20" },
      // Closing the whole horizon leaves momentum no neighbors at all.
      ...(opts.closedHorizon ? [{ hotel_id: "h1", start_date: addDays(localDate, -20), end_date: addDays(localDate, 80) }] : []),
    ],
    challenges: [
      { id: "c1", hotel_id: "h1", challenged_date: "2025-07-04", reason_key: "local_event", scope: "annual", created_at: "2025-07-10T00:00:00Z" },
      { id: "c2", hotel_id: "h1", challenged_date: "2024-11-02", reason_key: "data_or_sync_issue", scope: "this_date", created_at: "2024-11-05T00:00:00Z" },
    ],
  };
}

describe("legacy booking speed reference", () => {
  it("has nothing to say about a hotel with no rows", () => {
    expect(legacy.run([], [], [], "2026-09-16", 10, new Set(), ["2026-09-16"], [7])).toBeNull();
  });
});

/* ── measured sets: a row-level reference ─────────────────────────────── */

/**
 * What a rule measuring only `include` should observe, from the rows. The
 * comparables are the hotel's (legacy.run); the counts are the set's rows.
 * A consulted date has data for the set when the hotel has a row that day
 * and it is on or after the set's first row among the consulted dates. A
 * marker row with no booking window stands for that presence: hasAnyRow sees
 * it, pickupInWindow never counts it.
 */
export function legacySetObservations(
  fx: Fixture,
  include: string[],
  targets: string[],
  windows: number[],
): Map<string, unknown> | null {
  const closed = fx.closed.map((c) => ({ start_date: String(c.start_date), end_date: String(c.end_date) }));
  const hotelRun = legacy.run(fx.reservations, closed, fx.challenges, fx.localDate, fx.capacity, fx.exclude, targets, windows);
  if (!hotelRun) return null;
  const historyStart = addDays(fx.localDate, -(HISTORY_YEARS_BACK * 366));
  const relevantFor = (target: string) => {
    const dates = new Set<string>([target, addDays(target, -MOMENTUM_YEAR_OFFSET_DAYS)]);
    for (const c of hotelRun.selections.get(target)!.comparables) dates.add(c.date);
    for (let offset = -MOMENTUM_RADIUS_DAYS; offset <= MOMENTUM_RADIUS_DAYS; offset++) {
      if (offset === 0) continue;
      const n = addDays(target, offset);
      dates.add(n);
      dates.add(addDays(n, -MOMENTUM_YEAR_OFFSET_DAYS));
    }
    return dates;
  };
  const consulted = new Set<string>();
  for (const t of targets) for (const d of relevantFor(t)) if (d >= historyStart) consulted.add(d);
  const mine = fx.reservations.filter((r) => r.hotel_id === "h1" && String(r.stay_date) >= historyStart);
  const hotelDates = new Set(
    mine.filter((r) => !(r.room_type_id != null && fx.exclude.has(String(r.room_type_id)))).map((r) => String(r.stay_date)),
  );
  const setRows = mine.filter((r) => r.room_type_id != null && include.includes(String(r.room_type_id)));
  const setDates = new Set(setRows.map((r) => String(r.stay_date)));
  const first = [...consulted].filter((d) => setDates.has(d)).sort()[0];
  const measured = [...new Set(include)].sort();
  const out = new Map<string, unknown>();
  for (const target of targets) {
    const relevant: SlimReservationRow[] = [];
    for (const d of relevantFor(target)) {
      if (first === undefined || d < first || d < historyStart || !hotelDates.has(d)) continue;
      const rows = setRows.filter((r) => String(r.stay_date) === d);
      if (rows.length === 0) relevant.push({ stay_date: d, booking_date: null, booking_window_days: null });
      for (const r of rows) {
        relevant.push({
          stay_date: d,
          booking_date: r.booking_date != null ? String(r.booking_date) : null,
          booking_window_days: r.booking_window_days != null ? Number(r.booking_window_days) : null,
        });
      }
    }
    for (const w of windows) {
      const obs = legacy.observe(relevant, target, fx.localDate, hotelRun.selections.get(target)!, w, hotelRun.isExcluded);
      out.set(`${target}|${w}`, { ...obs, measuredRoomTypeIds: measured });
    }
  }
  return out;
}
