/**
 * What a read of the property system changes about the property itself
 * (99_supabase_migration_pms_property_changes_v1.sql):
 *
 *   - room types it no longer lists are switched off, and come back on when
 *     it lists them again (audit A16);
 *   - the time zone follows the system's, and the currency too while the
 *     property is in simulation. A live property's currency is never changed:
 *     its floors, ceilings and every price sent are in the one it has, so a
 *     different answer is raised with MAYA staff instead.
 *
 * Each change writes its change log line in the database, in the same
 * transaction (pms_property_changes). Both calls never throw: a sync that
 * fails over a room type list or a time zone is a far worse outcome than one
 * that tries again tomorrow. Before the migration runs, the functions are not
 * there; that is logged and nothing changes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { raiseAlert } from "./alerting.ts";
import { currencyCode, currencySupported } from "./currencies.ts";

export const PROPERTY_CHANGES_MIGRATION = "99_supabase_migration_pms_property_changes_v1.sql";

type DbError = { code?: string | null; message?: string | null };

function isMissingFunction(error: DbError): boolean {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /could not find the function/i.test(String(error.message ?? ""))
  );
}

function logMissing(fn: string, hotelId: string, what: string): void {
  console.warn(
    JSON.stringify({
      fn,
      hotelId,
      warning: `${what} is not in this database yet. Run ${PROPERTY_CHANGES_MIGRATION}; nothing is changed until then.`,
    }),
  );
}

export type RoomTypeReconcile = {
  /** Names of the types switched off by this read. */
  removed: string[];
  /** Names of the types switched back on. */
  back: string[];
  /** Names of the types left on although none of them was listed. */
  kept: string[];
};

const NOTHING: RoomTypeReconcile = { removed: [], back: [], kept: [] };

/**
 * Before the room types a read returned are written: switch back on any type
 * that read lists again, and, when `mayRemove` (a full read whose list was
 * complete), switch off every active type it does not list. Call it with the
 * external ids exactly as the read returned them.
 */
