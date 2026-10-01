/**
 * In-memory stand-ins for the functions in
 * 99_supabase_migration_large_property_scale_v1.sql, written straight from
 * the SQL so engine tests can run the migrated path against fakeSupabase.
 * large-property-sql.test.ts checks the real SQL against the same
 * TypeScript computations in PGlite; these models only have to agree with
 * the SQL's contract. audit_rows_before, from
 * 99_supabase_migration_pickup_wait_v1.sql, is here too, beside the other
 * audit read (checked against its SQL in pickup-wait-sql.test.ts).
 */
import { describe, expect, it } from "vitest";
import { FakeRpcError } from "./fake-supabase.test";
import { bookingKeyOf, earliestBookingWindow } from "@/lib/observations/booking-rows";
import { daysBetween } from "@/lib/observations/calendar";
import type { FakeRow } from "./fake-supabase.test";

function windowOf(r: FakeRow): number | null {
  if (r.booking_date != null) return daysBetween(String(r.booking_date), String(r.stay_date));
  return r.booking_window_days != null ? Number(r.booking_window_days) : null;
}

function kept(r: FakeRow, hotelId: unknown, exclude: unknown, include: unknown = null): boolean {
  if (r.hotel_id !== hotelId) return false;
  if (include != null) return r.room_type_id != null && (include as string[]).includes(String(r.room_type_id));
  const ex = (exclude as string[] | null) ?? [];
  return r.room_type_id == null || !ex.includes(String(r.room_type_id));
}

/** booking_speed_history_summary(p_hotel_id, p_from, p_to, p_exclude, p_ranks) */
export function bookingSpeedHistorySummary(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const byDate = new Map<string, (number | null)[]>();
  for (const r of reservations) {
    if (!kept(r, a.p_hotel_id, a.p_exclude)) continue;
    const d = String(r.stay_date);
    if (d < String(a.p_from)) continue;
    if (a.p_to != null && d > String(a.p_to)) continue;
    const list = byDate.get(d) ?? [];
    list.push(windowOf(r));
    byDate.set(d, list);
  }
  const ranks = (a.p_ranks as number[] | null) ?? [];
  return [...byDate.keys()].sort().map((d) => {
    const all = byDate.get(d)!;
    const usable = all.filter((w): w is number => w !== null && w >= 0).sort((x, y) => y - x);
    return {
      stay_date: d,
      n: all.length,
      usable: usable.length,
      rank_windows: usable.length === 0 ? ranks.map(() => null) : ranks.map((k) => usable[k - 1] ?? null),
    };
  });
}

/**
 * booking_speed_windows(p_hotel_id, p_dates, p_exclude, p_include, p_since),
 * as 99_supabase_migration_booking_speed_counts_bookings_v1.sql defines it:
 * one count per booking (booking_key over external_reservation_id, a row
 * with none is its own booking) at its longest known window on the night,
 * `since` null. With p_since (one instant per date), one row per distinct
 * (date, instant) pair, counting only the bookings first seen after the
 * instant (the earliest created_at across the booking's rows; a row without
 * one is taken as already there, as the builder takes it), `since` the
 * instant as given. Rows by date, then instant.
 */
