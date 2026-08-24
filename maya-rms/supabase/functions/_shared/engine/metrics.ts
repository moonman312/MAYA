/**
 * Metric computation — Implementation Guide §5, §8.1, §16.3.
 * Deno-portable copy of src/lib/engine/metrics.ts (import paths only differ).
 */

import type { EngineRule } from "./domain.ts";
import {
  BASELINE_SNAPSHOT_MAX_AGE_MS,
  type BaselineSnapshotStore,
  type CellSnapshot,
} from "./snapshots.ts";
import type { RuleMetrics } from "./types.ts";

/**
 * §5.1: days_until_arrival = (stay_date - evaluation_local_date).days
 * Both are hotel-local YYYY-MM-DD strings; use UTC calendar math.
 */
export function computeDta(stayDate: string, evalLocalDate: string): number {
  const [ys, ms, ds] = stayDate.split("-").map(Number);
  const [ye, me, de] = evalLocalDate.split("-").map(Number);
  const sd = Date.UTC(ys, ms - 1, ds);
  const eld = Date.UTC(ye, me - 1, de);
  return Math.round((sd - eld) / 86_400_000);
}

/**
 * §5.2: combined occupancy across signal room types.
 *
 * occupancy = sum(booked_units) / sum(sellable_units) for signal set.
 * Returns null if denominator is 0.
 */
