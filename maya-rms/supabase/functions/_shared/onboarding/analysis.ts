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

  const findings: ClosedPeriodFinding[] = [];
  let runStart: number | null = null;

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

  for (let i = 0; i < days.length; i++) {
    if (days[i].nights === 0) {
      if (runStart === null) runStart = i;
    } else if (runStart !== null) {
      flush(runStart, i - 1);
      runStart = null;
    }
  }
  if (runStart !== null) flush(runStart, days.length - 1);

  return findings;
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
    const threshold = Math.max(s.p99_rate * 3, s.median_rate * 10);
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

  const closed = findClosedPeriods(daily, today);
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

  for (const c of closed) {
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

  // Auto-applied: deactivate exact-duplicate room types with zero bookings.
  for (const d of duplicates) {
    await supabase
      .from("room_types")
      .update({ is_active: false })
      .eq("id", d.deactivate_room_type_id);
    inserts.push({
      hotel_id: hotelId,
      job_id: job.id,
      kind: "duplicate_room_type",
      status: "auto_applied",
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

  if (inserts.length > 0) {
    const { error } = await supabase.from("onboarding_findings").insert(inserts);
    if (error) throw new Error(`onboarding_findings insert failed: ${error.message}`);
  }

  // Strategy answers may have arrived while the import ran — re-project so
  // room types created by the import get their guardrails too.
  await projectStrategyOntoRoomTypes(supabase, hotelId);
}
