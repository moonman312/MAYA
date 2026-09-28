/**
 * In-memory stand-in for engine_booked_before from
 * 99_supabase_migration_undo_on_cancellation_v1.sql, written straight from
 * the SQL so engine tests run the migrated path against fakeSupabase.
 * undo-on-cancellation-sql.test.ts checks the real function against this
 * model in PGlite.
 */
import { describe, expect, it } from "vitest";
import type { FakeRow } from "./fake-supabase.test";

const iso = (v: unknown) => new Date(Date.parse(String(v))).toISOString();

/**
 * engine_booked_before(p_hotel_id, p_stay_dates, p_at): per (night, instant)
 * pair and room type, the rows on the night whose created_at is at or before
 * the instant, and the sum of their current_rate. Rows with no room type
 * are left out; a pair with no such row has none.
 */
export function engineBookedBefore(reservations: FakeRow[], a: Record<string, unknown>): FakeRow[] {
  const dates = (a.p_stay_dates as string[] | null) ?? [];
  const ats = (a.p_at as string[] | null) ?? [];
  const asked = new Map<string, { d: string; at: string }>();
  dates.forEach((d, i) => {
    if (d == null || ats[i] == null) return;
    const at = iso(ats[i]);
    asked.set(`${d}|${at}`, { d, at });
  });
  const out = new Map<string, FakeRow>();
  for (const { d, at } of asked.values()) {
    for (const r of reservations) {
      if (r.hotel_id !== a.p_hotel_id || String(r.stay_date) !== d || r.room_type_id == null) continue;
      if (!(Date.parse(String(r.created_at)) <= Date.parse(at))) continue;
      const key = `${d}|${at}|${r.room_type_id}`;
      const row = out.get(key) ?? { stay_date: d, as_of: at, room_type_id: String(r.room_type_id), units: 0, revenue: 0 };
      row.units = Number(row.units) + 1;
      row.revenue = Math.round((Number(row.revenue) + Number(r.current_rate ?? 0)) * 100) / 100;
      out.set(key, row);
    }
  }
  return [...out.values()].sort(
    (x, y) =>
      String(x.stay_date).localeCompare(String(y.stay_date)) ||
      String(x.as_of).localeCompare(String(y.as_of)) ||
      String(x.room_type_id).localeCompare(String(y.room_type_id)),
  );
}

/** An rpc handler for fakeSupabase that answers the undo migration's function. */
export function undoRpc(fn: string, args: unknown, tables: Record<string, FakeRow[]>): unknown {
  if (fn === "engine_booked_before") return engineBookedBefore(tables.reservations ?? [], args as Record<string, unknown>);
  return null;
}

describe("engine_booked_before model", () => {
  const res = (over: Partial<FakeRow>): FakeRow => ({
    hotel_id: "h1",
    stay_date: "2026-10-01",
    room_type_id: "rt1",
    current_rate: 100,
    created_at: "2026-09-01T10:00:00.000Z",
    ...over,
  });

  it("counts the rows first seen at or before each instant, per room type, with their revenue", () => {
    const rows = [
      res({}),
      res({ created_at: "2026-09-05T10:00:00.000Z", current_rate: 150.5 }),
      res({ room_type_id: "rt2", created_at: "2026-09-02T10:00:00.000Z" }),
      res({ room_type_id: null }),
      res({ hotel_id: "h2" }),
      res({ stay_date: "2026-10-02" }),
    ];
    const out = engineBookedBefore(rows, {
      p_hotel_id: "h1",
      p_stay_dates: ["2026-10-01", "2026-10-01", "2026-10-01"],
      p_at: ["2026-09-01T10:00:00+00:00", "2026-09-05T10:00:00.000Z", "2026-08-01T00:00:00Z"],
    });
    expect(out).toEqual([
      { stay_date: "2026-10-01", as_of: "2026-09-01T10:00:00.000Z", room_type_id: "rt1", units: 1, revenue: 100 },
      { stay_date: "2026-10-01", as_of: "2026-09-05T10:00:00.000Z", room_type_id: "rt1", units: 2, revenue: 250.5 },
      { stay_date: "2026-10-01", as_of: "2026-09-05T10:00:00.000Z", room_type_id: "rt2", units: 1, revenue: 100 },
    ]);
  });
});
