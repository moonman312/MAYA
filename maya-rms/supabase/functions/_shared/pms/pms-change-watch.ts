/**
 * What the base rate refresh writes down about rates changed in the PMS on
 * nights MAYA sent to, for the change log and the two emails about them
 * (pms-change-notice.ts sends those). Jake, 2026-09-30.
 *
 * Under "MAYA's price wins" (hotel_settings.pms_rate_changes 'maya_wins'),
 * every overwrite is one pms_change_notices row: the night, the room type,
 * the PMS's rate (null when it was removed) and MAYA's price, which the
 * change log shows as its own item and the day's email lists.
 *
 * Under "Keep the change" (the default), the changes kept are counted per
 * day in pms_change_watch.change_days. When they look like another pricing
 * tool at work, one 'other_tool' row is written: the change log shows it with
 * a button to the setting, and the property's General Manager and Hotel
 * Admins get one email. It looks like another tool when either
 *
 *   - OTHER_TOOL_CHANGES_IN_ONE_READ or more rates (a night and room type
 *     each) MAYA sent change away from MAYA's price in a single read, or
 *   - changes turn up on OTHER_TOOL_CHANGE_DAYS or more different days
 *     (the property's dates) within the last OTHER_TOOL_WINDOW_DAYS,
 *
 * and no warning went out in the last OTHER_TOOL_QUIET_DAYS. Never while the
 * setting is "MAYA's price wins": nothing is kept then.
 *
 * Nothing here can fail a refresh: every write is logged and let go.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError, isMissingRelationError } from "../engine/snapshots.ts";
import { addCalendarDays } from "../engine/timezone.ts";

/** Rates on nights MAYA sent to that one read finds changed, from which another tool seems at work. */
export const OTHER_TOOL_CHANGES_IN_ONE_READ = 20;
/** Different days with changes, within OTHER_TOOL_WINDOW_DAYS, from which another tool seems at work. */
export const OTHER_TOOL_CHANGE_DAYS = 3;
/** The days the changes are counted over: today and the six before it. */
export const OTHER_TOOL_WINDOW_DAYS = 7;
/** The warning goes out at most once in this many days per property. */
export const OTHER_TOOL_QUIET_DAYS = 7;
/** How long overwrite and warning items are kept for the change log. */
export const PMS_CHANGE_NOTICE_KEEP_DAYS = 180;

const DAY_MS = 86_400_000;

/** A night MAYA sends its price to again, as pms-edits.ts found it. */
export type OverwriteNight = {
  read: { stayDate: string; roomTypeId: string; ledger: Record<string, unknown> };
  /** The PMS's rate there now; null when it was removed. */
  pmsRate: number | null;
};

function log(line: Record<string, unknown>, level: "log" | "error" = "log"): void {
  console[level](JSON.stringify({ fn: "pmsChangeWatch", ...line }));
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e)).slice(0, 300);
}

/**
 * The per-day counts with `changes` added to `today`, keeping only the days
 * inside the window that ends on `today`. Counts are whole and positive.
 */
export function nextChangeDays(prev: unknown, today: string, changes: number): Record<string, number> {
  const oldest = addCalendarDays(today, -(OTHER_TOOL_WINDOW_DAYS - 1));
  const out: Record<string, number> = {};
  if (prev && typeof prev === "object" && !Array.isArray(prev)) {
    for (const [day, n] of Object.entries(prev as Record<string, unknown>)) {
      const count = Number(n);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < oldest || day > today || !(count > 0)) continue;
      out[day] = Math.floor(count);
    }
  }
  if (changes > 0) out[today] = (out[today] ?? 0) + Math.floor(changes);
  return out;
}

/**
 * Whether these changes look like another pricing tool, and a warning may go
 * out: see the header.
 */
export function looksLikeAnotherTool(input: {
  /** Changes this read found. */
  changes: number;
  /** Per-day counts, this read's included (nextChangeDays). */
  days: Record<string, number>;
  /** When the last warning went out; NaN when never. */
  lastWarnedAtMs: number;
  nowMs: number;
}): boolean {
  if (input.lastWarnedAtMs > input.nowMs - OTHER_TOOL_QUIET_DAYS * DAY_MS) return false;
  if (input.changes >= OTHER_TOOL_CHANGES_IN_ONE_READ) return true;
  return Object.keys(input.days).length >= OTHER_TOOL_CHANGE_DAYS;
}

/** How many rates changed over the window: what the warning says. */
export function changesInWindow(days: Record<string, number>): number {
  return Object.values(days).reduce((sum, n) => sum + n, 0);
}

/**
 * Under "Keep the change": counts the changes one read kept and, when they
 * look like another tool, writes the warning. Returns whether it did, or null
 * when there was nothing to count or the database can't keep count yet.
 */