export function computeOccupancy(
  currentSnapshots: Map<string, { booked_units: number; sellable_units: number }>,
  signalRoomTypeIds: string[],
): number | null {
  let numerator = 0;
  let denominator = 0;

  for (const rtId of signalRoomTypeIds) {
    const snap = currentSnapshots.get(rtId);
    if (!snap) continue;
    if (snap.sellable_units === 0) continue;
    numerator += snap.booked_units;
    denominator += snap.sellable_units;
  }

  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * §5.3: net pickup = booked(now) - booked(baseline) across signal room types.
 * Call only when both maps contain every signal room type.
 */
export function computeNetPickup(
  currentSnapshots: Map<string, { booked_units: number; booked_revenue: number }>,
  baselineSnapshots: Map<string, { booked_units: number; booked_revenue: number }>,
  signalRoomTypeIds: string[],
): { units: number; revenue: number } {
  let units = 0;
  let revenue = 0;

  for (const rtId of signalRoomTypeIds) {
    const now = currentSnapshots.get(rtId)!;
    const base = baselineSnapshots.get(rtId)!;
    units += now.booked_units - base.booked_units;
    revenue += now.booked_revenue - base.booked_revenue;
  }

  return { units: Math.round(units), revenue: Math.round(revenue * 100) / 100 };
}

function sumSignalBooked(
  m: Map<string, { booked_units: number; booked_revenue: number }>,
  signalRoomTypeIds: string[],
): { units: number; revenue: number } {
  let units = 0;
  let revenue = 0;
  for (const rtId of signalRoomTypeIds) {
    const row = m.get(rtId);
    if (!row) continue;
    units += row.booked_units;
    revenue += row.booked_revenue;
  }
  return { units, revenue: Math.round(revenue * 100) / 100 };
}

/**
 * Precompute all metrics for a single (rule, stay_date) pair.
 *
 * Current state comes from the snapshot map this run just wrote; baselines
 * come from the pre-built store. The only query left is the store's lazy
 * hotel-coverage probe, and only when a baseline cell is missing or stale.
 *
 * If baselineTs is null (ladder rules), pickup is not computed.
 */
export async function computeRuleMetrics(
  rule: EngineRule,
  stayDate: string,
  evalLocalDate: string,
  currentSnaps: Map<string, CellSnapshot>,
  baselineStore: BaselineSnapshotStore | null,
  baselineTs: string | null,
): Promise<RuleMetrics> {
  const dta = computeDta(stayDate, evalLocalDate);

  // A rule's signal set is already filtered to active room types (see
  // evaluate.ts); if every signal room type it was configured against has
  // since been deactivated, there's nothing left to measure. Without this
  // check an empty signal set would compute occupancy null (harmless) but
  // net_pickup_units 0 with no block reason — a "lt" pickup condition would
  // then read "zero pickup" as a real signal and could fire on no evidence
  // at all. Block explicitly instead.
  if (rule.signal_room_type_ids.length === 0) {
    return {
      occupancy: null,
      dta,
      net_pickup_units: null,
      net_pickup_revenue: null,
      pickup_block_reason: "no_active_signal_room_types",
      signal_booked_units_baseline: 0,
      signal_booked_revenue_baseline: 0,
      signal_booked_units_now: 0,
      signal_booked_revenue_now: 0,
    };
  }

  const occMap = new Map<string, { booked_units: number; sellable_units: number }>();
  for (const rtId of rule.signal_room_type_ids) {
    const snap = currentSnaps.get(`${stayDate}|${rtId}`);
    occMap.set(rtId, {
      booked_units: snap?.booked_units ?? 0,
      sellable_units: snap?.sellable_units ?? 0,
    });
  }

  const occupancy = computeOccupancy(occMap, rule.signal_room_type_ids);

  const currentForPickup = new Map<string, { booked_units: number; booked_revenue: number }>();
  for (const rtId of rule.signal_room_type_ids) {
    const s = currentSnaps.get(`${stayDate}|${rtId}`);
    if (s) currentForPickup.set(rtId, { booked_units: s.booked_units, booked_revenue: s.booked_revenue });
  }

  const nowAgg = sumSignalBooked(currentForPickup, rule.signal_room_type_ids);

  let net_pickup_units: number | null = null;
  let net_pickup_revenue: number | null = null;
  let pickup_block_reason: RuleMetrics["pickup_block_reason"] = null;
  let signal_booked_units_baseline = 0;
  let signal_booked_revenue_baseline = 0;

  if (baselineTs && baselineStore) {
    const baselineSnapsFull = new Map<
      string,
      { booked_units: number; booked_revenue: number; snapshot_ts: string }
    >();

    // Cells the writer never covered get a synthesized zero-booked baseline
    // instead of a block. Earlier engine generations only wrote snapshot rows
    // for cells with bookings, so a date receiving its FIRST bookings has no
    // baseline row — exactly the moment a pickup rule exists to catch. The
    // hotel-level probe keeps the synthesis honest: zero is only assumed when
    // the hotel was demonstrably snapshotting at the baseline instant, so a
    // hotel that wasn't connected yet still blocks rather than fabricating a
    // flat past. (The store already folds "present but older than 12h" into
    // "missing" — §16.3 treated both identically and never read the stale
    // row's contents.)
    const missingOrStale: string[] = [];
    for (const rtId of rule.signal_room_type_ids) {
      const row = baselineStore.rowAt(baselineTs, stayDate, rtId);
      if (row) baselineSnapsFull.set(rtId, row);
      else missingOrStale.push(rtId);
    }
    if (missingOrStale.length > 0) {
      const coverageTs = await baselineStore.coverageAt(baselineTs);
      const coverageAge = coverageTs
        ? new Date(baselineTs).getTime() - new Date(coverageTs).getTime()
        : Number.POSITIVE_INFINITY;
      if (coverageTs && coverageAge <= BASELINE_SNAPSHOT_MAX_AGE_MS) {
        for (const rtId of missingOrStale) {
          baselineSnapsFull.set(rtId, {
            booked_units: 0,
            booked_revenue: 0,
            snapshot_ts: coverageTs,
          });
        }
      } else {
        pickup_block_reason = coverageTs
          ? "stale_baseline_snapshot"
          : "insufficient_snapshot_history";
      }
    }

    if (!pickup_block_reason) {
      const baselineForPickup = new Map<string, { booked_units: number; booked_revenue: number }>();
      for (const rtId of rule.signal_room_type_ids) {
        const s = baselineSnapsFull.get(rtId)!;
        baselineForPickup.set(rtId, { booked_units: s.booked_units, booked_revenue: s.booked_revenue });
      }
      const baseAgg = sumSignalBooked(baselineForPickup, rule.signal_room_type_ids);
      signal_booked_units_baseline = baseAgg.units;
      signal_booked_revenue_baseline = baseAgg.revenue;

      const pickup = computeNetPickup(currentForPickup, baselineForPickup, rule.signal_room_type_ids);
      net_pickup_units = pickup.units;
      net_pickup_revenue = pickup.revenue;
    }
  }

  return {
    occupancy,
    dta,
    net_pickup_units,
    net_pickup_revenue,
    pickup_block_reason,
    signal_booked_units_baseline,
    signal_booked_revenue_baseline,
    signal_booked_units_now: nowAgg.units,
    signal_booked_revenue_now: nowAgg.revenue,
  };
}