export function bookingSpeedWindows(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const dates = ((a.p_dates as string[]) ?? []).map(String);
  const sinces = a.p_since != null ? (a.p_since as unknown[]).map(String) : null;
  if (sinces && sinces.length !== dates.length) {
    throw new Error(`p_since needs one instant per date: ${dates.length} dates, ${sinces.length} instants`);
  }
  const wanted = new Set(dates);
  const byDate = new Map<string, Map<string, { bw: number | null; seen: number }>>();
  let anonymous = 0;
  for (const r of reservations) {
    if (!kept(r, a.p_hotel_id, a.p_exclude, a.p_include)) continue;
    const d = String(r.stay_date);
    if (!wanted.has(d)) continue;
    const m = byDate.get(d) ?? new Map<string, { bw: number | null; seen: number }>();
    // An empty id is its own row, as in the SQL (nullif) and the builder.
    const key =
      r.external_reservation_id != null && r.external_reservation_id !== ""
        ? bookingKeyOf(String(r.external_reservation_id))
        : r.id != null
          ? `id ${String(r.id)}`
          : `row ${anonymous++}`;
    const w = windowOf(r);
    const seen = r.created_at != null ? Date.parse(String(r.created_at)) : -Infinity;
    const prev = m.get(key);
    m.set(key, prev ? { bw: earliestBookingWindow(prev.bw, w), seen: Math.min(prev.seen, seen) } : { bw: w, seen });
    byDate.set(d, m);
  }
  const row = (d: string, since: string | null): FakeRow[] => {
    const after = since === null ? null : Date.parse(since);
    const counts = new Map<number | null, number>();
    for (const b of byDate.get(d)?.values() ?? []) {
      if (after !== null && !(b.seen > after)) continue;
      counts.set(b.bw, (counts.get(b.bw) ?? 0) + 1);
    }
    // A date (or pair) with no booking to count has no row.
    if (counts.size === 0) return [];
    const entries = [...counts.entries()].sort((x, y) =>
      x[0] === null ? 1 : y[0] === null ? -1 : x[0] - y[0],
    );
    return [
      {
        stay_date: d,
        since,
        n: entries.reduce((s, e) => s + e[1], 0),
        bws: entries.map((e) => e[0]),
        counts: entries.map((e) => e[1]),
      },
    ];
  };
  if (!sinces) return [...byDate.keys()].sort().flatMap((d) => row(d, null));
  const pairs = new Map<string, [string, string]>();
  dates.forEach((d, i) => pairs.set(`${d}|${Date.parse(sinces[i])}`, [d, sinces[i]]));
  return [...pairs.values()]
    .sort((x, y) => x[0].localeCompare(y[0]) || Date.parse(x[1]) - Date.parse(y[1]))
    .flatMap(([d, since]) => row(d, since));
}

/** booking_speed_first_stay_date(p_hotel_id, p_from, p_include) */
export function bookingSpeedFirstStayDate(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const include = (a.p_include as string[] | null) ?? [];
  let first: string | null = null;
  for (const r of reservations) {
    if (r.hotel_id !== a.p_hotel_id || r.room_type_id == null || !include.includes(String(r.room_type_id))) continue;
    const d = String(r.stay_date);
    if (d >= String(a.p_from) && (first === null || d < first)) first = d;
  }
  return first === null ? [] : [{ first_stay_date: first }];
}

/** snapshot_cells_at(p_hotel_id, p_ts, p_from, p_to, p_room_types) */
export function snapshotCellsAt(snapshots: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const types = new Set((a.p_room_types as string[]) ?? []);
  const ts = Date.parse(String(a.p_ts));
  const best = new Map<string, FakeRow>();
  for (const s of snapshots) {
    if (s.hotel_id !== a.p_hotel_id) continue;
    const d = String(s.stay_date);
    if (d < String(a.p_from) || d > String(a.p_to)) continue;
    if (!types.has(String(s.room_type_id))) continue;
    if (Date.parse(String(s.snapshot_ts)) > ts) continue;
    const key = `${d}|${s.room_type_id}`;
    const prev = best.get(key);
    if (!prev || Date.parse(String(s.snapshot_ts)) > Date.parse(String(prev.snapshot_ts))) best.set(key, s);
  }
  return [...best.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([, s]) => ({
      stay_date: s.stay_date,
      room_type_id: s.room_type_id,
      booked_units: s.booked_units,
      booked_revenue: s.booked_revenue,
      snapshot_ts: s.snapshot_ts,
    }));
}