export async function reconcileListedRoomTypes(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  listed: string[],
  mayRemove: boolean,
): Promise<RoomTypeReconcile> {
  const ids = [...new Set(listed.filter((id) => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return NOTHING;
  try {
    const { data, error } = await supabase.rpc("pms_room_types_reconcile", {
      p_hotel_id: hotelId,
      p_pms_type: pmsType,
      p_listed: ids,
      p_remove: mayRemove,
    });
    if (error) {
      if (isMissingFunction(error)) logMissing("reconcileListedRoomTypes", hotelId, "pms_room_types_reconcile");
      else console.error(JSON.stringify({ fn: "reconcileListedRoomTypes", hotelId, error: error.message }));
      return NOTHING;
    }
    const rows = (Array.isArray(data) ? data : []) as { change?: unknown; room_type_name?: unknown }[];
    const names = (change: string) => rows.filter((r) => r.change === change).map((r) => String(r.room_type_name ?? ""));
    const out: RoomTypeReconcile = { removed: names("removed"), back: names("back"), kept: names("kept") };
    if (out.removed.length > 0 || out.back.length > 0) {
      console.log(
        JSON.stringify({ fn: "reconcileListedRoomTypes", hotelId, pmsType, switchedOff: out.removed, switchedBackOn: out.back }),
      );
    }
    if (out.kept.length > 0) {
      const detail =
        `A full read of the property system listed ${ids.length} room type(s) and none of the ${out.kept.length} ` +
        `MAYA has on: ${out.kept.join(", ")}. Nothing was switched off. Check the connection points at the right ` +
        `property, and switch off by hand any type the property really replaced.`;
      console.error(JSON.stringify({ fn: "reconcileListedRoomTypes", hotelId, pmsType, kept: out.kept, listed: ids.length }));
      await raiseAlert(supabase, {
        severity: "warn",
        key: `room_types_none_listed:${hotelId}`,
        title: "A full read listed none of the property's room types",
        detail,
        hotelId,
      });
    }
    return out;
  } catch (e) {
    console.error(JSON.stringify({ fn: "reconcileListedRoomTypes", hotelId, error: e instanceof Error ? e.message : String(e) }));
    return NOTHING;
  }
}

export type PropertyDetailsRefresh = {
  /** The time zone saved, when it changed. */
  timezone: { from: string | null; to: string } | null;
  /** The currency saved (simulation only), when it changed. */
  currency: { from: string | null; to: string } | null;
  /** A currency the system reports that MAYA did not save, and why. */
  currencyHeld: { from: string | null; to: string; why: "live" | "unsupported" } | null;
};

/**
 * Whether two time zone names are the same zone: both known to the runtime
 * and resolving to one name. "Asia/Kolkata" and "Asia/Calcutta", or
 * "America/Indiana/Indianapolis" and "America/Indianapolis", are one zone
 * under two spellings, and a hotel stored under either must not read as
 * changed when the system reports the other.
 */
export function sameTimeZone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const resolve = (z: string) => new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone;
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
}

/**
 * Save the time zone and currency the property system reports, once a day.
 * A null or empty value is no answer and changes nothing. `timezone` must
 * already be a zone the runtime knows (the client checks); the database
 * checks again. Another name for the zone the hotel already has is no change
 * (sameTimeZone). A currency MAYA does not price in is never saved.
 */
export async function refreshPropertyDetails(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  reported: { timezone: string | null; currency: string | null },
): Promise<PropertyDetailsRefresh> {
  const out: PropertyDetailsRefresh = { timezone: null, currency: null, currencyHeld: null };
  const code = currencyCode(reported.currency);
  const supported = code != null && currencySupported(code);
  let timezone = reported.timezone;
  if (timezone) {
    // The zone the hotel has under another name is no change: no line, no re-price.
    const { data: hotel } = await supabase.from("hotels").select("timezone").eq("id", hotelId).maybeSingle();
    const stored = (hotel as { timezone?: unknown } | null)?.timezone;
    if (typeof stored === "string" && stored !== timezone && sameTimeZone(stored, timezone)) timezone = null;
  }
  if (!timezone && !code) return out;
  try {
    const { data, error } = await supabase.rpc("pms_property_details_refresh", {
      p_hotel_id: hotelId,
      p_pms_type: pmsType,
      p_timezone: timezone,
      p_currency: supported ? code : null,
    });
    if (error) {
      if (isMissingFunction(error)) logMissing("refreshPropertyDetails", hotelId, "pms_property_details_refresh");
      else console.error(JSON.stringify({ fn: "refreshPropertyDetails", hotelId, error: error.message }));
      return out;
    }
    const rows = (Array.isArray(data) ? data : []) as { change?: unknown; before_value?: unknown; after_value?: unknown }[];
    for (const r of rows) {
      const from = r.before_value == null ? null : String(r.before_value);
      const to = String(r.after_value ?? "");
      if (r.change === "timezone") out.timezone = { from, to };
      else if (r.change === "currency") out.currency = { from, to };
      else if (r.change === "currency_kept") out.currencyHeld = { from, to, why: "live" };
    }
    if (out.timezone || out.currency) {
      console.log(JSON.stringify({ fn: "refreshPropertyDetails", hotelId, pmsType, timezone: out.timezone, currency: out.currency }));
    }
  } catch (e) {
    console.error(JSON.stringify({ fn: "refreshPropertyDetails", hotelId, error: e instanceof Error ? e.message : String(e) }));
    return out;
  }

  // A currency MAYA does not price in: never saved, live or not. Whether it
  // differs from the stored one is the database's to say, so this is only
  // raised when the stored currency is known to be another.
  if (code && !supported) {
    const { data: hotel } = await supabase.from("hotels").select("currency").eq("id", hotelId).maybeSingle();
    const stored = currencyCode((hotel as { currency?: unknown } | null)?.currency);
    if (stored !== code) out.currencyHeld = { from: stored, to: code, why: "unsupported" };
  }

  if (out.currencyHeld) {
    const { from, to, why } = out.currencyHeld;
    const detail =
      why === "live"
        ? `The property system now reports ${to}; MAYA prices this live property in ${from ?? "no currency"}. Nothing ` +
          `was changed: its floors, ceilings and every price it sends are in ${from ?? "that currency"}. Check with the ` +
          `owner which is right before changing hotels.currency by hand.`
        : `The property system now reports ${to}, which MAYA does not price in; it stays in ${from ?? "no currency"}.`;
    console.error(JSON.stringify({ fn: "refreshPropertyDetails", hotelId, pmsType, currencyHeld: out.currencyHeld }));
    await raiseAlert(supabase, {
      severity: why === "live" ? "critical" : "warn",
      key: `currency_differs:${hotelId}:${to}`,
      title: "The property system reports a different currency",
      detail,
      hotelId,
    });
  }
  return out;
}
