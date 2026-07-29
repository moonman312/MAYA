/**
 * Post-import cleaning analysis: examines the imported reservation history
 * and writes onboarding_findings for the review step.
 *
 * The decision logic is pure functions over aggregate rows (unit-tested with
 * fixtures); the SQL heavy lifting lives in the onboarding_* RPCs. Re-running
 * is safe: proposed findings for the hotel are replaced, auto-fixes are
 * idempotent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportJobRow } from "./worker-core.ts";
import { projectStrategyOntoRoomTypes } from "./project-strategy.ts";
import { computeOccupancyReference, computeStarterRules, generateStarterRules } from "./generate-rules.ts";
import {
  computeGuardrailSuggestions,
  computeInitialGuardrails,
  computeRuleSuggestions,
  MIN_ROWS_TO_TRUST_P99,
  type ExistingRuleSummary,
  type InitialGuardrailInput,
} from "./suggest.ts";

/* ── Pure decision logic ─────────────────────────────────────────────────── */

export type DailyRoomNights = { stay_date: string; room_nights: number };

export type ClosedPeriodFinding = {
  start_date: string;
  end_date: string;
  days: number;
  surrounding_median: number;
};

const MIN_CLOSED_RUN_DAYS = 14;
const SURROUND_DAYS = 30;
/**
 * How many short gaps findClosedPeriods will bridge into one candidate
 * closure. 3 absorbs a realistic run of isolated incidents (a couple of
 * stray bookings, or a short reopening between two closures) while staying
 * short of what it takes to cascade a genuinely recurring low-occupancy
 * season into one false-positive closure — empirically, a real quiet
 * season's own booking-every-few-weeks cadence needs 4+ bridges before its
 * merged span reaches far enough to touch genuine business on the far side.
 */
const MAX_BRIDGED_GAPS = 3;

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Find runs of >= 14 consecutive zero-occupancy days where the property was
 * clearly operating on both sides (nonzero median room-nights in the 30 days
 * before AND after). Leading zeros before the first-ever reservation are
 * pre-opening, not a closure; trailing gaps that reach `today` are future.
 * A short nonzero gap inside a run (a stray booking, or a brief reopening
 * too short to count on its own) is bridged before scoring — see below.
 */
export function findClosedPeriods(
  series: DailyRoomNights[],
  todayYmd: string,
): ClosedPeriodFinding[] {
  if (series.length === 0) return [];

  const byDate = new Map(series.map((s) => [s.stay_date, s.room_nights]));
  const first = series[0].stay_date;
  const last = series[series.length - 1].stay_date;
  const end = last < todayYmd ? last : todayYmd;

  // Continuous daily series [first, end]
  const days: { date: string; nights: number }[] = [];
  for (let d = first; d <= end; d = addDays(d, 1)) {
    days.push({ date: d, nights: byDate.get(d) ?? 0 });
  }

  // Raw zero-runs as (start, end) index pairs.
  const rawRuns: Array<[number, number]> = [];
  let runStart: number | null = null;
  for (let i = 0; i < days.length; i++) {
    if (days[i].nights === 0) {
      if (runStart === null) runStart = i;
    } else if (runStart !== null) {
      rawRuns.push([runStart, i - 1]);
      runStart = null;
    }
  }
  if (runStart !== null) rawRuns.push([runStart, days.length - 1]);

  // A stray booking (comped stay, maintenance hold, staff test, bad PMS row)
  // landing inside a real closure splits one long zero-run into two — each
  // half's before/after window then looks straight into the OTHER half's
  // zeros, so both get rejected below and the whole closure vanishes. Same
  // failure for two genuine closures split by a too-brief reopening. Bridge
  // a nonzero gap that's shorter than a real operating stretch (same bar as
  // MIN_CLOSED_RUN_DAYS) back into a single run before scoring it.
  //
  // Bridging has to stop after a few gaps, not run indefinitely: a property
  // with a genuinely quiet season (a booking every couple of weeks, for
  // months) looks IDENTICAL to a closure-with-strays one gap at a time, and
  // an unbounded chain would walk the whole season out to the real business
  // on the far side and report it as one giant false-positive closure.
  // MAX_BRIDGED_GAPS caps how far a single chain can reach — enough to
  // absorb a handful of isolated incidents in one closure (the cases this
  // exists for), not enough to escape a recurring low-activity cadence.
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < rawRuns.length) {
    const run: [number, number] = [rawRuns[i][0], rawRuns[i][1]];
    let bridged = 0;
    while (bridged < MAX_BRIDGED_GAPS) {
      const next = rawRuns[i + 1 + bridged];
      if (!next || next[0] - run[1] - 1 > MIN_CLOSED_RUN_DAYS) break;
      run[1] = next[1];
      bridged++;
    }
    runs.push(run);
    i += 1 + bridged;
  }

  const findings: ClosedPeriodFinding[] = [];

  const flush = (startIdx: number, endIdx: number) => {
    const runLen = endIdx - startIdx + 1;
    if (runLen < MIN_CLOSED_RUN_DAYS) return;
    if (startIdx === 0) return; // pre-opening
    if (endIdx === days.length - 1) return; // runs into today/future
    const before = days
      .slice(Math.max(0, startIdx - SURROUND_DAYS), startIdx)
      .map((d) => d.nights);
    const after = days.slice(endIdx + 1, endIdx + 1 + SURROUND_DAYS).map((d) => d.nights);
    // A closure needs real operation on both sides — a stray test booking
    // followed by silence is pre-opening noise, not a closed period.
    if (before.length < SURROUND_DAYS / 2 || after.length < SURROUND_DAYS / 2) return;
    const beforeMed = median(before);
    const afterMed = median(after);
    if (beforeMed <= 0 || afterMed <= 0) return;
    findings.push({
      start_date: days[startIdx].date,
      end_date: days[endIdx].date,
      days: runLen,
      surrounding_median: Math.round(((beforeMed + afterMed) / 2) * 10) / 10,
    });
  };

  for (const [s, e] of runs) flush(s, e);

  return findings;
}

