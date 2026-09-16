/**
 * Stay-date snapshot writer and retention — Implementation Guide §3.5, §11 step 1.
 * Deno-portable copy of src/lib/engine/snapshots.ts (import paths only differ).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomTypeRow, SnapshotRow } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllRows(makeQuery: () => any, pageSize = 1000): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let from = 0;
  let guard = 0;
  for (;;) {
    if (++guard > 1000) break; // safety backstop (~1M rows)
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** One snapshot cell as this run wrote it, keyed "stay_date|room_type_id". */
export type CellSnapshot = {
  booked_units: number;
  booked_revenue: number;
  sellable_units: number;
  snapshot_ts: string;
};

/**
 * Insert one snapshot row per (stay_date, room_type) across the full horizon
 * for a single hotel. Uses a consistent snapshot_ts for the whole run.
 *
 * Returns the cells it wrote. Everything downstream that needs "current
 * booked state" (metrics, the undone-pickup sweep) reads this map instead of
 * querying back the rows that were inserted moments ago — the numbers are
 * identical by construction, and re-reading them was a large share of the
 * engine's per-run query bill.
 */
export async function snapshotCurrentState(
  supabase: SupabaseClient,
  hotelId: string,
  snapshotTs: string,
  stayDates: string[],
  roomTypes: RoomTypeRow[],
): Promise<Map<string, CellSnapshot>> {
  if (stayDates.length === 0 || roomTypes.length === 0) return new Map();

  // §15.8: same snapshot_ts must not duplicate rows on re-run.
  const { error: delErr } = await supabase
    .from("stay_date_snapshot")
    .delete()
    .eq("hotel_id", hotelId)
    .eq("snapshot_ts", snapshotTs);
  if (delErr) throw new Error(`Snapshot delete (idempotent) failed: ${delErr.message}`);

  const rtIds = roomTypes.map((rt) => rt.id);

  // Aggregate booked_units and booked_revenue per (stay_date, room_type_id)
  // Paged, with a stable order. An unpaginated select silently stops at
  // PostgREST's 1000-row cap, which for a 50-room property at 60% occupancy
  // is reached about 33 days out — every stay date beyond that then
  // snapshots as zero booked, so occupancy reads 0 and pickup deltas go
  // negative. Discount ladders wrongly activate and increase ladders wrongly
  // deactivate for the whole far horizon.
  const agg = await fetchAllRows(() =>
    supabase
      .from("reservations")
      .select("stay_date, room_type_id, current_rate")
      .eq("hotel_id", hotelId)
      .in("stay_date", stayDates)
      .in("room_type_id", rtIds)
      .order("id", { ascending: true }),
  );

  const bookedMap = new Map<string, { units: number; revenue: number }>();
  for (const row of agg ?? []) {
    const key = `${row.stay_date}|${row.room_type_id}`;
    const entry = bookedMap.get(key) ?? { units: 0, revenue: 0 };
    entry.units += 1;
    entry.revenue += Number(row.current_rate ?? 0);
    bookedMap.set(key, entry);
  }

  const rows: SnapshotRow[] = [];
  for (const sd of stayDates) {
    for (const rt of roomTypes) {
      const key = `${sd}|${rt.id}`;
      const booked = bookedMap.get(key) ?? { units: 0, revenue: 0 };
      rows.push({
        hotel_id: hotelId,
        snapshot_ts: snapshotTs,
        stay_date: sd,
        room_type_id: rt.id,
        sellable_units: rt.total_rooms,
        booked_units: booked.units,
        booked_revenue: Math.round(booked.revenue * 100) / 100,
      });
    }
  }

  // Batch insert in chunks to avoid payload limits.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("stay_date_snapshot").insert(chunk);
    if (error) throw new Error(`Snapshot insert failed: ${error.message}`);
  }

  const cells = new Map<string, CellSnapshot>();
  for (const r of rows) {
    cells.set(`${r.stay_date}|${r.room_type_id}`, {
      booked_units: r.booked_units,
      booked_revenue: r.booked_revenue,
      sellable_units: r.sellable_units,
      snapshot_ts: snapshotTs,
    });
  }
  return cells;
}

export type SnapshotRowAt = {
  booked_units: number;
  booked_revenue: number;
  snapshot_ts: string;
};

/** §16.3 — baseline snapshot must not be “too old” vs target baseline_ts. */
export const BASELINE_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Batched replacement for the old per-cell nearest-snapshot query. All the
 * (baseline instant, stay date) pairs a run will ask about are known up
 * front — one instant per pickup window start plus one per fired (rule,
 * date)'s live event, so the instant count grows with live events, not
 * rules. Each instant fetches ONLY its own dates, walking the freshness
 * window NEWEST-FIRST and stopping the moment every cell has an answer —
 * the newest snapshot batch usually answers them all, so the typical cost
 * is one page instead of the window's full ~144-runs-worth of rows.
 *
 * Only rows inside the 12h freshness window are fetched at all. A cell whose
 * newest row at-or-before the instant is older than that was already treated
 * as missing-or-stale (§16.3) — the stale row's contents were never read —
 * so "absent from this store" and "present but stale" are the same case, and
 * the store need not distinguish them.
 */