/** audit_last_signatures(p_hotel_id, p_from, p_to) */
export function auditLastSignatures(audits: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const best = new Map<string, FakeRow>();
  for (const r of audits) {
    if (r.hotel_id !== a.p_hotel_id) continue;
    const d = String(r.stay_date);
    if (d < String(a.p_from) || d > String(a.p_to)) continue;
    const key = `${d}|${r.room_type_id}`;
    const prev = best.get(key);
    const newer =
      !prev ||
      Date.parse(String(r.evaluated_at)) > Date.parse(String(prev.evaluated_at)) ||
      (Date.parse(String(r.evaluated_at)) === Date.parse(String(prev.evaluated_at)) && String(r.id) > String(prev.id));
    if (newer) best.set(key, r);
  }
  return [...best.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([, r]) => {
      const d = (r.details ?? {}) as Record<string, unknown>;
      return {
        stay_date: r.stay_date,
        room_type_id: r.room_type_id,
        final_price: r.final_price,
        application_order: d.application_order ?? null,
        clamped_by: d.clamped_by != null ? String(d.clamped_by) : null,
        base_source: d.base_source != null ? String(d.base_source) : null,
        manual_override: d.manual_override ?? null,
      };
    });
}

/** room_type_max_rates(p_hotel_id) */
export function roomTypeMaxRates(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const max = new Map<string, number>();
  for (const r of reservations) {
    if (r.hotel_id !== a.p_hotel_id || r.room_type_id == null || r.current_rate == null) continue;
    const id = String(r.room_type_id);
    max.set(id, Math.max(max.get(id) ?? -Infinity, Number(r.current_rate)));
  }
  return [...max].map(([room_type_id, max_rate]) => ({ room_type_id, max_rate }));
}

/**
 * Whether a fire at `at` is inside rule_fires' 90 days
 * (99_supabase_migration_rule_fire_log_v1.sql). A row a test wrote without a
 * time is taken as recent.
 */
export function inFireWindow(at: unknown, nowMs: number = Date.now()): boolean {
  if (at == null) return true;
  const t = Date.parse(String(at));
  return !Number.isFinite(t) || t >= nowMs - 90 * 86_400_000;
}

/** rule_fire_counts(p_hotel_id): a count of rule_fires per rule. */
export function ruleFireCounts(ladder: FakeRow[], pickup: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const counts = new Map<string, number>();
  for (const e of ladder) {
    if (e.hotel_id !== a.p_hotel_id || e.transition !== "activate" || !inFireWindow(e.transitioned_at)) continue;
    counts.set(String(e.rule_id), (counts.get(String(e.rule_id)) ?? 0) + 1);
  }
  for (const e of pickup) {
    // A fire the old same-run bug wrote and took off at once never happened.
    if (e.hotel_id !== a.p_hotel_id || e.retired_reason === "self_cancelled" || !inFireWindow(e.applied_at)) continue;
    counts.set(String(e.rule_id), (counts.get(String(e.rule_id)) ?? 0) + 1);
  }
  return [...counts].map(([rule_id, fires]) => ({ rule_id, fires }));
}