/* ── Seasonal closure merging ────────────────────────────────────────────── */

export type SeasonalClosureFinding = {
  recurring: true;
  season_label: string; // "mid-December to mid-February", "all of August"
  years_observed: number;
  periods: ClosedPeriodFinding[];
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function dayOfYear(ymd: string): number {
  const d = new Date(`${ymd}T00:00:00Z`);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86_400_000); // 0-based, leap-safe enough
}

function describeDoy(doy: number): { label: string; month: number; day: number } {
  // Use a non-leap reference year so labels are stable.
  const d = new Date(Date.UTC(2025, 0, 1) + doy * 86_400_000);
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const part = day <= 10 ? "early" : day <= 20 ? "mid" : "late";
  return { label: `${part}-${MONTHS[month]}`, month, day };
}

/** Human phrasing for a recurring window: the way a hotelier would say it. */
export function describeSeason(startDoy: number, endDoy: number): string {
  const s = describeDoy(startDoy);
  const e = describeDoy(endDoy);
  // Whole calendar month ("every August")
  if (s.month === e.month && s.day <= 5 && e.day >= 25) {
    return `all of ${MONTHS[s.month]}`;
  }
  return `${s.label} to ${e.label}`;
}

/**
 * Collapse closures that recur at the same time of year into one seasonal
 * finding — "closed every winter" is one fact about the property, not one
 * question per year. Windows within ~3 weeks of each other in day-of-year
 * space (with December→January wraparound) count as the same season.
 */