export type BaselineSnapshotStore = {
  /** Fresh row for (baselineTs, stay_date, room_type), or undefined when the cell is missing/stale. */
  rowAt(baselineTs: string, stayDate: string, roomTypeId: string): SnapshotRowAt | undefined;
  /**
   * Newest snapshot_ts at or before baselineTs FOR THIS STAY DATE — the
   * coverage probe behind zero-baseline synthesis. Memoized per (instant,
   * date).
   *
   * Date-scoped on purpose. Hotel-wide coverage proved only that the writer
   * was alive, and the 5-minute tick keeps near dates fresh around the
   * clock — so a far date whose own snapshots ran out (beyond the tick
   * horizon, or between daily sweeps) still "passed" the probe, its stale
   * cells synthesized to zero, and its long-standing bookings read as a
   * fresh demand spike. Caught live: a date 52 days out fired a pickup rule
   * on 4 bookings that were 13 days old. Sibling room types at the SAME
   * date are the honest witness — they prove this date was being covered at
   * the instant, which is exactly the first-bookings-on-a-date case the
   * synthesis exists for.
   */
  coverageAt(baselineTs: string, stayDate: string): Promise<string | null>;
};

export async function buildBaselineSnapshotStore(
  supabase: SupabaseClient,
  hotelId: string,
  pairs: { baselineTs: string; stayDate: string }[],
  roomTypeIds: string[],
): Promise<BaselineSnapshotStore> {
  // Each instant only ever gets asked about the stay dates that resolved to
  // it — an event-derived instant maps to a single date, so fetching the
  // whole horizon for it would be almost entirely waste.
  const datesByTs = new Map<string, Set<string>>();
  for (const p of pairs) {
    const set = datesByTs.get(p.baselineTs) ?? new Set<string>();
    set.add(p.stayDate);
    datesByTs.set(p.baselineTs, set);
  }

  const byBaseline = new Map<string, Map<string, SnapshotRowAt>>();

  for (const [ts, dateSet] of datesByTs) {
    const dates = [...dateSet];
    const windowStart = new Date(new Date(ts).getTime() - BASELINE_SNAPSHOT_MAX_AGE_MS).toISOString();
    const cellCount = dates.length * roomTypeIds.length;
    const cells = new Map<string, SnapshotRowAt>();

    // Newest-first with first-seen-wins IS "nearest at or before the
    // instant" per cell; the early exit is what keeps this from reading the
    // window's entire history when the newest run already answered
    // everything. A cell with no row in the window simply never appears —
    // missing and stale are the same case upstream.
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("stay_date_snapshot")
        .select("stay_date, room_type_id, booked_units, booked_revenue, snapshot_ts")
        .eq("hotel_id", hotelId)
        .in("stay_date", dates)
        .in("room_type_id", roomTypeIds)
        .gte("snapshot_ts", windowStart)
        .lte("snapshot_ts", ts)
        .order("snapshot_ts", { ascending: false })
        .order("stay_date", { ascending: true })
        .order("room_type_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      for (const r of rows) {
        const key = `${r.stay_date}|${r.room_type_id}`;
        if (!cells.has(key)) {
          cells.set(key, {
            booked_units: Number(r.booked_units),
            booked_revenue: Number(r.booked_revenue),
            snapshot_ts: String(r.snapshot_ts),
          });
        }
      }
      if (rows.length < PAGE || cells.size >= cellCount) break;
    }

    byBaseline.set(ts, cells);
  }

  const coverage = new Map<string, string | null>();

  // Every date with a missing cell WILL get its coverage probed by metrics —
  // prefetch each instant's answers in one newest-first walk instead of one
  // round trip per date. A deep sweep can have hundreds of far dates whose
  // baselines fall between daily sweeps; probing them one by one was most of
  // the run. Dates with no row at all get an explicit null memo.
  for (const [ts, dateSet] of datesByTs) {
    const cells = byBaseline.get(ts)!;
    const missingDates = [...dateSet].filter((d) =>
      roomTypeIds.some((rt) => !cells.has(`${d}|${rt}`)),
    );
    if (missingDates.length === 0) continue;
    const pending = new Set(missingDates);
    const PAGE = 1000;
    for (let from = 0; pending.size > 0; from += PAGE) {
      const { data, error } = await supabase
        .from("stay_date_snapshot")
        .select("stay_date, snapshot_ts")
        .eq("hotel_id", hotelId)
        .in("stay_date", missingDates)
        .lte("snapshot_ts", ts)
        .order("snapshot_ts", { ascending: false })
        .order("stay_date", { ascending: true })
        .order("room_type_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      for (const r of rows) {
        const d = String(r.stay_date);
        if (pending.delete(d)) coverage.set(`${ts}|${d}`, String(r.snapshot_ts));
      }
      if (rows.length < PAGE) break;
    }
    for (const d of pending) coverage.set(`${ts}|${d}`, null);
  }

  return {
    rowAt(baselineTs, stayDate, roomTypeId) {
      return byBaseline.get(baselineTs)?.get(`${stayDate}|${roomTypeId}`);
    },
    async coverageAt(baselineTs, stayDate) {
      const key = `${baselineTs}|${stayDate}`;
      if (coverage.has(key)) return coverage.get(key) ?? null;
      // Fallback for combos outside the prefetch (direct store users).
      const { data } = await supabase
        .from("stay_date_snapshot")
        .select("snapshot_ts")
        .eq("hotel_id", hotelId)
        .eq("stay_date", stayDate)
        .lte("snapshot_ts", baselineTs)
        .order("snapshot_ts", { ascending: false })
        .limit(1)
        .maybeSingle();
      const ts = data?.snapshot_ts ? String(data.snapshot_ts) : null;
      coverage.set(key, ts);
      return ts;
    },
  };
}

/**
 * Purge snapshots older than the retention window (default 60 days).
 */
/** §3.5 — default60d; pass max(pickup_window_days)+7 when known. */
export async function purgeOldSnapshots(
  supabase: SupabaseClient,
  hotelId: string,
  retentionDays: number = 60,
): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const { error } = await supabase
    .from("stay_date_snapshot")
    .delete()
    .eq("hotel_id", hotelId)
    .lt("snapshot_ts", cutoff.toISOString());

  if (error) throw new Error(`Snapshot purge failed: ${error.message}`);
}
