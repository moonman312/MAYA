/**
 * Post-import cleaning analysis: examines the imported reservation history
 * and writes onboarding_findings for the review step.
 *
 * The decision logic is pure functions over aggregate rows (unit-tested with
 * fixtures); the SQL heavy lifting lives in the onboarding_* RPCs. Re-running
 * is safe: open findings are refined in place, answered ones are not asked
 * again, auto-fixes are idempotent, and findings recording a fix we already
 * applied are left alone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportJobRow } from "./worker-core.ts";
import { projectStrategyOntoRoomTypes } from "./project-strategy.ts";
import {
  computeOccupancyReference,
  computeStarterRules,
  generateStarterRules,
  loadDailyRoomNights,
  MIN_HISTORY_DAYS_FOR_STARTERS,
  type StarterRuleSpec,
} from "./generate-rules.ts";
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

/**
 * Exported because billing needs the same judgement, not a second copy of it.
 * Every PMS models a pickleball court as a bookable room type, so the count MAYA
 * charges for has to make this distinction as carefully as the review screen
 * does — and from the same rules, or the two would eventually disagree about
 * what a customer owes.
 */
export function nameLooksLikeNonRoom(name: string): boolean {
  if (NON_ROOM_STRONG.test(name)) return true;
  return NON_ROOM_WEAK.test(name) && !ROOM_NOUN.test(name);
}

/**
 * The stricter half of the same judgement: only the words that are never a
 * bedroom. "Deluxe Pool View" and "Spa Deluxe" trip the weak test — they are
 * real bedrooms at real resorts — and that test is fine for a bill-time
 * exclusion that under-charges us, but not for a default that takes a type
 * out of the engine's occupancy before anyone has looked at it.
 */
export function nameIsCertainlyNonRoom(name: string): boolean {
  return NON_ROOM_STRONG.test(name);
}

/**
 * Whether a PostgREST error is "that column isn't there yet".
 *
 * Deploy order is not guaranteed: code that knows about a column can run
 * against a database that has not had its migration. PostgREST reports the
 * gap two ways — Postgres's own 42703 when the column is in a filter or a
 * select list, PGRST204 ("not in the schema cache") when it is in an update
 * or insert payload. Callers use this to fall back to the pre-migration path
 * and say so in the logs, instead of failing a sync or a request over it.
 */
export function isMissingColumnError(
  err: { code?: string; message?: string } | null | undefined,
  column: string,
): boolean {
  if (!err) return false;
  const msg = String(err.message ?? "");
  if (!msg.includes(column)) return false;
  return err.code === "42703" || err.code === "PGRST204" ||
    /does not exist|schema cache/i.test(msg);
}

export type RoomTypeLabelRow = {
  external_room_type_id: string;
  name: string;
  display_name?: string | null;
};

/**
 * Where a classification pass is running from. It decides how bold the
 * heuristic may be:
 *
 *   "import" — the onboarding discover step. The owner is about to see the
 *              review strip with the guess on it, so the certain non-rooms
 *              (parking, boardroom, pickleball) are proposed as `false` and
 *              show up unticked for a one-click correction.
 *   "sync"   — the steady-state five-minute tick on a live hotel, and a
 *              refresh re-import. Nobody is looking. Writing `false` here
 *              would drop a type out of every occupancy denominator, every
 *              rule's signal set and the bill on the strength of a regex, so
 *              the heuristic only ever writes `true`; a name it dislikes is
 *              left null, which counts in the engine exactly as it did
 *              before the flag existed, and billing keeps applying its own
 *              one-directional name test at bill time.
 */
export type ProposeMode = "import" | "sync";

/**
 * Propose counts_as_room for room types the owner has not classified yet.
 *
 * Runs right after every room_types upsert. The upsert cannot tell an insert
 * from an update, so writing the heuristic into the upsert payload would
 * flatten the owner's choice on every five-minute tick. Instead this writes
 * only where counts_as_room is still null — a new type gets a default, a
 * decided one is never touched, in either direction. counts_as_room_set_by
 * is left null on purpose: that is what marks a value as the heuristic's
 * rather than a person's.
 *
 * Weak name matches ("Deluxe Pool View") are never proposed as non-rooms in
 * either mode; they stay null and the review screen asks about them as a
 * suspect_room_type finding instead.
 *
 * Never throws. A sync that dies over a classification hint is a far worse
 * bug than an unclassified court, and ahead of the migration the column is
 * simply not there: that case logs loudly and returns, and measureRooms
 * falls back to the same heuristic at bill time.
 */
