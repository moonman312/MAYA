/**
 * In-memory stand-ins for the functions in
 * 99_supabase_migration_large_property_scale_v1.sql, written straight from
 * the SQL so engine tests can run the migrated path against fakeSupabase.
 * large-property-sql.test.ts checks the real SQL against the same
 * TypeScript computations in PGlite; these models only have to agree with
 * the SQL's contract.
 */
import { describe, expect, it } from "vitest";
import { daysBetween } from "@/lib/observations/calendar";
import type { FakeRow } from "./fake-supabase.test";

function windowOf(r: FakeRow): number | null {
  if (r.booking_date != null) return daysBetween(String(r.booking_date), String(r.stay_date));
  return r.booking_window_days != null ? Number(r.booking_window_days) : null;
}

function kept(r: FakeRow, hotelId: unknown, exclude: unknown): boolean {
  if (r.hotel_id !== hotelId) return false;
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

/** booking_speed_windows(p_hotel_id, p_dates, p_exclude) */
export function bookingSpeedWindows(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const wanted = new Set((a.p_dates as string[]) ?? []);
  const byDate = new Map<string, Map<number | null, number>>();
  for (const r of reservations) {
    if (!kept(r, a.p_hotel_id, a.p_exclude)) continue;
    const d = String(r.stay_date);
    if (!wanted.has(d)) continue;
    const m = byDate.get(d) ?? new Map();
    const w = windowOf(r);
    m.set(w, (m.get(w) ?? 0) + 1);
    byDate.set(d, m);
  }
  return [...byDate.keys()].sort().map((d) => {
    const entries = [...byDate.get(d)!.entries()].sort((x, y) =>
      x[0] === null ? 1 : y[0] === null ? -1 : x[0] - y[0],
    );
    return {
      stay_date: d,
      n: entries.reduce((s, e) => s + e[1], 0),
      bws: entries.map((e) => e[0]),
      counts: entries.map((e) => e[1]),
    };
  });
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

/** An rpc handler for fakeSupabase that answers every modeled function from the fake's own tables. */
export function scaleRpc(fn: string, args: unknown, tables: Record<string, FakeRow[]>): unknown {
  const a = args as Record<string, unknown>;
  switch (fn) {
    case "booking_speed_history_summary":
      return bookingSpeedHistorySummary(tables.reservations ?? [], a);
    case "booking_speed_windows":
      return bookingSpeedWindows(tables.reservations ?? [], a);
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
    expect(out).toEqual([{ stay_date: "2026-01-02", n: 5, bws: [-2, 5, 9, 32, null], counts: [1, 1, 1, 1, 1] }]);
  });
});
