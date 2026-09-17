/**
 * Setting a manual price: the reset point a person's number makes on a cell.
 *
 * Shared by /api/manual-price (a price typed in MAYA) and the base rate
 * refresh (a price changed in the PMS on a night MAYA had sent; see
 * base-rate-calendar.ts), so a change made in either place does exactly the
 * same to the cell:
 *
 *   - its manual_price row is written open (cleared_at null), saying where it
 *     came from: source 'maya' with the person who typed it, or source 'pms'
 *     with the PMS and no user;
 *   - every active ladder effect on the cell is suppressed (suppressed_at).
 *     The row stays active, so the rule does not fire again on the trigger
 *     the price already answered, and stops contributing until its next
 *     transition;
 *   - every open pickup event on the cell is retired.
 *
 * The engine does the rest from the row: the manual price outranks every
 * other base, a rule that fires later stacks on it, and the pickup baseline
 * is floored at set_at (pickup.ts). That is why `now` is also the instant the
 * evaluation that follows prices at: the route's republish after a save, the
 * tick's clock for a PMS change.
 *
 * A PMS change is written in one transaction (set_manual_prices_from_pms).
 * Nobody is there to see a half-done one: with the rows written and the
 * effects not yet suppressed, the tick's evaluation publishes the hotel's
 * rate plus those effects and the push sends it over the hotel's own. A price
 * typed in MAYA is written in steps, and a failed step fails the save, which
 * the person sees and makes again.
 *
 * Clearing is the route's DELETE, the same whichever source set the price.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "../engine/snapshots.ts";

export type ManualPriceCell = { roomTypeId: string; stayDate: string; price: number };

export type ManualPriceOrigin =
  | { source: "maya"; setBy: string; note: string | null }
  | { source: "pms"; pmsType: string };

export type ManualPriceResult = {
  /** Rows written. */
  cells: number;
  /** Active ladder effects this suppressed. */
  suppressedRules: number;
  /** Open pickup events this retired. */
  retiredPickups: number;
};

const CHUNK = 500;

/** ladder_rule_state carries no hotel_id; the hotel's rules are the join. */
export async function hotelRuleIds(supabase: SupabaseClient, hotelId: string): Promise<string[]> {
  const { data, error } = await supabase.from("pricing_rules").select("id").eq("hotel_id", hotelId);
  if (error) throw error;
  return (data ?? []).map((r: { id: unknown }) => String(r.id));
}

/**
 * Consecutive nights of one room type, as [first, last] pairs, so a season
 * set in one go is one ranged write instead of one per night.
 */
export function nightRuns(cells: ManualPriceCell[]): { roomTypeId: string; from: string; to: string }[] {
  const byRoomType = new Map<string, string[]>();
  for (const c of cells) {
    const list = byRoomType.get(c.roomTypeId) ?? [];
    list.push(c.stayDate);
    byRoomType.set(c.roomTypeId, list);
  }
  const runs: { roomTypeId: string; from: string; to: string }[] = [];
  for (const [roomTypeId, dates] of byRoomType) {
    const sorted = [...new Set(dates)].sort();
    let from = sorted[0];
    let to = sorted[0];
    for (const d of sorted.slice(1)) {
      if (d === nextDay(to)) {
        to = d;
        continue;
      }
      runs.push({ roomTypeId, from, to });
      from = d;
      to = d;
    }
    if (from) runs.push({ roomTypeId, from, to });
  }
  return runs;
}

/**
 * Write manual prices and reset their cells. Throws the database's own error
 * on a failed write, so the caller can tell a missing table from an outage.
 * Rows go first: an effect suppressed with no manual price under it would
 * leave MAYA pricing the night without that rule.
 *
 * Before the migration that records where a price came from, a price typed
 * in MAYA is written without it; one from the PMS is not written at all.
 */
export async function setManualPrices(
  supabase: SupabaseClient,
  hotelId: string,
  cells: ManualPriceCell[],
  origin: ManualPriceOrigin,
  now: string,
): Promise<ManualPriceResult> {
  if (cells.length === 0) return { cells: 0, suppressedRules: 0, retiredPickups: 0 };
  if (origin.source === "pms") return setFromPms(supabase, hotelId, cells, origin.pmsType, now);

  const rows = cells.map((c) => ({
    hotel_id: hotelId,
    room_type_id: c.roomTypeId,
    stay_date: c.stayDate,
    price: c.price,
    note: origin.note,
    set_by: origin.setBy,
    set_at: now,
    cleared_at: null,
    cleared_by: null,
    source: origin.source,
    pms_type: null,
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const write = (payload: Record<string, unknown>[]) =>
      supabase.from("manual_price").upsert(payload, { onConflict: "hotel_id,stay_date,room_type_id" });
    let { error } = await write(chunk);
    if (error && isMissingColumnError(error)) {
      const withoutSource = chunk.map((r) => {
        const copy: Record<string, unknown> = { ...r };
        delete copy.source;
        delete copy.pms_type;
        return copy;
      });
      ({ error } = await write(withoutSource));
    }
    if (error) throw error;
  }

  // Suppress what had already fired on these cells. Active ladder rows stay
  // is_active (the condition still holds and the rule must not re-fire on
  // the same trigger) but stop contributing until their next transition.
  const runs = nightRuns(cells);
  let suppressedRules = 0;
  const ruleIds = await hotelRuleIds(supabase, hotelId);
  if (ruleIds.length > 0) {
    for (const run of runs) {
      const { data, error } = await supabase
        .from("ladder_rule_state")
        .update({ suppressed_at: now })
        .in("rule_id", ruleIds)
        .eq("room_type_id", run.roomTypeId)
        .gte("stay_date", run.from)
        .lte("stay_date", run.to)
        .eq("is_active", true)
        .is("suppressed_at", null)
        .select("rule_id");
      if (error) throw error;
      suppressedRules += (data ?? []).length;
    }
  }

  let retiredPickups = 0;
  for (const run of runs) {
    const { data, error } = await supabase
      .from("pickup_event")
      .update({ retired_at: now })
      .eq("hotel_id", hotelId)
      .eq("affected_room_type_id", run.roomTypeId)
      .gte("stay_date", run.from)
      .lte("stay_date", run.to)
      .is("retired_at", null)
      .select("id");
    if (error) throw error;
    retiredPickups += (data ?? []).length;
  }

  return { cells: rows.length, suppressedRules, retiredPickups };
}

/**
 * A PMS change's rows and reset, in one transaction per chunk: a chunk that
 * fails leaves its cells as they were, and the next refresh takes them again.
 */
async function setFromPms(
  supabase: SupabaseClient,
  hotelId: string,
  cells: ManualPriceCell[],
  pmsType: string,
  now: string,
): Promise<ManualPriceResult> {
  const out: ManualPriceResult = { cells: 0, suppressedRules: 0, retiredPickups: 0 };
  for (let i = 0; i < cells.length; i += CHUNK) {
    const { data, error } = await supabase.rpc("set_manual_prices_from_pms", {
      p_hotel_id: hotelId,
      p_pms_type: pmsType,
      p_set_at: now,
      p_cells: cells.slice(i, i + CHUNK).map((c) => ({ room_type_id: c.roomTypeId, stay_date: c.stayDate, price: c.price })),
    });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    out.cells += Number(row?.cells ?? 0);
    out.suppressedRules += Number(row?.suppressed_rules ?? 0);
    out.retiredPickups += Number(row?.retired_pickups ?? 0);
  }
  return out;
}

/** YYYY-MM-DD + 1 day, via UTC so no local-timezone drift. */
function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
