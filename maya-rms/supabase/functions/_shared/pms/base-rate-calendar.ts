/**
 * Capture the property's OWN rate for each room-night into base_rate_calendar.
 *
 * Why this exists: the engine used to take its base from the newest
 * reservation's base_rate, which the reservations_sync_base_rate trigger fills
 * from current_rate — what the guest actually paid. So once MAYA pushed an
 * adjusted rate and someone booked at it, that booking came back through the
 * sync as the cell's base. The rule had not re-fired (ladder rules correctly
 * stay quiet while their condition holds) but the number underneath it had
 * moved, and only ever upward; when the rule later deactivated, the cell
 * reverted to the RAISED number instead of the hotel's own rate. Measured on
 * the sandbox: $200 -> $230 published -> booked at $230 -> $264.50, and a
 * revert that landed on $230 while never-sold rooms correctly returned to $200.
 *
 * It also removes the quiet first day: a brand-new property has no reservations
 * on future dates and therefore no base for them, so the engine skipped those
 * cells entirely and priced nothing until bookings arrived.
 *
 * THE REFRESH RULE, and it is the whole safety story: a cell may be captured
 * only while MAYA has never pushed a rate to it. After we push, the PMS is
 * reporting our own adjustment back to us, and storing that as "the hotel's
 * rate" would rebuild the compounding bug this table exists to prevent.
 * rate_updates is the record of what we have pushed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PmsRatePushAdapter } from "./rate-push.ts";

export type SeedCalendarResult =
  | { ok: false; reason: "unsupported" | "no_rate_targets" | "no_room_types"; captured: 0 }
  | { ok: true; captured: number; skippedAlreadyPushed: number; days: number };

const CHUNK = 500;

function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export async function seedBaseRateCalendar(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  opts: { horizonDays?: number; today?: string } = {},
): Promise<SeedCalendarResult> {
  if (!adapter.fetchRateCalendar) return { ok: false, reason: "unsupported", captured: 0 };

  const horizon = Math.max(1, Math.min(396, Math.floor(opts.horizonDays ?? 365)));
  const firstDate = opts.today ?? new Date().toISOString().slice(0, 10);
  const lastDate = addDaysYmd(firstDate, horizon - 1);

  const { data: rtRows } = await supabase
    .from("room_types")
    .select("id, external_room_type_id")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  const localByExternal = new Map<string, string>();
  for (const r of rtRows ?? []) {
    if (r.external_room_type_id) localByExternal.set(String(r.external_room_type_id), String(r.id));
  }
  if (localByExternal.size === 0) return { ok: false, reason: "no_room_types", captured: 0 };

  const targets = await adapter.resolveRateTargets();
  if (Object.keys(targets).length === 0) return { ok: false, reason: "no_rate_targets", captured: 0 };

  const entries = await adapter.fetchRateCalendar(firstDate, lastDate, targets);

  // Cells MAYA has already pushed to are off limits — see THE REFRESH RULE.
  const { data: pushed } = await supabase
    .from("rate_updates")
    .select("stay_date, room_type_id")
    .eq("hotel_id", hotelId)
    .gte("stay_date", firstDate)
    .lte("stay_date", lastDate);
  const pushedCells = new Set(
    (pushed ?? [])
      .filter((p) => p.room_type_id)
      .map((p) => `${p.stay_date}|${p.room_type_id}`),
  );

  const capturedAt = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  let skippedAlreadyPushed = 0;
  for (const e of entries) {
    const roomTypeId = localByExternal.get(e.externalRoomTypeId);
    if (!roomTypeId) continue;
    if (pushedCells.has(`${e.stayDate}|${roomTypeId}`)) {
      skippedAlreadyPushed++;
      continue;
    }
    rows.push({
      hotel_id: hotelId,
      stay_date: e.stayDate,
      room_type_id: roomTypeId,
      price: e.price,
      source: "pms",
      captured_at: capturedAt,
    });
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from("base_rate_calendar")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "hotel_id,stay_date,room_type_id" });
    if (error) {
      console.error(
        JSON.stringify({ fn: "seedBaseRateCalendar", hotelId, error: error.message }),
      );
    }
  }

  return { ok: true, captured: rows.length, skippedAlreadyPushed, days: horizon };
}

/**
 * Keep the calendar covering the pricing horizon, cheaply.
 *
 * Seeds only the dates that are not covered yet: the first run on a property
 * captures the whole window, and every run after that extends the far edge as
 * the horizon rolls forward. Cells MAYA has already pushed to are excluded by
 * seedBaseRateCalendar itself, so calling this on a live hotel is safe — it can
 * only fill gaps, never overwrite the property's rate with our own.
 *
 * Failures are swallowed: a hotel with no calendar prices exactly as it did
 * before this table existed, so a PMS hiccup here must never take down a tick.
 */
export async function ensureBaseRateCalendar(
  supabase: SupabaseClient,
  hotelId: string,
  adapter: PmsRatePushAdapter,
  opts: { horizonDays?: number; maxDaysPerRun?: number; today?: string } = {},
): Promise<SeedCalendarResult | { ok: false; reason: "covered" | "failed"; captured: 0 }> {
  if (!adapter.fetchRateCalendar) return { ok: false, reason: "unsupported", captured: 0 };

  const horizon = Math.max(1, Math.min(396, Math.floor(opts.horizonDays ?? 365)));
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const horizonEnd = addDaysYmd(today, horizon - 1);

  try {
    // Where does coverage currently reach?
    const { data: newest } = await supabase
      .from("base_rate_calendar")
      .select("stay_date")
      .eq("hotel_id", hotelId)
      .gte("stay_date", today)
      .order("stay_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const from = newest?.stay_date ? addDaysYmd(String(newest.stay_date), 1) : today;
    if (from > horizonEnd) return { ok: false, reason: "covered", captured: 0 };

    // Bound the work a single tick will do; the next tick picks up the rest.
    const maxDays = Math.max(1, opts.maxDaysPerRun ?? 90);
    const spanDays = Math.min(maxDays, daysBetween(from, horizonEnd) + 1);

    return await seedBaseRateCalendar(supabase, hotelId, adapter, {
      horizonDays: spanDays,
      today: from,
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "ensureBaseRateCalendar",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return { ok: false, reason: "failed", captured: 0 };
  }
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