/** engine_reservation_cells(p_hotel_id, p_from, p_to), with the engine's own tie-break (created_at, then id). */
export function engineReservationCells(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const cells = new Map<string, { units: number; revenue: number; latest: FakeRow }>();
  const ordered = reservations
    .filter((r) => r.hotel_id === a.p_hotel_id && r.room_type_id != null)
    .filter((r) => String(r.stay_date) >= String(a.p_from) && String(r.stay_date) <= String(a.p_to))
    .sort((x, y) => (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
  for (const r of ordered) {
    const key = `${r.stay_date}|${r.room_type_id}`;
    const c = cells.get(key);
    const rate = r.current_rate != null ? Math.round(Number(r.current_rate) * 100) : 0;
    if (!c) {
      cells.set(key, { units: 1, revenue: rate, latest: r });
    } else {
      c.units += 1;
      c.revenue += rate;
      if (String(r.created_at ?? "") > String(c.latest.created_at ?? "")) c.latest = r;
    }
  }
  return [...cells.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([, c]) => ({
      stay_date: c.latest.stay_date,
      room_type_id: c.latest.room_type_id,
      units: c.units,
      // Exact cents, the way numeric sums them.
      revenue: c.revenue / 100,
      latest_base_rate: c.latest.base_rate ?? null,
      latest_created_at: c.latest.created_at,
    }));
}

/** calendar_daily_revenue(p_hotel_id): every date, the whole series. */
export function calendarDailyRevenue(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const cents = new Map<string, number>();
  for (const r of reservations) {
    if (r.hotel_id !== a.p_hotel_id) continue;
    const d = String(r.stay_date);
    cents.set(d, (cents.get(d) ?? 0) + (r.current_rate != null ? Math.round(Number(r.current_rate) * 100) : 0));
  }
  return [...cents.keys()].sort().map((d) => ({ stay_date: d, revenue: cents.get(d)! / 100 }));
}

/** calendar_daily_revenue_v2(p_hotel_id, p_after, p_limit) */
export function calendarDailyRevenueV2(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const limit = Math.max(1, Math.min(Number(a.p_limit ?? 1000), 1000));
  return calendarDailyRevenue(reservations, a)
    .filter((r) => a.p_after == null || String(r.stay_date) > String(a.p_after))
    .slice(0, limit);
}

/**
 * calendar_daily_revenue_v3(p_hotel_id, p_after, p_limit): per date, the room
 * revenue a calendar day counts for its RevPAR: active room types that count
 * as rooms, each booking at coalesce(base_rate, current_rate, 0). Every date
 * with a booking is listed.
 */
export function calendarDailyRevenueV3(reservations: FakeRow[], roomTypes: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const counting = new Set(
    roomTypes
      .filter((rt) => rt.hotel_id === a.p_hotel_id && rt.is_active !== false && rt.counts_as_room !== false)
      .map((rt) => String(rt.id)),
  );
  const cents = new Map<string, number>();
  for (const r of reservations) {
    if (r.hotel_id !== a.p_hotel_id) continue;
    const d = String(r.stay_date);
    const amount = r.base_rate != null ? Number(r.base_rate) : r.current_rate != null ? Number(r.current_rate) : 0;
    const counted = r.room_type_id != null && counting.has(String(r.room_type_id));
    cents.set(d, (cents.get(d) ?? 0) + (counted ? Math.round(amount * 100) : 0));
  }
  const limit = Math.max(1, Math.min(Number(a.p_limit ?? 1000), 1000));
  return [...cents.keys()]
    .sort()
    .filter((d) => a.p_after == null || d > String(a.p_after))
    .slice(0, limit)
    .map((d) => ({ stay_date: d, revenue: cents.get(d)! / 100 }));
}

/** audit_rows_before(p_hotel_id, p_before, p_stay_dates, p_room_type_ids) */
export function auditRowsBefore(audits: FakeRow[], a: Record<string, unknown>): FakeRow[] | FakeRpcError {
  const dates = (a.p_stay_dates as string[] | null) ?? [];
  const types = (a.p_room_type_ids as string[] | null) ?? [];
  if (dates.length !== types.length) {
    return new FakeRpcError({ code: "22023", message: "p_stay_dates and p_room_type_ids pair up: one room type per night" });
  }
  const wanted = new Set(dates.map((d, i) => `${d}|${types[i]}`));
  const before = Date.parse(String(a.p_before));
  const best = new Map<string, FakeRow>();
  for (const r of audits) {
    if (r.hotel_id !== a.p_hotel_id) continue;
    const key = `${r.stay_date}|${r.room_type_id}`;
    if (!wanted.has(key)) continue;
    const at = Date.parse(String(r.evaluated_at));
    if (!(at < before)) continue;
    const prev = best.get(key);
    const prevAt = prev ? Date.parse(String(prev.evaluated_at)) : -Infinity;
    if (!prev || at > prevAt || (at === prevAt && String(r.id) > String(prev.id))) best.set(key, r);
  }
  return [...best.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([, r]) => {
      const d = (r.details ?? {}) as Record<string, unknown>;
      return {
        stay_date: r.stay_date,
        room_type_id: r.room_type_id,
        evaluated_at: r.evaluated_at,
        base_price: r.base_price ?? null,
        final_price: r.final_price,
        application_order: d.application_order ?? null,
        base_source: d.base_source != null ? String(d.base_source) : null,
        manual_override: d.manual_override ?? null,
      };
    });
}

/** An rpc handler for fakeSupabase that answers every modeled function from the fake's own tables. */
export function scaleRpc(fn: string, args: unknown, tables: Record<string, FakeRow[]>): unknown {
  const a = args as Record<string, unknown>;
  switch (fn) {
    case "booking_speed_history_summary":
      return bookingSpeedHistorySummary(tables.reservations ?? [], a);
    case "booking_speed_windows":
      return bookingSpeedWindows(tables.reservations ?? [], a);
    case "booking_speed_first_stay_date":
      return bookingSpeedFirstStayDate(tables.reservations ?? [], a);
    case "audit_last_signatures":
      return auditLastSignatures(tables.evaluation_audit ?? [], a);
    case "audit_rows_before":
      return auditRowsBefore(tables.evaluation_audit ?? [], a);
    case "room_type_max_rates":
      return roomTypeMaxRates(tables.reservations ?? [], a);
    case "rule_fire_counts":
      return ruleFireCounts(tables.ladder_transition_event ?? [], tables.pickup_event ?? [], a);
    case "engine_reservation_cells":
      return engineReservationCells(tables.reservations ?? [], a);
    case "calendar_daily_revenue_v2":
      return calendarDailyRevenueV2(tables.reservations ?? [], a);
    case "calendar_daily_revenue_v3":
      return calendarDailyRevenueV3(tables.reservations ?? [], tables.room_types ?? [], a);
    case "snapshot_cells_at":
      return snapshotCellsAt(tables.stay_date_snapshot ?? [], a);
    default:
      return null;
  }
}

describe("scale rpc models", () => {
  const rows: FakeRow[] = [
    { hotel_id: "h1", stay_date: "2026-01-02", booking_date: "2025-12-01", booking_window_days: 3, room_type_id: "a" },
    { hotel_id: "h1", stay_date: "2026-01-02", booking_date: null, booking_window_days: 5, room_type_id: null },
    { hotel_id: "h1", stay_date: "2026-01-02", booking_date: null, booking_window_days: null, room_type_id: "a" },
    { hotel_id: "h1", stay_date: "2026-01-02", booking_date: "2026-01-04", booking_window_days: 0, room_type_id: "a" },
    { hotel_id: "h1", stay_date: "2026-01-02", booking_date: null, booking_window_days: 9, room_type_id: "x" },
    { hotel_id: "h2", stay_date: "2026-01-02", booking_date: null, booking_window_days: 9, room_type_id: "a" },
  ];

  it("summarises kept rows with the window at each rank", () => {
    const out = bookingSpeedHistorySummary(rows, {
      p_hotel_id: "h1",
      p_from: "2026-01-01",
      p_to: null,
      p_exclude: ["x"],
      p_ranks: [1, 2, 3],
    });
    expect(out).toEqual([{ stay_date: "2026-01-02", n: 4, usable: 2, rank_windows: [32, 5, null] }]);
  });

  it("groups windows per requested date, nulls last", () => {
    const out = bookingSpeedWindows(rows, { p_hotel_id: "h1", p_dates: ["2026-01-02"], p_exclude: [] });
    expect(out).toEqual([{ stay_date: "2026-01-02", since: null, n: 5, bws: [-2, 5, 9, 32, null], counts: [1, 1, 1, 1, 1] }]);
  });

  it("counts a reservation with several rooms once, at its earliest booking date on the night", () => {
    // A 20-room Cloudbeds wedding, one row per room, two of them added a
    // month later; a Think reservation with two rooms; a Mews GUID; and a
    // row with no id at all (its own booking).
    const wedding: FakeRow[] = Array.from({ length: 20 }, (_, i) => ({
      hotel_id: "h1",
      stay_date: "2026-06-06",
      room_type_id: "a",
      external_reservation_id: `6364686337417-${i + 1}`,
      booking_date: i < 18 ? "2026-01-01" : "2026-02-01",
      booking_window_days: null,
    }));
    const others: FakeRow[] = [
      { hotel_id: "h1", stay_date: "2026-06-06", room_type_id: "a", external_reservation_id: "res_9:b1", booking_date: "2026-05-01" },
      { hotel_id: "h1", stay_date: "2026-06-06", room_type_id: "a", external_reservation_id: "res_9:b2", booking_date: "2026-05-01" },
      { hotel_id: "h1", stay_date: "2026-06-06", room_type_id: "a", external_reservation_id: "0d3a8c2e-1f4b-4c5d-9e6f-7a8b9c0d1e2f", booking_date: "2026-05-01" },
      { hotel_id: "h1", stay_date: "2026-06-06", room_type_id: "a", booking_date: "2026-05-01" },
    ];
    const out = bookingSpeedWindows([...wedding, ...others], { p_hotel_id: "h1", p_dates: ["2026-06-06"], p_exclude: [] });
    expect(out).toEqual([{ stay_date: "2026-06-06", since: null, n: 4, bws: [36, 156], counts: [3, 1] }]);
  });

  it("finds an include list's earliest stay date from p_from, over every row of the hotel", () => {
    const more: FakeRow[] = [
      ...rows,
      { hotel_id: "h1", stay_date: "2025-06-01", booking_date: null, booking_window_days: 1, room_type_id: "a" },
      { hotel_id: "h1", stay_date: "2025-05-01", booking_date: null, booking_window_days: 1, room_type_id: null },
      { hotel_id: "h2", stay_date: "2025-01-01", booking_date: null, booking_window_days: 1, room_type_id: "a" },
    ];
    expect(bookingSpeedFirstStayDate(more, { p_hotel_id: "h1", p_from: "2025-01-01", p_include: ["a"] })).toEqual([
      { first_stay_date: "2025-06-01" },
    ]);
    expect(bookingSpeedFirstStayDate(more, { p_hotel_id: "h1", p_from: "2025-07-01", p_include: ["a", "x"] })).toEqual([
      { first_stay_date: "2026-01-02" },
    ]);
    expect(bookingSpeedFirstStayDate(more, { p_hotel_id: "h1", p_from: "2025-01-01", p_include: ["zz"] })).toEqual([]);
  });

  it("keeps only the included room types, never a row with none, when given an include list", () => {
    const out = bookingSpeedWindows(rows, { p_hotel_id: "h1", p_dates: ["2026-01-02"], p_exclude: ["a"], p_include: ["a"] });
    expect(out).toEqual([{ stay_date: "2026-01-02", since: null, n: 3, bws: [-2, 32, null], counts: [1, 1, 1] }]);
    expect(bookingSpeedWindows(rows, { p_hotel_id: "h1", p_dates: ["2026-01-02"], p_include: [] })).toEqual([]);
    // A null include is the exclude filter, as before.
    expect(bookingSpeedWindows(rows, { p_hotel_id: "h1", p_dates: ["2026-01-02"], p_exclude: ["x"], p_include: null })).toEqual([
      { stay_date: "2026-01-02", since: null, n: 4, bws: [-2, 5, 32, null], counts: [1, 1, 1, 1] },
    ]);
  });
});
