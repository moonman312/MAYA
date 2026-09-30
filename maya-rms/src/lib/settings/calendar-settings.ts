/**
 * The property's calendar choices on hotel_settings: read with the calendar
 * (one query beside the month's others) and saved from Settings.
 *
 * Both go through the caller's own client, so row level security decides:
 * anyone on the property reads them, and only can_manage_hotel() may save
 * (Revenue Manager and up, a platform admin only in God Mode, whose save the
 * database puts on the change log itself).
 */

import {
  DEFAULT_CALENDAR_DISPLAY,
  displayFromRow,
  displayToRow,
  usesPrice,
  type CalendarDisplay,
} from "@/lib/calendar-display";
import { isMissingColumnError } from "@/lib/engine/snapshots";
import type { SupabaseClient } from "@supabase/supabase-js";

export const CALENDAR_DISPLAY_COLUMNS =
  "calendar_big_metric, calendar_small_metric_1, calendar_small_metric_2, calendar_price_room_type_id, calendar_colors";

let loggedPreMigration = false;

function logPreMigrationOnce(hotelId: string, error: string): void {
  if (loggedPreMigration) return;
  loggedPreMigration = true;
  console.warn(
    JSON.stringify({
      fn: "calendar-settings",
      step: "pre-migration",
      hotelId,
      message: "hotel_settings.calendar_* is missing. Showing the default calendar. Run 99_supabase_migration_display_settings_v1.sql.",
      error,
    }),
  );
}

/** A fresh copy of the default, so no caller can change the shared one. */
function defaults(): CalendarDisplay {
  return { ...DEFAULT_CALENDAR_DISPLAY, small: [...DEFAULT_CALENDAR_DISPLAY.small] };
}

/**
 * The property's calendar choices. Never throws: a database before the
 * migration, a missing row or a failed read all show the default calendar,
 * which is the calendar as it always was.
 */
export async function readCalendarDisplay(supabase: SupabaseClient, hotelId: string): Promise<CalendarDisplay> {
  try {
    const { data, error } = await supabase
      .from("hotel_settings")
      .select(CALENDAR_DISPLAY_COLUMNS)
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (error) {
      if (isMissingColumnError(error)) logPreMigrationOnce(hotelId, error.message);
      else console.error(JSON.stringify({ fn: "calendar-settings", step: "read", hotelId, error: error.message, degradedToDefault: true }));
      return defaults();
    }
    return displayFromRow(data as Record<string, unknown> | null);
  } catch (e) {
    console.error(
      JSON.stringify({ fn: "calendar-settings", step: "read", hotelId, error: e instanceof Error ? e.message : String(e), degradedToDefault: true }),
    );
    return defaults();
  }
}

export type SaveCalendarResult =
  | { ok: true; display: CalendarDisplay }
  | { ok: false; reason: "room_type" | "no_row" | "pre_migration" | "refused" | "failed"; message: string };

/**
 * Saves the display on the property's settings row. The room type a price
 * comes from must be one of the property's active room types when a price
 * shows; when none does, a remembered room type is kept only if it is the
 * property's own. Never inserts a row: every property has one from the day
 * it connected, and a new one would start with defaults nobody chose.
 */
export async function saveCalendarDisplay(
  supabase: SupabaseClient,
  hotelId: string,
  display: CalendarDisplay,
): Promise<SaveCalendarResult> {
  let next = display;
  if (display.price_room_type_id) {
    let q = supabase.from("room_types").select("id").eq("hotel_id", hotelId).eq("id", display.price_room_type_id);
    if (usesPrice(display)) q = q.eq("is_active", true);
    const { data, error } = await q.maybeSingle();
    if (error) return { ok: false, reason: "failed", message: error.message };
    if (!data) {
      if (usesPrice(display)) return { ok: false, reason: "room_type", message: "Pick a room type from the list." };
      next = { ...display, price_room_type_id: null };
    }
  }

  const { data, error } = await supabase
    .from("hotel_settings")
    .update({ ...displayToRow(next), updated_at: new Date().toISOString() })
    .eq("hotel_id", hotelId)
    .select(CALENDAR_DISPLAY_COLUMNS);
  if (error) {
    if (isMissingColumnError(error)) {
      logPreMigrationOnce(hotelId, error.message);
      return { ok: false, reason: "pre_migration", message: error.message };
    }
    const code = (error as { code?: string }).code;
    if (code === "42501") return { ok: false, reason: "refused", message: error.message };
    return { ok: false, reason: "failed", message: error.message };
  }
  const rows = (data ?? []) as Record<string, unknown>[];
  // Row level security answers a refused update with no rows rather than an
  // error; the route has checked the role first, so this is a missing row.
  if (rows.length === 0) return { ok: false, reason: "no_row", message: "no hotel_settings row" };
  return { ok: true, display: displayFromRow(rows[0]) };
}