export function mergeSeasonalClosures(periods: ClosedPeriodFinding[]): {
  seasonal: SeasonalClosureFinding[];
  oneOff: ClosedPeriodFinding[];
} {
  const TOLERANCE = 21; // days of drift allowed between years
  type Tagged = ClosedPeriodFinding & { startDoy: number };
  const tagged: Tagged[] = periods.map((p) => ({ ...p, startDoy: dayOfYear(p.start_date) }));
  const untag = (t: Tagged): ClosedPeriodFinding => ({
    start_date: t.start_date,
    end_date: t.end_date,
    days: t.days,
    surrounding_median: t.surrounding_median,
  });

  // Group by circular proximity of start day-of-year.
  const groups: Tagged[][] = [];
  for (const p of tagged) {
    const home = groups.find((g) =>
      g.some((m) => {
        const diff = Math.abs(m.startDoy - p.startDoy);
        return Math.min(diff, 365 - diff) <= TOLERANCE;
      }),
    );
    if (home) home.push(p);
    else groups.push([p]);
  }

  const seasonal: SeasonalClosureFinding[] = [];
  const oneOff: ClosedPeriodFinding[] = [];
  for (const g of groups) {
    const distinctYears = new Set(g.map((p) => p.start_date.slice(0, 4)));
    if (g.length < 2 || distinctYears.size < 2) {
      oneOff.push(...g.map(untag));
      continue;
    }
    // Representative window: median start, median end (handling wrap by using
    // the group's anchor to unwrap starts near the year boundary).
    const anchor = g[0].startDoy;
    const unwrap = (doy: number) => {
      const diff = doy - anchor;
      if (diff > 182) return doy - 365;
      if (diff < -182) return doy + 365;
      return doy;
    };
    const starts = g.map((p) => unwrap(p.startDoy)).sort((a, b) => a - b);
    const midStart = ((starts[Math.floor(starts.length / 2)] % 365) + 365) % 365;
    const avgLen = Math.round(g.reduce((sum, p) => sum + p.days, 0) / g.length);
    const midEnd = (midStart + avgLen - 1) % 365;

    seasonal.push({
      recurring: true,
      season_label: describeSeason(midStart, midEnd),
      years_observed: distinctYears.size,
      periods: g.map(untag).sort((a, b) => a.start_date.localeCompare(b.start_date)),
    });
  }

  return { seasonal, oneOff };
}

export type RoomTypeStats = {
  room_type_id: string;
  external_room_type_id: string;
  name: string;
  is_active: boolean;
  row_count: number;
  median_rate: number | null;
  p99_rate: number | null;
  max_rate: number | null;
  reservation_count: number;
  single_night_reservations: number;
  median_los: number | null;
};

// Bookable spaces that aren't sleeping rooms — PMSes model everything as a
// "room type": event spaces, spas, courts, parking, day-use, retail.
//
// Naive keyword matching is a trap here: "Cabana Suite", "Spa Suite",
// "Poolside King" and "Ballroom Suite" are all real bedrooms at real resorts.
// So we split the signals in two.

/** Never a sleeping room, whatever else the name says. */
const NON_ROOM_STRONG =
  /\b(parking|pickleball|boardroom|banquet|conference|meeting|treatment|massage|storage|locker|kayak|excursion|day\s?-?use|gift\s?shop|deposit|resort\s?fee|service\s?fee|add-?on|misc)\b/i;

/** Suggestive, but only damning when the name has no bedroom noun in it. */
const NON_ROOM_WEAK =
  /\b(spa|pool|cabana|golf|tennis|court|event|hall|ballroom|venue|gym|tour|rental|bike|wedding|package|fee)\b/i;

/** If one of these appears, someone sleeps there. */
const ROOM_NOUN =
  /\b(rooms?|suites?|kings?|queens?|doubles?|twins?|singles?|studios?|villas?|cabins?|bungalows?|apartments?|dorms?|beds?|bunks?|penthouses?|lofts?|cottages?|chalets?|casitas?)\b/i;

function nameLooksLikeNonRoom(name: string): boolean {
  if (NON_ROOM_STRONG.test(name)) return true;
  return NON_ROOM_WEAK.test(name) && !ROOM_NOUN.test(name);
}

export type SuspectRoomTypeFinding = {
  room_type_id: string;
  name: string;
  reasons: string[];
  row_count: number;
  median_rate: number | null;
};

