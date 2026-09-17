/**
 * Which nights a scheduled tick prices, captures a base for, and pushes.
 *
 * One window, three users. The support page promises rates go out for stay
 * dates up to 60 days ahead, and the tick used to evaluate 45 while pushing
 * 60: nights 46 to 60 went out at whatever price an older, longer run had
 * left in published_price, with no captured base under them. So evaluation,
 * the base rate calendar and the push all take their length from here, and
 * their first night from the hotel's own calendar, never the UTC date. For a
 * property west of Greenwich the UTC date is tomorrow every evening, which
 * dropped tonight from the push while the engine was still pricing it.
 *
 * Window = [hotel today, hotel today + horizon - 1], both ends inclusive.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mwsEnv } from "../mews/env.ts";
import { addCalendarDays, evalIsoToHotelDateString } from "../engine/timezone.ts";

export const DEFAULT_PRICING_HORIZON_DAYS = 60;
/** evaluateHotel caps its horizon here, so nothing else may reach further. */
export const MAX_PRICING_HORIZON_DAYS = 365;

/** Nights per tick, from MAYA_EVAL_HORIZON_DAYS; 60 when unset or unusable. */
export function pricingHorizonDays(raw: string | undefined = mwsEnv("MAYA_EVAL_HORIZON_DAYS")): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PRICING_HORIZON_DAYS;
  return Math.min(MAX_PRICING_HORIZON_DAYS, n);
}

/** The last night of a window that starts on `today`. */
export function lastNightOf(today: string, horizonDays: number): string {
  return addCalendarDays(today, Math.max(1, Math.floor(horizonDays)) - 1);
}

/** One instant and the date it falls on at the property. */
export type HotelClock = {
  /** ISO instant the tick prices at (evaluateHotel's evalTs). */
  at: string;
  /** YYYY-MM-DD at the property at `at`. */
  today: string;
  timeZone: string;
};

/**
 * The hotel's calendar date at `at`, derived exactly as evaluateHotel derives
 * its own: hotels.timezone, "UTC" when the row or the value is null, and the
 * same formatter. A failed read throws rather than quietly using UTC,
 * which is the bug this exists to remove; so does a timezone Intl rejects,
 * as it does in the engine.
 */
export async function readHotelClock(
  supabase: SupabaseClient,
  hotelId: string,
  at: string = new Date().toISOString(),
): Promise<HotelClock> {
  const { data, error } = await supabase.from("hotels").select("timezone").eq("id", hotelId).maybeSingle();
  if (error) throw new Error(`Failed to read hotel timezone: ${error.message}`);
  const timeZone = String(data?.timezone ?? "UTC");
  return { at, today: evalIsoToHotelDateString(at, timeZone), timeZone };
}