export async function proposeCountsAsRoom(
  supabase: SupabaseClient,
  hotelId: string,
  rows: RoomTypeLabelRow[],
  mode: ProposeMode,
): Promise<{ proposedRooms: number; proposedNonRooms: number; leftUnclassified: number }> {
  const nonRooms: string[] = [];
  const rooms: string[] = [];
  const unclassified: string[] = [];
  for (const rt of rows) {
    // Both names, same as billing: PMSes differ in which one carries the label.
    const label = String(rt.display_name || rt.name || "");
    if (!nameLooksLikeNonRoom(label)) rooms.push(rt.external_room_type_id);
    else if (mode === "import" && nameIsCertainlyNonRoom(label)) nonRooms.push(rt.external_room_type_id);
    else unclassified.push(rt.external_room_type_id);
  }
  if (mode === "sync" && unclassified.length > 0) {
    // Worth a line: these are the types billing will exclude by name until
    // someone decides in room-type settings.
    console.log(JSON.stringify({
      fn: "proposeCountsAsRoom",
      hotel: hotelId,
      leftUnclassified: unclassified,
      note: "names read as non-rooms; not written outside onboarding, the owner decides in room-type settings",
    }));
  }

  const nothing = { proposedRooms: 0, proposedNonRooms: 0, leftUnclassified: unclassified.length };
  try {
    for (const [value, ids] of [[false, nonRooms], [true, rooms]] as const) {
      if (ids.length === 0) continue;
      const { error } = await supabase
        .from("room_types")
        .update({ counts_as_room: value })
        .eq("hotel_id", hotelId)
        .is("counts_as_room", null)
        .in("external_room_type_id", ids);
      if (!error) continue;
      if (isMissingColumnError(error, "counts_as_room")) {
        console.warn(JSON.stringify({
          fn: "proposeCountsAsRoom",
          hotel: hotelId,
          warning: "room_types.counts_as_room is not in this database yet — run " +
            "99_supabase_migration_room_type_counts_as_room_v1.sql. Skipping the default " +
            "pass; billing falls back to the name heuristic until it lands.",
        }));
        return nothing;
      }
      console.error(JSON.stringify({ fn: "proposeCountsAsRoom", hotel: hotelId, error: error.message }));
      return nothing;
    }
  } catch (e) {
    console.error(JSON.stringify({
      fn: "proposeCountsAsRoom",
      hotel: hotelId,
      error: e instanceof Error ? e.message : String(e),
    }));
    return nothing;
  }
  return { proposedRooms: rooms.length, proposedNonRooms: nonRooms.length, leftUnclassified: unclassified.length };
}

/**
 * Room types the owner has already answered for. A suspect_room_type finding
 * is a question, and re-asking one that has been answered lets a teammate on
 * the review screen flip the owner's yes to a no without knowing it was ever
 * asked — so analyzeImport drops those suspects.
 *
 * "Answered" means counts_as_room_set_by is set: the heuristic's own writes
 * leave it null, and a heuristic `true` must not silence the other triggers
 * (all-single-night bookings, say) on a type nobody has looked at. On a
 * database with the flag but not yet the set_by column, any classified type
 * counts as answered — the older, safer reading; without the flag at all,
 * nothing does.
 */
