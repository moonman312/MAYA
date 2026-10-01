/**
 * The count the go-live confirm shows: nights whose own rate in the PMS sits
 * outside a room type's floor or ceiling (Jake, 2026-09-30, audit A21). See
 * limits.ts for the rest of how floors and ceilings are reviewed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { addCalendarDays } from "@/lib/engine/timezone";
import { fetchAllRows, isMissingColumnError, isMissingRelationError, loadRatesReturnedThrough } from "@/lib/engine/snapshots";
import { hotelToday } from "@/lib/simulator";
import {
  pushSendsForRoomType,
  readRoomTypesNamedByRules,
} from "../../../supabase/functions/_shared/pms/push-guardrails";

type LimitRow = { id: string; floor: number; ceiling: number; countsAsRoom: boolean | null };

/**
 * How many nights in the pricing window (the hotel's today and the
 * `horizonDays` - 1 nights after it) have, on at least one active room type,
 * the property's own rate outside that room type's floor or ceiling: below
 * the floor or above the ceiling. Those are the nights going live sends at
 * the limit with no rule behind it (engine/pricing.ts priceBounds).
 *
 * The rate is the one the engine prices on (engine/base-price.ts): the
 * base_rate_calendar row, as far as the last read returned rates
 * (loadRatesReturnedThrough), and not one the PMS removed. A night at 0 is
 * not priced, and a night with a typed price is sent as typed, so neither
 * counts. Nor does a type unticked as a room that no rule names under
 * "Change": the push sends nothing for it (pushSendsForRoomType, the same
 * test the push makes). Read under the caller's session, so row security
 * decides what it may see. Null when the calendar is not in the database yet.
 */
export async function nightsWithRateOutsideLimits(
  supabase: SupabaseClient,
  hotelId: string,
  horizonDays: number,
  now: Date = new Date(),
): Promise<number | null> {
  const readTypes = (columns: string) =>
    supabase.from("room_types").select(columns).eq("hotel_id", hotelId).eq("is_active", true);
  const [{ data: hotel, error: hotelErr }, first] = await Promise.all([
    supabase.from("hotels").select("timezone").eq("id", hotelId).maybeSingle(),
    readTypes("id, floor_price, ceiling_price, counts_as_room"),
  ]);
  if (hotelErr) throw new Error(`hotel read failed: ${hotelErr.message}`);
  // Before the counts_as_room migration every type counts as a room, as it does for the push.
  let typesRead: { data: unknown; error: { message: string } | null } = first;
  if (first.error && isMissingColumnError(first.error)) typesRead = await readTypes("id, floor_price, ceiling_price");
  if (typesRead.error) throw new Error(`room types read failed: ${typesRead.error.message}`);
  const types = typesRead.data;
  let limits: LimitRow[] = ((types ?? []) as Array<Record<string, unknown>>)
    .map((t) => ({
      id: String(t.id),
      floor: Number(t.floor_price),
      ceiling: Number(t.ceiling_price),
      countsAsRoom: typeof t.counts_as_room === "boolean" ? t.counts_as_room : null,
    }))
    .filter((t) => Number.isFinite(t.floor) && Number.isFinite(t.ceiling));
  // A type unticked as a room is sent only when a rule names it, so only then
  // does going live move its rate inside its limits.
  if (limits.some((t) => t.countsAsRoom === false)) {
    const named = await readRoomTypesNamedByRules(supabase, hotelId);
    limits = limits.filter((t) => pushSendsForRoomType({ countsAsRoom: t.countsAsRoom, namedByRule: named.has(t.id) }));
  }
  if (limits.length === 0) return 0;

  const tz = String((hotel as { timezone?: unknown } | null)?.timezone ?? "UTC") || "UTC";
  const from = hotelToday(tz, now);
  const days = Math.max(1, Math.floor(horizonDays));
  const through = await loadRatesReturnedThrough(supabase, hotelId);
  const windowEnd = addCalendarDays(from, days - 1);
  const to = through != null && through < windowEnd ? through : windowEnd;
  if (to < from) return 0;

  // Each room type's rows outside its own pair, read on the server side of
  // the comparison: the rest never leave the database.
  const outside = new Set<string>();
  try {
    await Promise.all(
      limits.map(async (rt) => {
        const read = (columns: string) =>
          fetchAllRows(() =>
            supabase
              .from("base_rate_calendar")
              .select(columns)
              .eq("hotel_id", hotelId)
              .eq("room_type_id", rt.id)
              .gte("stay_date", from)
              .lte("stay_date", to)
              .gt("price", 0)
              .or(`price.lt.${rt.floor},price.gt.${rt.ceiling}`)
              .order("stay_date", { ascending: true }),
          );
        let rows: Array<Record<string, unknown>>;
        try {
          rows = await read("stay_date, pms_removed_at");
        } catch (e) {
          if (!isMissingColumnError(e)) throw e;
          rows = await read("stay_date");
        }
        for (const r of rows) {
          if (r.pms_removed_at != null) continue;
          outside.add(`${String(r.stay_date)}|${rt.id}`);
        }
      }),
    );
  } catch (e) {
    if (isMissingRelationError(e)) return null;
    throw e;
  }
  if (outside.size === 0) return 0;

  // A typed price (or one changed in the PMS on a night MAYA sent to) goes
  // out as it is, outside the limits or not.
  try {
    const typed = await fetchAllRows(() =>
      supabase
        .from("manual_price")
        .select("stay_date, room_type_id")
        .eq("hotel_id", hotelId)
        .gte("stay_date", from)
        .lte("stay_date", to)
        .is("cleared_at", null)
        .order("stay_date", { ascending: true }),
    );
    for (const m of typed as Array<Record<string, unknown>>) outside.delete(`${String(m.stay_date)}|${String(m.room_type_id)}`);
  } catch (e) {
    if (!isMissingRelationError(e)) throw e;
  }

  return new Set([...outside].map((key) => key.slice(0, 10))).size;
}