export function findSuspectRoomTypes(stats: RoomTypeStats[]): SuspectRoomTypeFinding[] {
  const active = stats.filter((s) => s.is_active);
  const totalRows = active.reduce((sum, s) => sum + s.row_count, 0);
  const hotelMedianRate = median(
    active.filter((s) => s.median_rate != null && s.row_count > 0).map((s) => s.median_rate!),
  );
  const hotelMedianLos = median(
    active.filter((s) => s.median_los != null && s.reservation_count > 0).map((s) => s.median_los!),
  );

  const findings: SuspectRoomTypeFinding[] = [];
  for (const s of active) {
    // Signals strong enough to accuse a room type on their own.
    const triggers: string[] = [];
    // True but unremarkable on its own — a rare, pricey penthouse looks exactly
    // like this, so it may only corroborate, never accuse.
    const corroborating: string[] = [];

    if (nameLooksLikeNonRoom(s.name)) {
      triggers.push(`the name doesn't read like a bedroom ("${s.name}")`);
    }

    if (
      s.reservation_count >= 20 &&
      s.single_night_reservations === s.reservation_count &&
      hotelMedianLos >= 2
    ) {
      triggers.push("every booking is exactly one night while the rest of the property isn't");
    }

    if (
      totalRows > 0 &&
      s.row_count > 0 &&
      s.row_count / totalRows < 0.005 &&
      s.median_rate != null &&
      hotelMedianRate > 0 &&
      (s.median_rate > hotelMedianRate * 3 || s.median_rate < hotelMedianRate / 3)
    ) {
      corroborating.push(
        `it's a tiny share of bookings (${((s.row_count / totalRows) * 100).toFixed(2)}%) at an unusual rate`,
      );
    }

    const reasons = [...triggers, ...corroborating];
    if (triggers.length > 0) {
      findings.push({
        room_type_id: s.room_type_id,
        name: s.name,
        reasons,
        row_count: s.row_count,
        median_rate: s.median_rate,
      });
    }
  }
  return findings;
}