export async function loadAnsweredRoomTypeIds(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<Set<string>> {
  const withSetBy = await supabase
    .from("room_types")
    .select("id, counts_as_room, counts_as_room_set_by")
    .eq("hotel_id", hotelId)
    .not("counts_as_room", "is", null);
  if (!withSetBy.error) {
    return new Set(
      (withSetBy.data ?? [])
        .filter((r: { counts_as_room_set_by?: unknown }) => r.counts_as_room_set_by != null)
        .map((r: { id: unknown }) => String(r.id)),
    );
  }
  if (isMissingColumnError(withSetBy.error, "counts_as_room_set_by")) {
    console.warn(JSON.stringify({
      fn: "loadAnsweredRoomTypeIds",
      hotel: hotelId,
      warning: "room_types.counts_as_room_set_by is not in this database yet — re-run " +
        "99_supabase_migration_room_type_counts_as_room_v1.sql. Treating every classified type as answered.",
    }));
    const flagOnly = await supabase
      .from("room_types")
      .select("id")
      .eq("hotel_id", hotelId)
      .not("counts_as_room", "is", null);
    if (!flagOnly.error) return new Set((flagOnly.data ?? []).map((r: { id: unknown }) => String(r.id)));
    if (!isMissingColumnError(flagOnly.error, "counts_as_room")) {
      console.error(JSON.stringify({ fn: "loadAnsweredRoomTypeIds", hotel: hotelId, error: flagOnly.error.message }));
    }
    return new Set();
  }
  if (!isMissingColumnError(withSetBy.error, "counts_as_room")) {
    console.error(JSON.stringify({ fn: "loadAnsweredRoomTypeIds", hotel: hotelId, error: withSetBy.error.message }));
  }
  return new Set();
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

/* ── Findings bookkeeping ────────────────────────────────────────────────── */

/** A finding this pass wants on the review screen. */
export type FindingDraft = {
  kind: string;
  status: "proposed" | "auto_applied";
  payload: Record<string, unknown>;
};

/** A finding already on record, in any status. */
export type StoredFinding = {
  id: string;
  kind: string;
  status: string;
  job_id: string | null;
  payload: Record<string, unknown>;
};

type Period = { start_date: string; end_date: string };

function closurePeriods(payload: Record<string, unknown>): Period[] {
  const raw = Array.isArray(payload.periods)
    ? (payload.periods as Array<Record<string, unknown>>)
    : [payload];
  return raw
    .filter((p) => p && typeof p.start_date === "string" && typeof p.end_date === "string")
    .map((p) => ({ start_date: String(p.start_date), end_date: String(p.end_date) }))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
}

function periodsOverlap(a: Period, b: Period): boolean {
  return a.start_date <= b.end_date && b.start_date <= a.end_date;
}

function anyPeriodOverlaps(a: Period[], b: Period[]): boolean {
  return a.some((p) => b.some((q) => periodsOverlap(p, q)));
}

/** JSON with sorted keys, so a payload that did not change compares equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/**
 * The question a finding asks, independent of the numbers attached to it:
 * two passes that flag the same room type or the same closure produce the
 * same key even when more history has changed the detail. Stored alongside
 * the finding so the database refuses a second open copy of one question.
 *
 * Closures key on their earliest instance, which moves as older years
 * arrive; matching them between passes goes by overlapping dates instead
 * (see planFindingWrites), and the key only has to be right at insert time.
 */
export function findingKey(kind: string, payload: Record<string, unknown>): string | null {
  switch (kind) {
    case "closed_period": {
      const periods = closurePeriods(payload);
      if (periods.length === 0) return null;
      return payload.recurring === true
        ? `seasonal:${periods[0].start_date}`
        : `closure:${periods[0].start_date}:${periods[0].end_date}`;
    }
    case "suspect_room_type":
    case "rate_outlier":
      return payload.room_type_id ? `room_type:${String(payload.room_type_id)}` : null;
    case "duplicate_room_type":
      return payload.deactivate_room_type_id
        ? `room_type:${String(payload.deactivate_room_type_id)}`
        : null;
    case "zero_rate_rows":
    case "unmapped_room_type":
      return "property";
    case "rule_suggestion": {
      const spec = (payload.spec ?? null) as Record<string, unknown> | null;
      const target = payload.rule_id ?? spec?.name;
      return target ? `${String(payload.suggestion_type)}:${String(target)}` : null;
    }
    case "guardrail_suggestion":
      return payload.room_type_id && payload.field
        ? `${String(payload.room_type_id)}:${String(payload.field)}`
        : null;
    default:
      return null;
  }
}

function isResolved(f: StoredFinding): boolean {
  return f.status === "confirmed" || f.status === "dismissed";
}

export type ClosurePlan = {
  drafts: FindingDraft[];
  /**
   * Confirmed seasonal closures that more history found further instances
   * of. The owner has already said "we close every winter"; the older winters
   * are the same fact, so they are recorded rather than asked about again.
   */
  extensions: Array<{ findingId: string; payload: Record<string, unknown>; newPeriods: Period[] }>;
};

/**
 * Closures to propose, given what the owner has already said about closures.
 *
 * A period that overlaps a closure on record (confirmed, or entered by hand)
 * or one the owner dismissed is never asked about again. A season the owner
 * dismissed as a whole is not re-raised with its older years. A season the
 * owner confirmed is extended in place, except on a refresh, where analysis
 * writes nothing and proposes the new instances instead.
 */
export function planClosureFindings(input: {
  seasonal: SeasonalClosureFinding[];
  oneOff: ClosedPeriodFinding[];
  existing: StoredFinding[];
  recorded: Period[];
  refreshMode: boolean;
}): ClosurePlan {
  const resolved = input.existing.filter((f) => f.kind === "closed_period" && isResolved(f));
  const dismissed = resolved.filter((f) => f.status === "dismissed");
  const dismissedPeriods = dismissed.flatMap((f) => closurePeriods(f.payload));
  const dismissedSeasons = dismissed.filter((f) => f.payload.recurring === true);
  const confirmedSeasons = resolved.filter(
    (f) => f.status === "confirmed" && f.payload.recurring === true,
  );
  const known = (p: Period) =>
    input.recorded.some((r) => periodsOverlap(r, p)) ||
    dismissedPeriods.some((d) => periodsOverlap(d, p));

  const drafts: FindingDraft[] = [];
  const extensions: ClosurePlan["extensions"] = [];

  for (const season of input.seasonal) {
    if (dismissedSeasons.some((d) => anyPeriodOverlaps(closurePeriods(d.payload), season.periods))) {
      continue;
    }
    const fresh = season.periods.filter((p) => !known(p));
    if (fresh.length === 0) continue;
    const confirmed = confirmedSeasons.find((c) =>
      anyPeriodOverlaps(closurePeriods(c.payload), season.periods),
    );
    if (confirmed && !input.refreshMode) {
      const merged = [...closurePeriods(confirmed.payload), ...fresh].sort((a, b) =>
        a.start_date.localeCompare(b.start_date),
      );
      extensions.push({
        findingId: confirmed.id,
        newPeriods: fresh,
        payload: {
          ...confirmed.payload,
          years_observed: Math.max(Number(confirmed.payload.years_observed ?? 0), season.years_observed),
          periods: merged.map((p) => {
            const full = season.periods.find((s) => s.start_date === p.start_date && s.end_date === p.end_date);
            return full ?? p;
          }),
        },
      });
      continue;
    }
    drafts.push({
      kind: "closed_period",
      status: "proposed",
      payload: { ...season, periods: fresh } as unknown as Record<string, unknown>,
    });
  }

  for (const closure of input.oneOff) {
    if (known(closure)) continue;
    drafts.push({
      kind: "closed_period",
      status: "proposed",
      payload: closure as unknown as Record<string, unknown>,
    });
  }

  return { drafts, extensions };
}

/**
 * How this pass's findings land on what is already there.
 *
 * An open finding that asks the same question is updated in place rather
 * than replaced, so its id survives: an owner with the review screen open
 * while the older years import can still act on the card in front of them.
 * Open findings no draft asks about any more are removed. Resolved findings
 * are never touched here — suppressing questions the owner has answered
 * happens before this, where each kind knows what "answered" means for it.
 */
export function planFindingWrites(
  drafts: FindingDraft[],
  existing: StoredFinding[],
): {
  updates: Array<{ id: string; payload: Record<string, unknown> }>;
  inserts: FindingDraft[];
  deletes: string[];
} {
  const open = existing.filter((f) => f.status === "proposed");
  const used = new Set<string>();
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const inserts: FindingDraft[] = [];

  const sameQuestion = (f: StoredFinding, d: FindingDraft) => {
    if (f.kind !== d.kind) return false;
    if (d.kind === "closed_period") {
      return anyPeriodOverlaps(closurePeriods(f.payload), closurePeriods(d.payload));
    }
    const key = findingKey(d.kind, d.payload);
    return key !== null && key === findingKey(f.kind, f.payload);
  };

  for (const draft of drafts) {
    if (draft.status !== "proposed") {
      inserts.push(draft);
      continue;
    }
    const match = open.find((f) => !used.has(f.id) && sameQuestion(f, draft));
    if (!match) {
      inserts.push(draft);
      continue;
    }
    used.add(match.id);
    if (canonical(match.payload) !== canonical(draft.payload)) {
      updates.push({ id: match.id, payload: draft.payload });
    }
  }

  return { updates, inserts, deletes: open.filter((f) => !used.has(f.id)).map((f) => f.id) };
}

async function loadFindings(supabase: SupabaseClient, hotelId: string): Promise<StoredFinding[]> {
  const { data, error } = await supabase
    .from("onboarding_findings")
    .select("id, kind, status, job_id, payload")
    .eq("hotel_id", hotelId);
  if (error) throw new Error(`onboarding_findings read failed: ${error.message}`);
  return (data ?? []).map((f: Record<string, unknown>) => ({
    id: String(f.id),
    kind: String(f.kind),
    status: String(f.status),
    job_id: f.job_id == null ? null : String(f.job_id),
    payload: (f.payload ?? {}) as Record<string, unknown>,
  }));
}

async function loadRecordedClosures(supabase: SupabaseClient, hotelId: string): Promise<Period[]> {
  const { data, error } = await supabase
    .from("hotel_closed_periods")
    .select("start_date, end_date, room_type_id")
    .eq("hotel_id", hotelId);
  if (error) throw new Error(`hotel_closed_periods read failed: ${error.message}`);
  return (data ?? [])
    .filter((p: Record<string, unknown>) => p.room_type_id == null)
    .map((p: Record<string, unknown>) => ({ start_date: String(p.start_date), end_date: String(p.end_date) }));
}

async function writeFindings(
  supabase: SupabaseClient,
  hotelId: string,
  jobId: string,
  plan: ReturnType<typeof planFindingWrites>,
): Promise<void> {
  // Every write is conditioned on the finding still being open: an owner who
  // answers a card while this runs keeps the answer they gave.
  if (plan.deletes.length > 0) {
    const { error } = await supabase
      .from("onboarding_findings")
      .delete()
      .eq("hotel_id", hotelId)
      .eq("status", "proposed")
      .in("id", plan.deletes);
    if (error) throw new Error(`onboarding_findings delete failed: ${error.message}`);
  }
  for (const u of plan.updates) {
    const { error } = await supabase
      .from("onboarding_findings")
      .update({ payload: u.payload, job_id: jobId })
      .eq("hotel_id", hotelId)
      .eq("id", u.id)
      .eq("status", "proposed");
    if (error) throw new Error(`onboarding_findings update failed: ${error.message}`);
  }
  if (plan.inserts.length === 0) return;

  const keyed = plan.inserts.map((d) => ({
    hotel_id: hotelId,
    job_id: jobId,
    kind: d.kind,
    status: d.status,
    payload: d.payload,
    finding_key: findingKey(d.kind, d.payload),
  }));
  let rows: Array<Record<string, unknown>> = keyed;
  let { error } = await supabase.from("onboarding_findings").insert(rows);
  if (error && isMissingColumnError(error, "finding_key")) {
    console.warn(JSON.stringify({
      fn: "analyzeImport",
      hotel: hotelId,
      warning: "onboarding_findings.finding_key is not in this database yet — run " +
        "99_supabase_migration_import_early_analysis_v1.sql. Findings are still written once; " +
        "the database just cannot refuse a duplicate from a concurrent pass.",
    }));
    rows = keyed.map((row) => {
      const withoutKey: Record<string, unknown> = { ...row };
      delete withoutKey.finding_key;
      return withoutKey;
    });
    ({ error } = await supabase.from("onboarding_findings").insert(rows));
  }
  if (error && error.code === "23505") {
    // Another pass got one of these in first. Keep theirs, write the rest.
    for (const row of rows) {
      const single = await supabase.from("onboarding_findings").insert(row);
      if (single.error && single.error.code !== "23505") {
        throw new Error(`onboarding_findings insert failed: ${single.error.message}`);
      }
    }
    return;
  }
  if (error) throw new Error(`onboarding_findings insert failed: ${error.message}`);
}

/**
 * Record further instances of a season the owner confirmed. The finding's
 * payload goes first: if the closed periods then fail to land, the next pass
 * still matches this finding and inserts them, whereas the other order would
 * leave periods on record that the finding never mentions.
 */
async function extendConfirmedClosures(
  supabase: SupabaseClient,
  hotelId: string,
  extensions: ClosurePlan["extensions"],
): Promise<void> {
  for (const ext of extensions) {
    const { error: updErr } = await supabase
      .from("onboarding_findings")
      .update({ payload: ext.payload })
      .eq("hotel_id", hotelId)
      .eq("id", ext.findingId)
      .eq("status", "confirmed");
    if (updErr) throw new Error(`onboarding_findings update failed: ${updErr.message}`);
    const { error } = await supabase.from("hotel_closed_periods").insert(
      ext.newPeriods.map((p) => ({
        hotel_id: hotelId,
        room_type_id: null,
        start_date: p.start_date,
        end_date: p.end_date,
        source: "onboarding",
      })),
    );
    if (error) throw new Error(`hotel_closed_periods insert failed: ${error.message}`);
  }
}

/* ── Orchestration ───────────────────────────────────────────────────────── */

/**
 * Examine what has been imported so far and bring the review screen up to date.
 *
 * Runs twice on a first import: early, over the current window and three
 * years of history, and again once every year is in. Either pass may also
 * run twice over if a worker dies between finishing it and checkpointing it.
 * So nothing here adds blindly. Open findings are refined in place, questions
 * the owner has answered are not asked again, fixes they undid are not
 * reapplied, and starter rules are created at most once per import.
 */
export async function analyzeImport(
  supabase: SupabaseClient,
  job: ImportJobRow,
  pass: "early" | "final" = "final",
): Promise<void> {
  const hotelId = job.hotel_id;
  const today = new Date().toISOString().slice(0, 10);
  // "refresh" = user asked for help on a hotel with existing config: analysis
  // only ever SUGGESTS — nothing is written without an explicit accept.
  const refreshMode = job.stats.mode === "refresh";

  const [daily, { data: statsRaw, error: statsErr }] = await Promise.all([
    loadDailyRoomNights(supabase, hotelId),
    supabase.rpc("onboarding_room_type_stats", { p_hotel_id: hotelId }),
  ]);
  // Every read below throws on failure. A timed-out aggregate used to read as
  // "no data", and the job completed with findings and rules built on nothing;
  // throwing makes the worker back off and run the analysis again.
  if (statsErr) throw new Error(`onboarding_room_type_stats failed: ${statsErr.message}`);

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
  const [
    { count: totalRows, error: totalErr },
    { count: zeroRateRows, error: zeroErr },
    { count: unmappedRows, error: unmappedErr },
  ] =
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
  const countErr = totalErr ?? zeroErr ?? unmappedErr;
  if (countErr) throw new Error(`reservation counts failed: ${countErr.message}`);

  const [existing, recordedClosures] = await Promise.all([
    loadFindings(supabase, hotelId),
    loadRecordedClosures(supabase, hotelId),
  ]);
  const resolvedByKey = new Map<string, StoredFinding[]>();
  for (const f of existing.filter(isResolved)) {
    const key = `${f.kind}|${findingKey(f.kind, f.payload)}`;
    resolvedByKey.set(key, [...(resolvedByKey.get(key) ?? []), f]);
  }
  const resolvedFor = (kind: string, payload: Record<string, unknown>) =>
    resolvedByKey.get(`${kind}|${findingKey(kind, payload)}`) ?? [];
  // Informational findings and suggestions are answered per import: a refresh
  // months later is a new look at the data and may ask again. Closures, room
  // types and duplicates are answered for good, because answering them wrote
  // something (a closed period, a classification, a reactivation).
  const answeredInThisJob = (kind: string, payload: Record<string, unknown>) =>
    resolvedFor(kind, payload).filter((f) => f.job_id === job.id);

  const { seasonal, oneOff } = mergeSeasonalClosures(findClosedPeriods(daily, today));
  // A question the owner has answered is not asked again (see
  // loadAnsweredRoomTypeIds); confirming a re-raised card would overwrite
  // their answer. A resolved card counts too, for a database without the
  // classification columns.
  const answered = await loadAnsweredRoomTypeIds(supabase, hotelId);
  const allSuspects = findSuspectRoomTypes(stats);
  const suspects = allSuspects.filter(
    (s) =>
      !answered.has(s.room_type_id) &&
      resolvedFor("suspect_room_type", s as unknown as Record<string, unknown>).length === 0,
  );
  // An owner who dismissed an auto-deactivation has said the type is real.
  const duplicates = findDuplicateRoomTypes(stats).filter(
    (d) =>
      !resolvedFor("duplicate_room_type", d as unknown as Record<string, unknown>).some(
        (f) => f.status === "dismissed",
      ),
  );
  const outliers = findRateOutliers(stats).filter(
    (o) =>
      !answeredInThisJob("rate_outlier", o as unknown as Record<string, unknown>).some(
        (f) => Number(f.payload.max_rate ?? 0) >= o.max_rate,
      ),
  );

  const onRecordAsDeactivated = new Set(
    existing
      .filter((f) => f.kind === "duplicate_room_type" && f.status === "auto_applied")
      .map((f) => String(f.payload.deactivate_room_type_id ?? "")),
  );

  const closures = planClosureFindings({
    seasonal,
    oneOff,
    existing,
    recorded: recordedClosures,
    refreshMode,
  });
  const drafts: FindingDraft[] = [...closures.drafts];

  for (const s of suspects) {
    drafts.push({ kind: "suspect_room_type", status: "proposed", payload: s as unknown as Record<string, unknown> });
  }
  for (const o of outliers) {
    drafts.push({ kind: "rate_outlier", status: "proposed", payload: o as unknown as Record<string, unknown> });
  }

  // Duplicates: auto-fix on first import (reversible); on a refresh of an
  // established hotel, only propose — their setup is theirs.
  for (const d of duplicates) {
    // Re-asserting a deactivation that is already on record (the PMS handed
    // the room type back active, say) files no second copy of the same
    // paperwork. Refresh mode writes nothing, so it still has to file:
    // detection means the room type is active again, and the standing
    // auto_applied record only offers Dismiss, which would re-activate it.
    if (!refreshMode && onRecordAsDeactivated.has(d.deactivate_room_type_id)) continue;
    drafts.push({
      kind: "duplicate_room_type",
      status: refreshMode ? "proposed" : "auto_applied",
      payload: d as unknown as Record<string, unknown>,
    });
  }

  const total = totalRows ?? 0;
  if (total > 0 && (zeroRateRows ?? 0) / total > 0.02) {
    const payload = { count: zeroRateRows, share: (zeroRateRows ?? 0) / total };
    if (answeredInThisJob("zero_rate_rows", payload).length === 0) {
      drafts.push({ kind: "zero_rate_rows", status: "proposed", payload });
    }
  }
  if ((unmappedRows ?? 0) > 0) {
    const payload = { count: unmappedRows };
    if (answeredInThisJob("unmapped_room_type", payload).length === 0) {
      drafts.push({ kind: "unmapped_room_type", status: "proposed", payload });
    }
  }

  if (refreshMode) {
    for (const s of await buildSuggestionDrafts(supabase, hotelId, daily, stats, today)) {
      if (answeredInThisJob(s.kind, s.payload).length === 0) drafts.push(s);
    }
  }

  await extendConfirmedClosures(supabase, hotelId, closures.extensions);
  await writeFindings(supabase, hotelId, job.id, planFindingWrites(drafts, existing));

  // Deactivated only once the record of it is written. The other way round, a
  // pass that died in between left a room type switched off with nothing on
  // the review screen to show it or undo it — and no later pass could file
  // one, because the detector only sees active room types.
  if (!refreshMode) {
    for (const d of duplicates) {
      await supabase
        .from("room_types")
        .update({ is_active: false })
        .eq("id", d.deactivate_room_type_id);
    }
  }

  if (refreshMode) return; // suggestions only — no direct writes past this point

  // Strategy answers may have arrived while the import ran — re-project so
  // room types created by the import get their guardrails too. Once is
  // enough per import: saving an answer re-projects on its own, and running it
  // again at the end would overwrite a guardrail the owner changed in between.
  if (pass === "early" || typeof job.stats.earlyAnalysisAt !== "string") {
    await projectStrategyOntoRoomTypes(supabase, hotelId);
  }

  // Then data fills whatever the answers left at schema defaults: ceilings
  // from p99 x 1.5, floors from a fraction of the median — the guardrail
  // half of the starter package, applied while still in simulation mode.
  // Only defaults are ever touched, so a second pass fills a type the first
  // one skipped and leaves everything else alone.
  await applyInitialGuardrails(supabase, hotelId, stats, new Set(allSuspects.map((s) => s.room_type_id)));

  // The payoff: starter rules built from their own history, live-in-simulation.
  await recordStarterRules(supabase, job);
}

/**
 * Create the starter rules once per import and note them on the job for the
 * review screen.
 *
 * Once a pass has created them, later passes leave rules alone even if there
 * are none by then: an owner who deleted the starter set after the early pass
 * made a decision, and recreating it would undo that. A pass that created
 * them and died before its checkpoint finds them on record instead.
 */
async function recordStarterRules(supabase: SupabaseClient, job: ImportJobRow): Promise<void> {
  if (typeof job.stats.starterRulesAt === "string") return;
  let rules = await generateStarterRules(supabase, job.hotel_id);
  if (rules.length === 0 && !Array.isArray(job.stats.starterRules)) {
    rules = await starterRulesOnRecord(supabase, job);
  }
  if (rules.length === 0) return;
  job.stats = {
    ...job.stats,
    starterRules: rules.map((r) => ({ name: r.name, explanation: r.explanation })),
    starterRulesAt: new Date().toISOString(),
  };
}

async function starterRulesOnRecord(
  supabase: SupabaseClient,
  job: ImportJobRow,
): Promise<StarterRuleSpec[]> {
  const specs = computeStarterRules({ daysOfHistory: MIN_HISTORY_DAYS_FOR_STARTERS });
  let q = supabase
    .from("pricing_rules")
    .select("name")
    .eq("hotel_id", job.hotel_id)
    .in("name", specs.map((s) => s.name));
  // Only this import's: a hotel keeping the set from an earlier import did not
  // just have it built for them.
  if (job.created_at) q = q.gte("created_at", job.created_at);
  const { data } = await q;
  const names = new Set((data ?? []).map((r: { name: unknown }) => String(r.name)));
  return specs.filter((s) => names.has(s.name));
}

/** Refresh-mode: compare data-derived config against what exists; emit suggestions. */
async function buildSuggestionDrafts(
  supabase: SupabaseClient,
  hotelId: string,
  daily: DailyRoomNights[],
  /** The stats analyzeImport already read; this used to read them a second time. */
  parsedStats: RoomTypeStats[],
  today: string,
): Promise<FindingDraft[]> {
  const [
    { data: ruleRows, error: rulesErr },
    { data: roomTypes, error: typesErr },
    { data: settings, error: settingsErr },
  ] =
    await Promise.all([
      supabase
        .from("pricing_rules")
        .select(
          "id, name, is_active, is_pickup_rule, start_date, end_date, is_annual, dow_mask, rule_condition(occupancy_operator, occupancy_threshold, pickup_operator, pickup_threshold, booking_speed_operator), rule_signal_room_type(room_type_id), rule_affected_room_type(room_type_id)",
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
    ]);
  const readErr = rulesErr ?? typesErr ?? settingsErr;
  if (readErr) throw new Error(`suggestion inputs failed: ${readErr.message}`);

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
      start_date: r.start_date != null ? String(r.start_date) : null,
      end_date: r.end_date != null ? String(r.end_date) : null,
      is_annual: r.is_annual === true,
      dow_mask: Number(r.dow_mask ?? 127),
      signal_room_type_ids: ((r.rule_signal_room_type ?? []) as Array<{ room_type_id: unknown }>).map(
        (x) => String(x.room_type_id),
      ),
      affected_room_type_ids: ((r.rule_affected_room_type ?? []) as Array<{ room_type_id: unknown }>).map(
        (x) => String(x.room_type_id),
      ),
    };
  });

  const historyDays = daily.filter((d) => d.stay_date < today);
  const paceSpecs = computeStarterRules({ daysOfHistory: historyDays.length });
  const occupancyRef = computeOccupancyReference(
    historyDays.map((d) => Math.min(1, d.room_nights / totalRooms)),
  );

  const p99ByRoomType = new Map<string, number>();
  const rowCountByRoomType = new Map<string, number>();
  for (const s of parsedStats) {
    if (s.p99_rate != null) p99ByRoomType.set(s.room_type_id, s.p99_rate);
    rowCountByRoomType.set(s.room_type_id, s.row_count);
  }
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
    ...ruleSuggestions.map((s): FindingDraft => ({
      kind: "rule_suggestion",
      status: "proposed",
      payload: { ...s, room_type_ids: allRoomTypeIds } as unknown as Record<string, unknown>,
    })),
    ...guardrailSuggestions.map((s): FindingDraft => ({
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
