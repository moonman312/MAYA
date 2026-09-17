/**
 * Price assembly and publishing — Implementation Guide §7.1, §10, §11 steps 9-10.
 * Deno-portable copy of src/lib/engine/pricing.ts (import paths only differ).
 *
 * Loads active ladder and pickup effects, applies them in order, clamps to
 * floor/ceiling, and publishes diffs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BaseSource } from "./base-price.ts";
import { fetchAllRows } from "./snapshots.ts";
import type { ActionDirection } from "./domain.ts";
import type { AdjustmentSpec, RoomTypeRow } from "./types.ts";

/** An open fire of an event rule, as it applies to a cell's price. */
export type PickupEffect = AdjustmentSpec & {
  event_id: string;
  /** When it fired, and its fire number on the cell. Absent only in hand-built test data. */
  applied_at?: string;
  fire_seq?: number;
};

export type AssembledPrice = {
  stay_date: string;
  room_type_id: string;
  base_price: number;
  /** Which tier supplied base_price — see resolveBase. */
  base_source: BaseSource;
  floor_price: number;
  ceiling_price: number;
  ladder_effects: AdjustmentSpec[];
  pickup_effects: PickupEffect[];
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
 * Clamp price to floor/ceiling. §10.3: never emit negative or zero prices,
 * except that a floor of 0 is taken as given: only priceBounds makes one, for
 * a manual price of 0.
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
 * Whether an event rule may fire on a cell whose published price is
 * `currentFinal`, given the cell's bounds (priceBounds): a cut only while the
 * price is above the floor, a raise only while it is below the ceiling.
 *
 * Only the limit in the fire's own direction stops it. A raise on a night
 * whose stacked cuts sit hidden under a floor raised since still fires, and
 * so does a cut hidden above a lowered ceiling: each moves the pre-clamp
 * price back toward the range, and blocking them would leave the night stuck
 * at the limit through a change of demand.
 */
export function limitAllowsFire(
  currentFinal: number,
  bounds: { floor: number; ceiling: number },
  direction: ActionDirection,
): boolean {
  const cents = Math.round(currentFinal * 100);
  return direction === "decrease" ? cents > Math.round(bounds.floor * 100) : cents < Math.round(bounds.ceiling * 100);
}

/**
 * Whether the adjustment itself would move the cell's price, before any
 * clamp. A percent on a comp night typed as 0 is the case this catches:
 * nothing multiplies 0 into anything else, so the rule would fire on every
 * wait for ever, writing a fire and an audit row each time and telling the
 * owner after three of them that a night published at 0.00 has been raised
 * three times. The limit guard can't see it, because 0 is under no ceiling.
 *
 * Deliberately pre-clamp: a raise whose result is still hidden under a floor
 * raised since does move the price it is stacked on, and blocking it would
 * leave the night stuck at that floor through a change of demand
 * (limitAllowsFire).
 */
export function firingMovesPrice(
  basePrice: number,
  ladderEffects: AdjustmentSpec[],
  pickupEffects: AdjustmentSpec[],
  adjustment: AdjustmentSpec,
): boolean {
  const before = applyAdjustments(basePrice, ladderEffects, pickupEffects);
  const after = applyAdjustments(basePrice, ladderEffects, [...pickupEffects, adjustment]);
  return Math.round(before * 100) !== Math.round(after * 100);
}

/**
 * The floor and ceiling a cell's price is clamped to.
 *
 * A manual price is published as it is, under the floor (a $0 comp night) or
 * over the ceiling included: the bounds hold MAYA's own moves, not a number a
 * person set, whether it was typed in MAYA or changed in the PMS on a night
 * MAYA had sent. Clamping it published a different number, and on a night
 * changed in the PMS the push then wrote that number over the hotel's own.
 * Rules stacked on it are still clamped, to bounds widened only as far as the
 * manual price itself, so no rule takes the price further out than the
 * person put it. The push's guardrails allow exactly the same range
 * (push-guardrails.ts).
 */
export function priceBounds(
  floorPrice: number,
  ceilingPrice: number,
  basePrice: number,
  baseSource: BaseSource,
): { floor: number; ceiling: number } {
  if (baseSource !== "manual" || !Number.isFinite(basePrice)) return { floor: floorPrice, ceiling: ceilingPrice };
  return { floor: Math.min(floorPrice, basePrice), ceiling: Math.max(ceilingPrice, basePrice) };
}

/**
 * Load all active ladder effects for a (stay_date, room_type_id),
 * ordered by rule_id ascending (§10.2).
 *
 * `supportsSuppression` false means the run found no suppressed_at column
 * (see probeSuppressionSupport in ladder.ts): the filter is skipped and
 * every active effect applies, exactly as before manual overrides existed.
 */
export async function loadActiveLadderEffects(
  supabase: SupabaseClient,
  stayDate: string,
  roomTypeId: string,
  supportsSuppression: boolean = true,
): Promise<AdjustmentSpec[]> {
  let q = supabase
    .from("ladder_rule_state")
    .select("rule_id, action_kind, action_direction, action_value")
    .eq("stay_date", stayDate)
    .eq("room_type_id", roomTypeId)
    .eq("is_active", true);
  // A row suppressed by a manual price override is still active (its
  // condition holds and it must not re-fire on the same trigger) but no
  // longer moves the price. Suppression lifts on the next transition.
  if (supportsSuppression) q = q.is("suppressed_at", null);
  const { data, error } = await q.order("rule_id", { ascending: true });
  // Loud, not empty: a failed read here would otherwise price the whole
  // horizon with no rules and push that to the PMS as a successful run. The
  // one failure we know how to handle, the column not being migrated yet,
  // is caught by the probe before we get here; anything else is an outage.
  if (error) throw new Error(`Failed to load ladder effects: ${error.message}`);

  return (data ?? []).map((r) => ({
    rule_id: String(r.rule_id),
    action_kind: r.action_kind,
    action_direction: r.action_direction,
    action_value: Number(r.action_value),
  }));
}

/**
 * Load all non-retired pickup events for a (stay_date, room_type_id),
 * ordered by applied_at ascending, then id ascending (§10.2).
 */
export async function loadActivePickupEffects(
  supabase: SupabaseClient,
  hotelId: string,
  stayDate: string,
  roomTypeId: string,
): Promise<PickupEffect[]> {
  const { data, error } = await supabase
    .from("pickup_event")
    .select("id, rule_id, applied_at, fire_seq, action_kind, action_direction, action_value")
    .eq("hotel_id", hotelId)
    .eq("stay_date", stayDate)
    .eq("affected_room_type_id", roomTypeId)
    .is("retired_at", null)
    .order("applied_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`Failed to load pickup effects: ${error.message}`);

  return (data ?? []).map(pickupEffectOf);
}

/** A pickup_event row as the effect it applies. */
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickupEffectOf(r: any): PickupEffect {
  return {
    event_id: String(r.id),
    rule_id: String(r.rule_id),
    ...(r.applied_at != null ? { applied_at: String(r.applied_at) } : {}),
    ...(r.fire_seq != null ? { fire_seq: Number(r.fire_seq) } : {}),
    action_kind: r.action_kind,
    action_direction: r.action_direction,
    action_value: Number(r.action_value),
  };
}

/**
 * loadActiveLadderEffects for every cell in a date range at once, keyed
 * `stay_date|room_type_id`. Rows come back ordered by cell and then rule_id,
 * the per-cell order, and are grouped without re-sorting: Postgres orders
 * uuids by their bytes, which a JavaScript string sort would not reproduce.
 */
export async function loadActiveLadderEffectsForRange(
  supabase: SupabaseClient,
  roomTypeIds: string[],
  firstDate: string,
  lastDate: string,
  supportsSuppression: boolean = true,
): Promise<Map<string, AdjustmentSpec[]>> {
  const out = new Map<string, AdjustmentSpec[]>();
  if (roomTypeIds.length === 0) return out;
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    rows = await fetchAllRows(() => {
      let q = supabase
        .from("ladder_rule_state")
        .select("rule_id, stay_date, room_type_id, action_kind, action_direction, action_value")
        .in("room_type_id", roomTypeIds)
        .gte("stay_date", firstDate)
        .lte("stay_date", lastDate)
        .eq("is_active", true);
      if (supportsSuppression) q = q.is("suppressed_at", null);
      return q
        .order("stay_date", { ascending: true })
        .order("room_type_id", { ascending: true })
        .order("rule_id", { ascending: true });
    });
  } catch (e) {
    // Loud, not empty — see loadActiveLadderEffects.
    throw new Error(`Failed to load ladder effects: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const r of rows) {
    const key = `${r.stay_date}|${r.room_type_id}`;
    const list = out.get(key) ?? [];
    list.push({
      rule_id: String(r.rule_id),
      action_kind: r.action_kind,
      action_direction: r.action_direction,
      action_value: Number(r.action_value),
    });
    out.set(key, list);
  }
  return out;
}

/** loadActivePickupEffects for every cell in a date range at once, keyed `stay_date|room_type_id`. */
export async function loadActivePickupEffectsForRange(
  supabase: SupabaseClient,
  hotelId: string,
  roomTypeIds: string[],
  firstDate: string,
  lastDate: string,
): Promise<Map<string, PickupEffect[]>> {
  const out = new Map<string, PickupEffect[]>();
  if (roomTypeIds.length === 0) return out;
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  try {
    rows = await fetchAllRows(() =>
      supabase
        .from("pickup_event")
        .select("id, rule_id, stay_date, affected_room_type_id, applied_at, fire_seq, action_kind, action_direction, action_value")
        .eq("hotel_id", hotelId)
        .in("affected_room_type_id", roomTypeIds)
        .gte("stay_date", firstDate)
        .lte("stay_date", lastDate)
        .is("retired_at", null)
        .order("stay_date", { ascending: true })
        .order("affected_room_type_id", { ascending: true })
        .order("applied_at", { ascending: true })
        .order("id", { ascending: true }),
    );
  } catch (e) {
    throw new Error(`Failed to load pickup effects: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const r of rows) {
    const key = `${r.stay_date}|${r.affected_room_type_id}`;
    const list = out.get(key) ?? [];
    list.push(pickupEffectOf(r));
    out.set(key, list);
  }
  return out;
}

/**
 * Assemble the final price for a single (stay_date, room_type).
 */
export async function assemblePrice(
  supabase: SupabaseClient,
  hotelId: string,
  stayDate: string,
  roomType: RoomTypeRow,
  basePrice: number,
  baseSource: BaseSource,
  supportsSuppression: boolean = true,
): Promise<AssembledPrice> {
  const ladderEffects = await loadActiveLadderEffects(
    supabase,
    stayDate,
    roomType.id,
    supportsSuppression,
  );
  const pickupEffects = await loadActivePickupEffects(supabase, hotelId, stayDate, roomType.id);
  return assemblePriceFrom(stayDate, roomType, basePrice, baseSource, ladderEffects, pickupEffects);
}

/** assemblePrice once the cell's effects are in hand. */
export function assemblePriceFrom(
  stayDate: string,
  roomType: RoomTypeRow,
  basePrice: number,
  baseSource: BaseSource,
  ladderEffects: AdjustmentSpec[],
  pickupEffects: PickupEffect[],
): AssembledPrice {
  const preClamp = applyAdjustments(basePrice, ladderEffects, pickupEffects);
  const bounds = priceBounds(roomType.floor_price, roomType.ceiling_price, basePrice, baseSource);
  const { final, clamped_by } = clampPrice(preClamp, bounds.floor, bounds.ceiling);

  return {
    stay_date: stayDate,
    room_type_id: roomType.id,
    base_price: basePrice,
    base_source: baseSource,
    floor_price: roomType.floor_price,
    ceiling_price: roomType.ceiling_price,
    ladder_effects: ladderEffects,
    pickup_effects: pickupEffects,
    pre_clamp_price: preClamp,
    final_price: final,
    clamped_by,
  };
}

/**
 * §11 step 10: Publish diffs — update published_price only if changed.
 */
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

  const decision = publishDecision(current, finalPrice, basePrice);
  if (!decision.write) {
    return false;
  }

  const { error } = await supabase
    .from("published_price")
    .upsert(publishRow(hotelId, stayDate, roomTypeId, finalPrice, computedAt, basePrice), {
      onConflict: "hotel_id,stay_date,room_type_id",
    });
  if (error) {
    // A failed write must not report as a successful publish. Every caller
    // of maybePublish treats a `true` return as "the new price is now live":
    // pricesPublished increments and the audit row for this cell is written
    // as though it happened. Left unchecked, a transient error (or an RLS
    // rejection when this runs under a non-manager's session) leaves the
    // OLD price in published_price while the run reports the change as
    // done — and the PMS rate-push, which reads published_price, never
    // sends the new rate.
    console.error(
      JSON.stringify({ fn: "maybePublish", hotelId, stayDate, roomTypeId, error: error.message }),
    );
    return false;
  }

  // Only a real price move counts as a publish — a base-only correction is
  // bookkeeping and should not read as a rate change in the change log.
  return decision.priceChanged;
}

/** Whether a cell needs a write, and whether that write moves the price. */
export function publishDecision(
  current: { price: unknown; base_price: unknown } | null | undefined,
  finalPrice: number,
  basePrice?: number,
): { write: boolean; priceChanged: boolean } {
  const priceUnchanged = current != null && Number(current.price) === finalPrice;
  // The remembered base has to be written even on a run that does not move
  // the price, or a cell whose price is stable never records one — and it is
  // exactly those quiet cells that later lose their last reservation.
  const baseUnchanged =
    basePrice === undefined ||
    (current != null &&
      current.base_price != null &&
      Number(current.base_price) === basePrice);
  return { write: !(priceUnchanged && baseUnchanged), priceChanged: !priceUnchanged };
}

function publishRow(
  hotelId: string,
  stayDate: string,
  roomTypeId: string,
  finalPrice: number,
  computedAt: string,
  basePrice?: number,
) {
  return {
    hotel_id: hotelId,
    stay_date: stayDate,
    room_type_id: roomTypeId,
    price: finalPrice,
    ...(basePrice !== undefined ? { base_price: basePrice } : {}),
    computed_at: computedAt,
  };
}

export type PublishCell = { stayDate: string; roomTypeId: string; finalPrice: number; basePrice: number };

const PUBLISH_CHUNK = 500;

/**
 * maybePublish for a whole run: one paged read of what is published now,
 * the same decision per cell, and the writes upserted in chunks. A chunk
 * that fails is retried row by row, so only the row that really failed is
 * logged and left unpublished, exactly as the per-cell path did.
 *
 * Returns the `stay_date|room_type_id` keys whose price actually moved.
 * If the current prices cannot be read at all, it publishes cell by cell.
 */
export async function publishPrices(
  supabase: SupabaseClient,
  hotelId: string,
  cells: PublishCell[],
  computedAt: string,
): Promise<Set<string>> {
  const published = new Set<string>();
  if (cells.length === 0) return published;
  const dates = cells.map((c) => c.stayDate).sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];

  const current = new Map<string, { price: unknown; base_price: unknown }>();
  try {
    const rows = await fetchAllRows(() =>
      supabase
        .from("published_price")
        .select("stay_date, room_type_id, price, base_price")
        .eq("hotel_id", hotelId)
        .gte("stay_date", firstDate)
        .lte("stay_date", lastDate)
        .order("stay_date", { ascending: true })
        .order("room_type_id", { ascending: true }),
    );
    for (const r of rows) current.set(`${r.stay_date}|${r.room_type_id}`, r);
  } catch {
    for (const c of cells) {
      if (await maybePublish(supabase, hotelId, c.stayDate, c.roomTypeId, c.finalPrice, computedAt, c.basePrice)) {
        published.add(`${c.stayDate}|${c.roomTypeId}`);
      }
    }
    return published;
  }

  const writes: { cell: PublishCell; priceChanged: boolean }[] = [];
  for (const cell of cells) {
    const decision = publishDecision(current.get(`${cell.stayDate}|${cell.roomTypeId}`), cell.finalPrice, cell.basePrice);
    if (decision.write) writes.push({ cell, priceChanged: decision.priceChanged });
  }

  const upsert = (list: { cell: PublishCell }[]) =>
    supabase.from("published_price").upsert(
      list.map(({ cell }) => publishRow(hotelId, cell.stayDate, cell.roomTypeId, cell.finalPrice, computedAt, cell.basePrice)),
      { onConflict: "hotel_id,stay_date,room_type_id" },
    );

  for (let i = 0; i < writes.length; i += PUBLISH_CHUNK) {
    const chunk = writes.slice(i, i + PUBLISH_CHUNK);
    const { error } = await upsert(chunk);
    const failed = new Set<(typeof chunk)[number]>();
    if (error && chunk.length > 1) {
      for (const w of chunk) {
        const { error: rowError } = await upsert([w]);
        if (rowError) {
          failed.add(w);
          logPublishError(hotelId, w.cell, rowError.message);
        }
      }
    } else if (error) {
      failed.add(chunk[0]);
      logPublishError(hotelId, chunk[0].cell, error.message);
    }
    for (const w of chunk) {
      if (w.priceChanged && !failed.has(w)) published.add(`${w.cell.stayDate}|${w.cell.roomTypeId}`);
    }
  }
  return published;
}

