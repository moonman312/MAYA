/**
 * Which nights a scheduled tick prices, captures a base for, and pushes.
 *
 * One window, three users: evaluation, the base rate calendar and the push
 * all take their length from here, and their first night from the hotel's
 * own calendar, never the UTC date. For a property west of Greenwich the UTC
 * date is tomorrow every evening, which dropped tonight from the push while
 * the engine was still pricing it. The tick used to evaluate 45 nights while
 * pushing 60, and nights 46 to 60 went out at whatever price an older, longer
 * run had left, with no captured base under them.
 *
 * Window = [hotel today, hotel today + horizon - 1], both ends inclusive:
 * 396 nights, tonight and the next 395 (Jake, 2026-09-17 and 2026-09-28).
 * The daily pass prices all of it once a hotel day, the touched nights in
 * between (pricing-plan.ts). MAYA_PRICING_HORIZON_DAYS dials it back without
 * a deploy.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mwsEnv } from "../mews/env.ts";
import { addCalendarDays, evalIsoToHotelDateString } from "../engine/timezone.ts";

export const DEFAULT_PRICING_HORIZON_DAYS = 396;
/** evaluateHotel caps its horizon here, so nothing else may reach further. */
export const MAX_PRICING_HORIZON_DAYS = 400;
/**
 * How far forward the reservation reads reach by default
 * (MAYA_SYNC_DAYS_FORWARD in the Cloudbeds, ThinkReservations and Mews
 * syncs), in UTC days from now: at least the pricing window for a hotel in
 * any time zone.
 */
export const DEFAULT_SYNC_DAYS_FORWARD = 396;
/** The furthest a reservation read may be set to reach (Cloudbeds and ThinkReservations; Mews stops at 396). */
export const MAX_SYNC_DAYS_FORWARD = 730;

/** Days forward the reservation reads cover, from MAYA_SYNC_DAYS_FORWARD. */
export function syncDaysForward(raw: string | undefined = mwsEnv("MAYA_SYNC_DAYS_FORWARD")): number {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Math.min(MAX_SYNC_DAYS_FORWARD, Number.isFinite(n) && n > 0 ? n : DEFAULT_SYNC_DAYS_FORWARD);
}

let loggedClamp = "";

/**
 * Nights per window, from MAYA_PRICING_HORIZON_DAYS; 396 when unset or
 * unusable, never past MAX_PRICING_HORIZON_DAYS. Never past the reservation
 * reads either (`readForwardDays`, syncDaysForward by default): a night past
 * them would be priced on a book with none of its bookings in it. That clamp
 * is logged once.
 *
 * The old name, MAYA_EVAL_HORIZON_DAYS, is ignored on purpose: production
 * secrets still hold a 30 from July testing, and reading it would shrink the
 * window.
 */
export function pricingHorizonDays(
  raw: string | undefined = mwsEnv("MAYA_PRICING_HORIZON_DAYS"),
  readForwardDays: number = syncDaysForward(),
): number {
  const n = Math.floor(Number(raw));
  const asked = !Number.isFinite(n) || n < 1 ? DEFAULT_PRICING_HORIZON_DAYS : Math.min(MAX_PRICING_HORIZON_DAYS, n);
  const reach = Math.max(1, Math.floor(readForwardDays));
  if (asked <= reach) return asked;
  const line = `${asked}>${reach}`;
  if (loggedClamp !== line) {
    loggedClamp = line;
    console.error(
      JSON.stringify({
        fn: "pricingHorizonDays",
        horizonDays: asked,
        syncDaysForward: reach,
        message: `The pricing window (${asked} nights) reaches past the reservation reads (${reach} days); pricing ${reach} nights. Raise MAYA_SYNC_DAYS_FORWARD or lower MAYA_PRICING_HORIZON_DAYS.`,
      }),
    );
  }
  return reach;
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
