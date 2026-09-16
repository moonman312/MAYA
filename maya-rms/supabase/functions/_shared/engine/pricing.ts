/**
 * Price assembly and publishing — Implementation Guide §7.1, §10, §11 steps 9-10.
 * Deno-portable copy of src/lib/engine/pricing.ts (import paths only differ).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LadderStateRow } from "./ladder.ts";
import { fetchAllRows } from "./snapshots.ts";
import type { AdjustmentSpec, RoomTypeRow } from "./types.ts";

export type AssembledPrice = {
  stay_date: string;
  room_type_id: string;
  base_price: number;
  floor_price: number;
  ceiling_price: number;
  ladder_effects: AdjustmentSpec[];
  pickup_effects: (AdjustmentSpec & { event_id: string })[];
  pre_clamp_price: number;
  final_price: number;
  clamped_by: "ceiling" | "floor" | "none";
};

/**
 * §10.2: Apply adjustments in order.
 *
 * Ladder effects in ascending rule_id order, then pickup effects in ascending
 * applied_at order. Percent adjustments compose multiplicatively; fixed
 * adjustments are additive.
 */
export function applyAdjustments(
  basePrice: number,
  ladderEffects: AdjustmentSpec[],
  pickupEffects: AdjustmentSpec[],
): number {
  let p = basePrice;

  for (const adj of ladderEffects) {
    p = applyOne(p, adj);
  }

  for (const adj of pickupEffects) {
    p = applyOne(p, adj);
  }

  return Math.round(p * 100) / 100;
}

function applyOne(p: number, adj: AdjustmentSpec): number {
  if (adj.action_kind === "fixed" && adj.action_direction === "increase") {
    return p + adj.action_value;
  }
  if (adj.action_kind === "fixed" && adj.action_direction === "decrease") {
    return p - adj.action_value;
  }
  if (adj.action_kind === "percent" && adj.action_direction === "increase") {
    return p * (1 + adj.action_value / 100);
  }
  if (adj.action_kind === "percent" && adj.action_direction === "decrease") {
    return p * (1 - adj.action_value / 100);
  }
  return p;
}

/**
 * Clamp price to floor/ceiling. §10.3: never emit negative or zero prices.
 */
export function clampPrice(
  price: number,
  floorPrice: number,
  ceilingPrice: number,
): { final: number; clamped_by: "ceiling" | "floor" | "none" } {
  if (price > ceilingPrice) return { final: ceilingPrice, clamped_by: "ceiling" };
  if (price < floorPrice) return { final: floorPrice, clamped_by: "floor" };
  return { final: Math.round(price * 100) / 100, clamped_by: "none" };
}

/**
 * One pass over the post-ladder state map, grouping ACTIVE rows per
 * (stay_date, room_type_id) cell sorted by rule_id ascending (§10.2).
 * Postgres orders uuid columns by byte value, which for the canonical
 * lowercase text form is the same order plain string comparison gives — so
 * each cell's list matches what the old per-cell query returned. Built once
 * per run: filtering the whole map per cell made pricing O(cells x states),
 * the same rules-x-dates scaling shape the batching removed from queries.
 */
export function indexActiveLadderEffects(
  states: Map<string, LadderStateRow>,
): Map<string, AdjustmentSpec[]> {
  const rows = [...states.values()].filter((r) => r.is_active);
  rows.sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
  const byCell = new Map<string, AdjustmentSpec[]>();
  for (const r of rows) {
    const key = `${r.stay_date}|${r.room_type_id}`;
    const list = byCell.get(key) ?? [];
    list.push({
      rule_id: r.rule_id,
      action_kind: r.action_kind,
      action_direction: r.action_direction,
      action_value: r.action_value,
    });
    byCell.set(key, list);
  }
  return byCell;
}

/**
 * All non-retired pickup effects for the horizon in one ranged read, grouped
 * per (stay_date, room_type_id) cell. Ordering is the DB's — applied_at
 * ascending then id ascending (§10.2) — and partitioning a globally ordered
 * list preserves each cell's order. Run AFTER this run's winners are
 * inserted: same-instant events tie-break on id, and ids are random uuids,
 * so only the DB can say what order they landed in.
 */