/**
 * Remove the published price of cells this run left unpriced (keys
 * `stay_date|room_type_id`), so nothing shows or goes out as MAYA's price for
 * a night MAYA no longer prices: the calendar shows no current price, and the
 * push has no row to send. Only called for cells that have a row.
 *
 * Except a night MAYA has sent a rate to (its rate_updates row is anything
 * but a skip with attempts 0; see push-guardrails.ts). That rate is still in
 * the PMS whatever MAYA publishes, and removing the row hid it: the dashboard
 * showed nothing and the push never looked at the night again. Kept, the row
 * shows the rate that is there, and the push holds the night and files it
 * (guardrail:zero_base) so admins can see it. A ledger that can't be read
 * keeps every row this run, for the same reason. Not a sent row at 0: the
 * base rate refresh found the hotel closed that night in the PMS
 * (pms-edits.ts), so MAYA's rate is not there any more.
 *
 * Never throws: the prices this run did publish stand either way. A row that
 * could not be removed is logged; the push holds back a closed night on its
 * own check (guardrail:zero_base). Under a signed-in session this matches no
 * rows (published_price has no delete policy), and the next scheduled run,
 * which uses the service role, removes it.
 */
export async function clearUnpricedCells(
  supabase: SupabaseClient,
  hotelId: string,
  keys: string[],
): Promise<void> {
  const byRoomType = new Map<string, string[]>();
  for (const key of keys) {
    const [stayDate, roomTypeId] = key.split("|");
    const list = byRoomType.get(roomTypeId) ?? [];
    list.push(stayDate);
    byRoomType.set(roomTypeId, list);
  }
  for (const [roomTypeId, dates] of byRoomType) {
    for (let i = 0; i < dates.length; i += PUBLISH_CHUNK) {
      const chunk = dates.slice(i, i + PUBLISH_CHUNK);
      const { data: sentTo, error: ledgerError } = await supabase
        .from("rate_updates")
        .select("stay_date, status, attempts, price")
        .eq("hotel_id", hotelId)
        .eq("room_type_id", roomTypeId)
        .in("stay_date", chunk);
      if (ledgerError) {
        console.error(
          JSON.stringify({ fn: "clearUnpricedCells", hotelId, roomTypeId, nights: chunk.length, step: "ledger", error: ledgerError.message }),
        );
        continue;
      }
      const keep = new Set(
        ((sentTo ?? []) as { stay_date: unknown; status: unknown; attempts: unknown; price: unknown }[])
          .filter((r) => !(r.status === "skipped" && r.attempts != null && Number(r.attempts) === 0))
          .filter((r) => !(r.status === "sent" && r.price != null && Number(r.price) === 0))
          .map((r) => String(r.stay_date).slice(0, 10)),
      );
      const clear = chunk.filter((d) => !keep.has(d));
      if (clear.length === 0) continue;
      const { error } = await supabase
        .from("published_price")
        .delete()
        .eq("hotel_id", hotelId)
        .eq("room_type_id", roomTypeId)
        .in("stay_date", clear);
      if (error) {
        console.error(
          JSON.stringify({ fn: "clearUnpricedCells", hotelId, roomTypeId, nights: clear.length, error: error.message }),
        );
      }
    }
  }
}

function logPublishError(hotelId: string, cell: PublishCell, message: string): void {
  // Same line maybePublish writes: a failed write never reports as published.
  console.error(
    JSON.stringify({ fn: "maybePublish", hotelId, stayDate: cell.stayDate, roomTypeId: cell.roomTypeId, error: message }),
  );
}
