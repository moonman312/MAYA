/**
 * Price assembly and publishing — Implementation Guide §7.1, §10, §11 steps 9-10.
 * Deno-portable copy of src/lib/engine/pricing.ts (import paths only differ).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
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

/** §10.2: Apply adjustments in order. */
export function applyAdjustments(
  basePrice: number,
  ladderEffects: AdjustmentSpec[],
  pickupEffects: AdjustmentSpec[],
): number {
  let p = basePrice;
  for (const adj of ladderEffects) p = applyOne(p, adj);
  for (const adj of pickupEffects) p = applyOne(p, adj);
  return Math.round(p * 100) / 100;
}

function applyOne(p: number, adj: AdjustmentSpec): number {
  if (adj.action_kind === "fixed" && adj.action_direction === "increase") return p + adj.action_value;
  if (adj.action_kind === "fixed" && adj.action_direction === "decrease") return p - adj.action_value;
  if (adj.action_kind === "percent" && adj.action_direction === "increase") return p * (1 + adj.action_value / 100);
  if (adj.action_kind === "percent" && adj.action_direction === "decrease") return p * (1 - adj.action_value / 100);
  return p;
}

/** Clamp price to floor/ceiling. §10.3: never emit negative or zero prices. */
export function clampPrice(
  price: number,
  floorPrice: number,
  ceilingPrice: number,
): { final: number; clamped_by: "ceiling" | "floor" | "none" } {
  if (price > ceilingPrice) return { final: ceilingPrice, clamped_by: "ceiling" };
  if (price < floorPrice) return { final: floorPrice, clamped_by: "floor" };
  return { final: Math.round(price * 100) / 100, clamped_by: "none" };
}

/** Load all active ladder effects for a (stay_date, room_type_id), rule_id asc (§10.2). */
export async function loadActiveLadderEffects(
  supabase: SupabaseClient,
  stayDate: string,
  roomTypeId: string,
): Promise<AdjustmentSpec[]> {
  const { data } = await supabase
    .from("ladder_rule_state")
    .select("rule_id, action_kind, action_direction, action_value")
    .eq("stay_date", stayDate)
    .eq("room_type_id", roomTypeId)
    .eq("is_active", true)
    .order("rule_id", { ascending: true });

  return (data ?? []).map((r) => ({
    rule_id: String(r.rule_id),
    action_kind: r.action_kind,
    action_direction: r.action_direction,
    action_value: Number(r.action_value),
  }));
}

/** Load all non-retired pickup events for a (stay_date, room_type_id), applied_at asc then id asc. */
export async function loadActivePickupEffects(
  supabase: SupabaseClient,
  hotelId: string,
  stayDate: string,
  roomTypeId: string,
): Promise<(AdjustmentSpec & { event_id: string })[]> {
  const { data } = await supabase
    .from("pickup_event")
    .select("id, rule_id, action_kind, action_direction, action_value")
    .eq("hotel_id", hotelId)
    .eq("stay_date", stayDate)
    .eq("affected_room_type_id", roomTypeId)
    .is("retired_at", null)
    .order("applied_at", { ascending: true })
    .order("id", { ascending: true });

  return (data ?? []).map((r) => ({
    event_id: String(r.id),
    rule_id: String(r.rule_id),
    action_kind: r.action_kind,
    action_direction: r.action_direction,
    action_value: Number(r.action_value),
  }));
}

/** Assemble the final price for a single (stay_date, room_type). */
export async function assemblePrice(
  supabase: SupabaseClient,
  hotelId: string,
  stayDate: string,
  roomType: RoomTypeRow,
  basePrice: number,
): Promise<AssembledPrice> {
  const ladderEffects = await loadActiveLadderEffects(supabase, stayDate, roomType.id);
  const pickupEffects = await loadActivePickupEffects(supabase, hotelId, stayDate, roomType.id);

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

/** §11 step 10: Publish diffs — update published_price only if changed. */
export async function maybePublish(
  supabase: SupabaseClient,
  hotelId: string,
  stayDate: string,
  roomTypeId: string,
  finalPrice: number,
  computedAt: string,
  basePrice?: number,
): Promise<boolean> {
  const { data: current } = await supabase
    .from("published_price")
    .select("price, base_price")
    .eq("hotel_id", hotelId)
    .eq("stay_date", stayDate)
    .eq("room_type_id", roomTypeId)
    .maybeSingle();

  const priceUnchanged = current != null && Number(current.price) === finalPrice;
  // The remembered base has to be written even on a run that does not move
  // the price, or a cell whose price is stable never records one — and it is
  // exactly those quiet cells that later lose their last reservation.
  const baseUnchanged =
    basePrice === undefined ||
    (current != null &&
      current.base_price != null &&
      Number(current.base_price) === basePrice);

  if (priceUnchanged && baseUnchanged) {
    return false;
  }

  await supabase.from("published_price").upsert(
    {
      hotel_id: hotelId,
      stay_date: stayDate,
      room_type_id: roomTypeId,
      price: finalPrice,
      ...(basePrice !== undefined ? { base_price: basePrice } : {}),
      computed_at: computedAt,
    },
    { onConflict: "hotel_id,stay_date,room_type_id" },
  );

  // Only a real price move counts as a publish — a base-only correction is
  // bookkeeping and should not read as a rate change in the change log.
  return !priceUnchanged;
}