export async function loadActivePickupEffectsForRange(
  supabase: SupabaseClient,
  hotelId: string,
  firstDate: string,
  lastDate: string,
): Promise<Map<string, (AdjustmentSpec & { event_id: string })[]>> {
  const rows = await fetchAllRows(() =>
    supabase
      .from("pickup_event")
      .select("id, rule_id, stay_date, affected_room_type_id, action_kind, action_direction, action_value")
      .eq("hotel_id", hotelId)
      .gte("stay_date", firstDate)
      .lte("stay_date", lastDate)
      .is("retired_at", null)
      .order("applied_at", { ascending: true })
      .order("id", { ascending: true }),
  );
  const byCell = new Map<string, (AdjustmentSpec & { event_id: string })[]>();
  for (const r of rows) {
    const key = `${r.stay_date}|${r.affected_room_type_id}`;
    const list = byCell.get(key) ?? [];
    list.push({
      event_id: String(r.id),
      rule_id: String(r.rule_id),
      action_kind: r.action_kind,
      action_direction: r.action_direction,
      action_value: Number(r.action_value),
    });
    byCell.set(key, list);
  }
  return byCell;
}

/**
 * Assemble the final price for a single (stay_date, room_type) from
 * already-loaded effects.
 */
export function assemblePrice(
  stayDate: string,
  roomType: RoomTypeRow,
  basePrice: number,
  ladderEffects: AdjustmentSpec[],
  pickupEffects: (AdjustmentSpec & { event_id: string })[],
): AssembledPrice {
  const preClamp = applyAdjustments(basePrice, ladderEffects, pickupEffects);
  const { final, clamped_by } = clampPrice(preClamp, roomType.floor_price, roomType.ceiling_price);

  return {
    stay_date: stayDate,
    room_type_id: roomType.id,
    base_price: basePrice,
    floor_price: roomType.floor_price,
    ceiling_price: roomType.ceiling_price,
    ladder_effects: ladderEffects,
    pickup_effects: pickupEffects,
    pre_clamp_price: preClamp,
    final_price: final,
    clamped_by,
  };
}

export type PublishDecision = {
  /** Whether the row needs writing at all (price moved OR the remembered base is missing/wrong). */
  write: boolean;
  /** Whether the price itself moved — the only thing that counts as a publish in the change log. */
  priceMoved: boolean;
};

/**
 * §11 step 10: publish-on-change decision for one cell, against the
 * published_price row as it stood at run start. Nothing else writes the
 * table mid-run, so the preloaded row is exactly what a fresh per-cell read
 * would return.
 */
export function publishDecision(
  current: { price: number | string; base_price: number | string | null } | null | undefined,
  finalPrice: number,
  basePrice?: number,
): PublishDecision {
  const priceUnchanged = current != null && Number(current.price) === finalPrice;
  // The remembered base has to be written even on a run that does not move
  // the price, or a cell whose price is stable never records one — and it is
  // exactly those quiet cells that later lose their last reservation.
  const baseUnchanged =
    basePrice === undefined ||
    (current != null &&
      current.base_price != null &&
      Number(current.base_price) === basePrice);

  return { write: !(priceUnchanged && baseUnchanged), priceMoved: !priceUnchanged };
}

export type PublishRow = {
  payload: {
    hotel_id: string;
    stay_date: string;
    room_type_id: string;
    price: number;
    base_price?: number;
    computed_at: string;
  };
  priceMoved: boolean;
};

/**
 * Land the run's published_price changes in bulk. Returns how many PRICE
 * MOVES actually landed — a failed chunk must not report as published:
 * pricesPublished feeds the change log, and the PMS rate-push reads
 * published_price, so counting a write that didn't happen would report a
 * rate change the PMS never sees. Base-only corrections are bookkeeping and
 * never count either way.
 */
export async function flushPublishedPrices(
  supabase: SupabaseClient,
  rows: PublishRow[],
): Promise<number> {
  const CHUNK = 500;
  let published = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("published_price").upsert(
      chunk.map((r) => r.payload),
      { onConflict: "hotel_id,stay_date,room_type_id" },
    );
    if (error) {
      console.error(
        JSON.stringify({
          fn: "flushPublishedPrices",
          cells: chunk.map((r) => `${r.payload.stay_date}|${r.payload.room_type_id}`),
          error: error.message,
        }),
      );
      continue;
    }
    published += chunk.filter((r) => r.priceMoved).length;
  }
  return published;
}