export type DuplicateRoomTypeFinding = {
  keep_room_type_id: string;
  deactivate_room_type_id: string;
  name: string;
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Same normalized name, one side has zero reservations -> deactivate it. */
export function findDuplicateRoomTypes(stats: RoomTypeStats[]): DuplicateRoomTypeFinding[] {
  const groups = new Map<string, RoomTypeStats[]>();
  for (const s of stats.filter((x) => x.is_active)) {
    const key = normalizeName(s.name);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  const findings: DuplicateRoomTypeFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const withRows = group.filter((s) => s.row_count > 0);
    const withoutRows = group.filter((s) => s.row_count === 0);
    if (withRows.length === 0 || withoutRows.length === 0) continue;
    const keep = withRows.sort((a, b) => b.row_count - a.row_count)[0];
    for (const dead of withoutRows) {
      findings.push({
        keep_room_type_id: keep.room_type_id,
        deactivate_room_type_id: dead.room_type_id,
        name: dead.name,
      });
    }
  }
  return findings;
}

export type RateOutlierFinding = {
  room_type_id: string;
  name: string;
  threshold_high: number;
  median_rate: number;
  max_rate: number;
};

/** Room types whose max rate screams "test booking or typo". */
export function findRateOutliers(stats: RoomTypeStats[]): RateOutlierFinding[] {
  const findings: RateOutlierFinding[] = [];
  for (const s of stats) {
    if (!s.is_active || s.median_rate == null || s.p99_rate == null || s.max_rate == null) continue;
    if (s.row_count < 30) continue; // not enough data to call anything an outlier
    // Below MIN_ROWS_TO_TRUST_P99, p99 itself can BE the outlier row (the
    // interpolation weight on the single highest value is still large), so
    // a contaminated p99*3 must not be allowed to raise the bar past what
    // median_rate*10 alone would catch — that was exactly how one bad row
    // both became the ceiling AND defeated its own detector.
    const threshold =
      s.row_count >= MIN_ROWS_TO_TRUST_P99
        ? Math.max(s.p99_rate * 3, s.median_rate * 10)
        : s.median_rate * 10;
    if (s.max_rate > threshold) {
      findings.push({
        room_type_id: s.room_type_id,
        name: s.name,
        threshold_high: Math.round(threshold),
        median_rate: s.median_rate,
        max_rate: s.max_rate,
      });
    }
  }
  return findings;
}

/* ── Orchestration ───────────────────────────────────────────────────────── */

export async function analyzeImport(
  supabase: SupabaseClient,
  job: ImportJobRow,
): Promise<void> {
  const hotelId = job.hotel_id;
  const today = new Date().toISOString().slice(0, 10);
  // "refresh" = user asked for help on a hotel with existing config: analysis
  // only ever SUGGESTS — nothing is written without an explicit accept.
  const refreshMode = job.stats.mode === "refresh";

  const [{ data: dailyRaw }, { data: statsRaw }] = await Promise.all([
    supabase.rpc("onboarding_daily_room_nights", { p_hotel_id: hotelId }),
    supabase.rpc("onboarding_room_type_stats", { p_hotel_id: hotelId }),
  ]);

  const daily: DailyRoomNights[] = (dailyRaw ?? []).map(
    (r: { stay_date: string; room_nights: number | string }) => ({
      stay_date: String(r.stay_date),
      room_nights: Number(r.room_nights),
    }),
  );
  const stats: RoomTypeStats[] = (statsRaw ?? []).map(
    (r: Record<string, unknown>) => ({
      room_type_id: String(r.room_type_id),
      external_room_type_id: String(r.external_room_type_id ?? ""),
      name: String(r.name ?? ""),
      is_active: r.is_active === true,
      row_count: Number(r.row_count ?? 0),
      median_rate: r.median_rate != null ? Number(r.median_rate) : null,
      p99_rate: r.p99_rate != null ? Number(r.p99_rate) : null,
      max_rate: r.max_rate != null ? Number(r.max_rate) : null,
      reservation_count: Number(r.reservation_count ?? 0),
      single_night_reservations: Number(r.single_night_reservations ?? 0),
      median_los: r.median_los != null ? Number(r.median_los) : null,
    }),
  );

  // Simple counts for informational findings.
  const [{ count: totalRows }, { count: zeroRateRows }, { count: unmappedRows }] =
    await Promise.all([
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("hotel_id", hotelId),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("hotel_id", hotelId)
        .lte("current_rate", 0),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("hotel_id", hotelId)
        .is("room_type_id", null),
    ]);

  const { seasonal, oneOff } = mergeSeasonalClosures(findClosedPeriods(daily, today));
  const suspects = findSuspectRoomTypes(stats);
  const duplicates = findDuplicateRoomTypes(stats);
  const outliers = findRateOutliers(stats);

  // Replace this hotel's unresolved findings (idempotent re-run).
  await supabase
    .from("onboarding_findings")
    .delete()
    .eq("hotel_id", hotelId)
    .in("status", ["proposed", "auto_applied"]);

  type FindingInsert = {
    hotel_id: string;
    job_id: string;
    kind: string;
    status: string;
    payload: Record<string, unknown>;
  };
  const inserts: FindingInsert[] = [];

  for (const s of seasonal) {
    inserts.push({
      hotel_id: hotelId,
      job_id: job.id,
      kind: "closed_period",
      status: "proposed",
      payload: s as unknown as Record<string, unknown>,
    });
  }
  for (const c of oneOff) {
    inserts.push({
      hotel_id: hotelId,
      job_id: job.id,
      kind: "closed_period",
      status: "proposed",
      payload: c as unknown as Record<string, unknown>,
    });
  }
  for (const s of suspects) {
    inserts.push({
      hotel_id: hotelId,
      job_id: job.id,
      kind: "suspect_room_type",
      status: "proposed",
      payload: s as unknown as Record<string, unknown>,
    });
  }
  for (const o of outliers) {
    inserts.push({
      hotel_id: hotelId,
      job_id: job.id,
      kind: "rate_outlier",
      status: "proposed",
      payload: o as unknown as Record<string, unknown>,
    });
  }

  // Duplicates: auto-fix on first import (reversible); on a refresh of an
  // established hotel, only propose — their setup is theirs.
  for (const d of duplicates) {
    if (!refreshMode) {
      await supabase
        .from("room_types")
        .update({ is_active: false })
        .eq("id", d.deactivate_room_type_id);
    }
    inserts.push({
      hotel_id: hotelId,
      job_id: job.id,
      kind: "duplicate_room_type",
      status: refreshMode ? "proposed" : "auto_applied",
      payload: d as unknown as Record<string, unknown>,
    });
  }

  const total = totalRows ?? 0;
  if (total > 0 && (zeroRateRows ?? 0) / total > 0.02) {
    inserts.push({
      hotel_id: hotelId,
      job_id: job.id,
      kind: "zero_rate_rows",
      status: "proposed",
      payload: { count: zeroRateRows, share: (zeroRateRows ?? 0) / total },
    });
  }
  if ((unmappedRows ?? 0) > 0) {
    inserts.push({
      hotel_id: hotelId,
      job_id: job.id,
      kind: "unmapped_room_type",
      status: "proposed",
      payload: { count: unmappedRows },
    });
  }

  if (refreshMode) {
    inserts.push(...(await buildSuggestionInserts(supabase, hotelId, job.id, daily, today)));
  }

  if (inserts.length > 0) {
    const { error } = await supabase.from("onboarding_findings").insert(inserts);
    if (error) throw new Error(`onboarding_findings insert failed: ${error.message}`);
  }

  if (refreshMode) return; // suggestions only — no direct writes past this point

  // Strategy answers may have arrived while the import ran — re-project so
  // room types created by the import get their guardrails too.
  await projectStrategyOntoRoomTypes(supabase, hotelId);

  // Then data fills whatever the answers left at schema defaults: ceilings
  // from p99 x 1.5, floors from a fraction of the median — the guardrail
  // half of the starter package, applied while still in simulation mode.
  await applyInitialGuardrails(supabase, hotelId, stats, new Set(suspects.map((s) => s.room_type_id)));

  // The payoff: starter rules built from their own history, live-in-simulation.
  const starterRules = await generateStarterRules(supabase, hotelId);
  if (starterRules.length > 0) {
    await supabase
      .from("import_jobs")
      .update({
        stats: {
          ...job.stats,
          starterRules: starterRules.map((r) => ({
            name: r.name,
            explanation: r.explanation,
          })),
        },
      })
      .eq("id", job.id);
    job.stats = { ...job.stats, starterRules: starterRules.map((r) => r.name) };
  }
}

/** Refresh-mode: compare data-derived config against what exists; emit suggestions. */
async function buildSuggestionInserts(
  supabase: SupabaseClient,
  hotelId: string,
  jobId: string,
  daily: DailyRoomNights[],
  today: string,
): Promise<
  Array<{ hotel_id: string; job_id: string; kind: string; status: string; payload: Record<string, unknown> }>
> {
  const [{ data: ruleRows }, { data: roomTypes }, { data: settings }, { data: rtStats }] =
    await Promise.all([
      supabase
        .from("pricing_rules")
        .select(
          "id, name, is_active, is_pickup_rule, rule_condition(occupancy_operator, occupancy_threshold, pickup_operator, pickup_threshold, booking_speed_operator)",
        )
        .eq("hotel_id", hotelId),
      supabase
        .from("room_types")
        .select("id, name, total_rooms, floor_price, ceiling_price")
        .eq("hotel_id", hotelId)
        .eq("is_active", true),
      supabase
        .from("hotel_settings")
        .select("strategy_floor, strategy_ceiling, pricing_confidence")
        .eq("hotel_id", hotelId)
        .maybeSingle(),
      supabase.rpc("onboarding_room_type_stats", { p_hotel_id: hotelId }),
    ]);

  const totalRooms = (roomTypes ?? []).reduce(
    (sum, rt) => sum + (Number(rt.total_rooms) || 0),
    0,
  );
  if (totalRooms === 0) return [];

  const existing: ExistingRuleSummary[] = (ruleRows ?? []).map((r) => {
    const rc = (Array.isArray(r.rule_condition) ? r.rule_condition[0] : r.rule_condition) as
      | Record<string, unknown>
      | null;
    return {
      id: String(r.id),
      name: String(r.name),
      is_active: r.is_active === true,
      is_pickup_rule: r.is_pickup_rule === true,
      occupancy_operator: (rc?.occupancy_operator as string | null) ?? null,
      occupancy_threshold: rc?.occupancy_threshold != null ? Number(rc.occupancy_threshold) : null,
      pickup_operator: (rc?.pickup_operator as string | null) ?? null,
      pickup_threshold: rc?.pickup_threshold != null ? Number(rc.pickup_threshold) : null,
      has_booking_speed: rc?.booking_speed_operator != null,
    };
  });

  const historyDays = daily.filter((d) => d.stay_date < today);
  const paceSpecs = computeStarterRules({ daysOfHistory: historyDays.length });
  const occupancyRef = computeOccupancyReference(
    historyDays.map((d) => Math.min(1, d.room_nights / totalRooms)),
  );

  const p99ByRoomType = new Map<string, number>();
  const rowCountByRoomType = new Map<string, number>();
  for (const s of rtStats ?? []) {
    if (s.p99_rate != null) p99ByRoomType.set(String(s.room_type_id), Number(s.p99_rate));
    rowCountByRoomType.set(String(s.room_type_id), Number(s.row_count ?? 0));
  }
  const parsedStats: RoomTypeStats[] = (rtStats ?? []).map(
    (r: Record<string, unknown>) => ({
      room_type_id: String(r.room_type_id),
      external_room_type_id: String(r.external_room_type_id ?? ""),
      name: String(r.name ?? ""),
      is_active: r.is_active === true,
      row_count: Number(r.row_count ?? 0),
      median_rate: r.median_rate != null ? Number(r.median_rate) : null,
      p99_rate: r.p99_rate != null ? Number(r.p99_rate) : null,
      max_rate: r.max_rate != null ? Number(r.max_rate) : null,
      reservation_count: Number(r.reservation_count ?? 0),
      single_night_reservations: Number(r.single_night_reservations ?? 0),
      median_los: r.median_los != null ? Number(r.median_los) : null,
    }),
  );
  const suspectIds = new Set(findSuspectRoomTypes(parsedStats).map((f) => f.room_type_id));

  const ruleSuggestions = computeRuleSuggestions(existing, paceSpecs, occupancyRef);
  const guardrailSuggestions = computeGuardrailSuggestions(
    (roomTypes ?? []).map((rt) => ({
      room_type_id: String(rt.id),
      name: String(rt.name),
      floor_price: Number(rt.floor_price),
      ceiling_price: Number(rt.ceiling_price),
      observed_p99_rate: p99ByRoomType.get(String(rt.id)) ?? null,
      row_count: rowCountByRoomType.get(String(rt.id)) ?? 0,
    })),
    {
      floor: settings?.strategy_floor != null ? Number(settings.strategy_floor) : null,
      ceiling: settings?.strategy_ceiling != null ? Number(settings.strategy_ceiling) : null,
    },
    suspectIds,
  );

  const allRoomTypeIds = (roomTypes ?? []).map((rt) => String(rt.id));
  return [
    ...ruleSuggestions.map((s) => ({
      hotel_id: hotelId,
      job_id: jobId,
      kind: "rule_suggestion",
      status: "proposed",
      payload: { ...s, room_type_ids: allRoomTypeIds } as unknown as Record<string, unknown>,
    })),
    ...guardrailSuggestions.map((s) => ({
      hotel_id: hotelId,
      job_id: jobId,
      kind: "guardrail_suggestion",
      status: "proposed",
      payload: s as unknown as Record<string, unknown>,
    })),
  ];
}

/**
 * First-run guardrail application: computeInitialGuardrails decides, this
 * writes. Separate from projectStrategyOntoRoomTypes because strategy
 * answers are the human's numbers and always win — this only ever touches
 * room types the projection left at schema defaults.
 */
async function applyInitialGuardrails(
  supabase: SupabaseClient,
  hotelId: string,
  stats: RoomTypeStats[],
  suspectRoomTypeIds: ReadonlySet<string>,
): Promise<void> {
  const { data: roomTypes } = await supabase
    .from("room_types")
    .select("id, name, floor_price, ceiling_price")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (!roomTypes?.length) return;

  const statsById = new Map(stats.map((s) => [s.room_type_id, s]));
  const inputs: InitialGuardrailInput[] = roomTypes.map((rt) => {
    const s = statsById.get(String(rt.id));
    return {
      room_type_id: String(rt.id),
      name: String(rt.name ?? ""),
      floor_price: Number(rt.floor_price),
      ceiling_price: Number(rt.ceiling_price),
      observed_p99_rate: s?.p99_rate ?? null,
      observed_median_rate: s?.median_rate ?? null,
      row_count: s?.row_count ?? 0,
    };
  });

  const patches = new Map<string, Record<string, number>>();
  for (const g of computeInitialGuardrails(inputs, suspectRoomTypeIds)) {
    const patch = patches.get(g.room_type_id) ?? {};
    patch[g.field] = g.value;
    patches.set(g.room_type_id, patch);
  }
  for (const [roomTypeId, patch] of patches) {
    const { error } = await supabase.from("room_types").update(patch).eq("id", roomTypeId);
    // A constraint-rejected patch (e.g. a ceiling below a floor the
    // strategy projection already set) must not disappear silently — this
    // is the guardrail half of the starter package, and a hotel with no
    // record of it failing has no way to know it's missing.
    if (error) {
      console.error(
        JSON.stringify({ fn: "applyInitialGuardrails", hotelId, roomTypeId, patch, error: error.message }),
      );
    }
  }
}