export async function watchPmsChanges(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  input: { changes: number; today?: string; at: string },
): Promise<{ warned: boolean; rates: number } | null> {
  if (!(input.changes > 0)) return null;
  const today = input.today ?? input.at.slice(0, 10);
  const nowMs = Date.parse(input.at);
  try {
    const { data, error } = await supabase
      .from("pms_change_watch")
      .select("change_days, other_tool_notice_at")
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (error) {
      if (isMissingRelationError(error) || isMissingColumnError(error)) return null;
      throw error;
    }
    const row = (data ?? null) as { change_days?: unknown; other_tool_notice_at?: unknown } | null;
    const days = nextChangeDays(row?.change_days, today, input.changes);
    const lastWarnedAtMs = row?.other_tool_notice_at != null ? Date.parse(String(row.other_tool_notice_at)) : NaN;
    const { error: upsertError } = await supabase
      .from("pms_change_watch")
      .upsert({ hotel_id: hotelId, change_days: days, updated_at: input.at }, { onConflict: "hotel_id" });
    if (upsertError) throw upsertError;

    const rates = changesInWindow(days);
    if (!looksLikeAnotherTool({ changes: input.changes, days, lastWarnedAtMs, nowMs })) return { warned: false, rates };

    // Claimed in one conditional write, so two refreshes can't both warn.
    const quietSince = new Date(nowMs - OTHER_TOOL_QUIET_DAYS * DAY_MS).toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("pms_change_watch")
      .update({ other_tool_notice_at: input.at, updated_at: input.at })
      .eq("hotel_id", hotelId)
      .or(`other_tool_notice_at.is.null,other_tool_notice_at.lt.${quietSince}`)
      .select("hotel_id");
    if (claimError) throw claimError;
    if ((claimed ?? []).length === 0) return { warned: false, rates };

    const { error: insertError } = await supabase.from("pms_change_notices").insert({
      hotel_id: hotelId,
      pms_type: pmsType,
      kind: "other_tool",
      found_at: input.at,
      rates,
    });
    if (insertError) {
      // Handed back, so a later read tries again.
      await supabase.from("pms_change_watch").update({ other_tool_notice_at: row?.other_tool_notice_at ?? null }).eq("hotel_id", hotelId);
      throw insertError;
    }
    log({ hotelId, pmsType, step: "other_tool", changes: input.changes, days: Object.keys(days).length, rates });
    return { warned: true, rates };
  } catch (e) {
    log({ hotelId, pmsType, step: "watch", error: errorText(e) }, "error");
    return null;
  }
}

/**
 * Under "MAYA's price wins": one change log item per night and room type MAYA
 * sends its price to again, naming MAYA's published price for it (the one the
 * push sends; the price MAYA last sent when none is published). Old items
 * past PMS_CHANGE_NOTICE_KEEP_DAYS go at the same time.
 */
export async function recordOverwrites(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: string,
  overwrites: OverwriteNight[],
  at: string,
): Promise<number> {
  if (overwrites.length === 0) return 0;
  try {
    const published = await publishedPrices(supabase, hotelId, overwrites.map((o) => o.read));
    const rows = overwrites.flatMap(({ read, pmsRate }) => {
      const key = `${read.stayDate}|${read.roomTypeId}`;
      const sent = read.ledger.price != null ? Number(read.ledger.price) : NaN;
      const mayaPrice = published.get(key) ?? sent;
      if (!Number.isFinite(mayaPrice)) return [];
      return [{
        hotel_id: hotelId,
        pms_type: pmsType,
        kind: "overwrite",
        found_at: at,
        stay_date: read.stayDate,
        room_type_id: read.roomTypeId,
        pms_rate: pmsRate,
        maya_price: mayaPrice,
      }];
    });
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("pms_change_notices").insert(rows.slice(i, i + 500));
      if (error) throw error;
    }
    // The day's email is claimed on this row (pms-change-notice.ts).
    const { error: watchError } = await supabase
      .from("pms_change_watch")
      .upsert({ hotel_id: hotelId, updated_at: at }, { onConflict: "hotel_id" });
    if (watchError) throw watchError;
    const { error: purgeError } = await supabase
      .from("pms_change_notices")
      .delete()
      .eq("hotel_id", hotelId)
      .lt("found_at", new Date(Date.parse(at) - PMS_CHANGE_NOTICE_KEEP_DAYS * DAY_MS).toISOString());
    if (purgeError) log({ hotelId, pmsType, step: "purge", error: purgeError.message }, "error");
    log({ hotelId, pmsType, step: "overwrites", nights: rows.length });
    return rows.length;
  } catch (e) {
    log({ hotelId, pmsType, step: "overwrites", nights: overwrites.length, error: errorText(e) }, "error");
    return 0;
  }
}

/** MAYA's published price on these nights, by `stay_date|room_type_id`. */
async function publishedPrices(
  supabase: SupabaseClient,
  hotelId: string,
  nights: { stayDate: string; roomTypeId: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byRoomType = new Map<string, string[]>();
  for (const n of nights) byRoomType.set(n.roomTypeId, [...(byRoomType.get(n.roomTypeId) ?? []), n.stayDate]);
  for (const [roomTypeId, dates] of byRoomType) {
    for (let i = 0; i < dates.length; i += 100) {
      const { data, error } = await supabase
        .from("published_price")
        .select("stay_date, room_type_id, price")
        .eq("hotel_id", hotelId)
        .eq("room_type_id", roomTypeId)
        .in("stay_date", dates.slice(i, i + 100));
      if (error) throw error;
      for (const r of (data ?? []) as { stay_date: unknown; room_type_id: unknown; price: unknown }[]) {
        if (r.price != null) out.set(`${String(r.stay_date).slice(0, 10)}|${String(r.room_type_id)}`, Number(r.price));
      }
    }
  }
  return out;
}
