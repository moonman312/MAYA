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
  applyDisplayPatch,
  displayFromRow,
  displayToRow,
  usesPrice,
  type CalendarDisplay,
  type CalendarDisplayPatch,
  type CalendarDisplayRow,
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
 * The property's calendar choices as saved, or null when they can't be read
 * just now (a failed read). A database before the migration, or a property
 * with no settings row, reads as the default: that is what it has. Settings
 * uses this, so a failed read is never shown as choices someone could save
 * over the property's own.
 */
export async function loadCalendarDisplay(supabase: SupabaseClient, hotelId: string): Promise<CalendarDisplay | null> {
  try {
    const { data, error } = await supabase
      .from("hotel_settings")
      .select(CALENDAR_DISPLAY_COLUMNS)
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (error) {
      if (isMissingColumnError(error)) {
        logPreMigrationOnce(hotelId, error.message);
        return defaults();
      }
      console.error(JSON.stringify({ fn: "calendar-settings", step: "read", hotelId, error: error.message }));
      return null;
    }
    return displayFromRow(data as Record<string, unknown> | null);
  } catch (e) {
    console.error(JSON.stringify({ fn: "calendar-settings", step: "read", hotelId, error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

/**
 * The property's calendar choices for drawing the calendar. Never throws: a
 * failed read draws the default calendar, which is the calendar as it
 * always was, rather than no calendar at all.
 */
export async function readCalendarDisplay(supabase: SupabaseClient, hotelId: string): Promise<CalendarDisplay> {
  return (await loadCalendarDisplay(supabase, hotelId)) ?? defaults();
}

export type SaveCalendarResult =
  | { ok: true; display: CalendarDisplay }
  | { ok: false; reason: "room_type" | "no_row" | "pre_migration" | "refused" | "failed"; message: string };

const LAYOUT_COLUMNS = ["calendar_big_metric", "calendar_small_metric_1", "calendar_small_metric_2"] as const;

function saveError(hotelId: string, error: { message: string; code?: string }): SaveCalendarResult {
  if (isMissingColumnError(error)) {
    logPreMigrationOnce(hotelId, error.message);
    return { ok: false, reason: "pre_migration", message: error.message };
  }
  if (error.code === "42501") return { ok: false, reason: "refused", message: error.message };
  return { ok: false, reason: "failed", message: error.message };
}

/**
 * Saves one change from Settings onto the property's settings row, writing
 * only the columns it changes, so a save never puts back a choice someone
 * else changed since this person opened Settings. The room type a price
 * comes from must be one of the property's active room types when a price
 * shows; when none does, a remembered room type is kept only if it is the
 * property's own. Never inserts a row: every property has one from the day
 * it connected, and a new one would start with defaults nobody chose.
 * Answers the whole display as saved.
 */
export async function saveCalendarDisplay(
  supabase: SupabaseClient,
  hotelId: string,
  patch: CalendarDisplayPatch,
): Promise<SaveCalendarResult> {
  const { data: current, error: readError } = await supabase
    .from("hotel_settings")
    .select(CALENDAR_DISPLAY_COLUMNS)
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (readError) return saveError(hotelId, readError as { message: string; code?: string });
  if (!current) return { ok: false, reason: "no_row", message: "no hotel_settings row" };

  const next = applyDisplayPatch(displayFromRow(current as Record<string, unknown>), patch);
  const columns = new Set<keyof CalendarDisplayRow>();
  const layoutChanged = patch.big !== undefined;
  if (layoutChanged) for (const c of LAYOUT_COLUMNS) columns.add(c);
  if (patch.colors !== undefined) columns.add("calendar_colors");
  if (patch.price_room_type_id !== undefined) columns.add("calendar_price_room_type_id");

  // The room type is checked when this save picks it or changes the day's
  // numbers; a colours save leaves both as they are.
  if (layoutChanged || patch.price_room_type_id !== undefined) {
    if (usesPrice(next) && !next.price_room_type_id) {
      return { ok: false, reason: "room_type", message: "Pick the room type whose price to show." };
    }
    if (next.price_room_type_id) {
      let q = supabase.from("room_types").select("id").eq("hotel_id", hotelId).eq("id", next.price_room_type_id);
      if (usesPrice(next)) q = q.eq("is_active", true);
      const { data, error } = await q.maybeSingle();
      if (error) return { ok: false, reason: "failed", message: error.message };
      if (!data) {
        if (usesPrice(next)) return { ok: false, reason: "room_type", message: "Pick a room type from the list." };
        next.price_room_type_id = null;
        columns.add("calendar_price_room_type_id");
      }
    }
  }

  const row = displayToRow(next);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const c of columns) update[c] = row[c];
  const { data, error } = await supabase
    .from("hotel_settings")
    .update(update)
    .eq("hotel_id", hotelId)
    .select(CALENDAR_DISPLAY_COLUMNS);
  if (error) return saveError(hotelId, error as { message: string; code?: string });
  const rows = (data ?? []) as Record<string, unknown>[];
  // Row level security answers a refused update with no rows rather than an
  // error; the route has checked the role first, so this is a missing row.
  if (rows.length === 0) return { ok: false, reason: "no_row", message: "no hotel_settings row" };
  return { ok: true, display: displayFromRow(rows[0]) };
}
