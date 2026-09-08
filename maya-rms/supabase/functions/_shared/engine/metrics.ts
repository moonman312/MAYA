/**
 * Metric computation — Implementation Guide §5, §8.1, §16.3.
 * Deno-portable copy of src/lib/engine/metrics.ts (import paths only differ).
 */

import type { EngineRule } from "./domain.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findSnapshotAt } from "./snapshots.ts";
import type { RuleMetrics } from "./types.ts";

/** §16.3 — baseline snapshot must not be “too old” vs target baseline_ts. */
const BASELINE_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * §5.1: days_until_arrival = (stay_date - evaluation_local_date).days
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
 * If baselineTs is null (ladder rules), pickup is not computed.
 */
export async function computeRuleMetrics(
  supabase: SupabaseClient,
  rule: EngineRule,
  hotelId: string,
  stayDate: string,
  evalTs: string,
  evalLocalDate: string,
  currentSnapshotTs: string,
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

  const currentSnapMap = await findSnapshotAt(
    supabase,
    hotelId,
    stayDate,
    rule.signal_room_type_ids,
    currentSnapshotTs,
  );

  const occMap = new Map<string, { booked_units: number; sellable_units: number }>();
  for (const rtId of rule.signal_room_type_ids) {
    const snap = currentSnapMap.get(rtId);
    const { data: snapFull } = await supabase
      .from("stay_date_snapshot")
      .select("sellable_units")
      .eq("hotel_id", hotelId)
      .eq("stay_date", stayDate)
      .eq("room_type_id", rtId)
      .eq("snapshot_ts", currentSnapshotTs)
      .maybeSingle();
    occMap.set(rtId, {
      booked_units: snap?.booked_units ?? 0,
      sellable_units: snapFull?.sellable_units ?? 0,
    });
  }

  const occupancy = computeOccupancy(occMap, rule.signal_room_type_ids);

  const currentForPickup = new Map<string, { booked_units: number; booked_revenue: number }>();
  for (const rtId of rule.signal_room_type_ids) {
    const s = currentSnapMap.get(rtId);
    if (s) currentForPickup.set(rtId, { booked_units: s.booked_units, booked_revenue: s.booked_revenue });
  }

  const nowAgg = sumSignalBooked(currentForPickup, rule.signal_room_type_ids);

  let net_pickup_units: number | null = null;
  let net_pickup_revenue: number | null = null;
  let pickup_block_reason: RuleMetrics["pickup_block_reason"] = null;
  let signal_booked_units_baseline = 0;
  let signal_booked_revenue_baseline = 0;

  if (baselineTs) {
    const baselineSnapsFull = await findSnapshotAt(
      supabase,
      hotelId,
      stayDate,
      rule.signal_room_type_ids,
      baselineTs,
    );

    for (const rtId of rule.signal_room_type_ids) {
      if (!baselineSnapsFull.has(rtId)) {
        pickup_block_reason = "insufficient_snapshot_history";
        break;
      }
      const row = baselineSnapsFull.get(rtId)!;
      const age = new Date(baselineTs).getTime() - new Date(row.snapshot_ts).getTime();
      if (age > BASELINE_SNAPSHOT_MAX_AGE_MS) {
        pickup_block_reason = "stale_baseline_snapshot";
        break;
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
