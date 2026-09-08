/**
 * Billing for the rooms a property actually runs.
 *
 * MAYA charges per room, so a hotel that signs up stating 20 and runs 60 is
 * underpaying by two thirds — and until this existed, nothing measured them
 * again after onboarding. The count is taken from room_types.total_rooms, which
 * the PMS import writes: under-declaring means lying to your own property
 * management system, not just to a form.
 *
 * Canonical copy — the scheduled sync runs under Deno, so measurement lives here
 * and src/lib/billing/room-count.ts re-exports it. The measuring and the
 * correcting are deliberately separate: this half runs everywhere, while raising
 * a Stripe quantity needs the secret key and belongs to the app.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { nameLooksLikeNonRoom } from "../onboarding/analysis.ts";

/**
 * How long a property has to fix its own room count before MAYA does it.
 *
 * Long enough to cover someone away for a week, short enough that a full billing
 * period never passes at the wrong price.
 */
export const ROOM_SHORTFALL_GRACE_DAYS = 7;

export type RoomVerdict =
  /** Billed count matches, or exceeds, what they run. Nothing to do. */
  | { kind: "ok"; measured: number; billed: number }
  /** They run more rooms than they pay for. Every extra room is money owed. */
  | { kind: "short"; measured: number; billed: number; shortBy: number }
  /** They pay for more than they run — surfaced so they can lower it themselves. */
  | { kind: "over"; measured: number; billed: number; overBy: number }
  /** No usable measurement. Never an accusation. */
  | { kind: "unknown"; reason: "no_room_data" | "not_measured" };

export type RoomMeasurement = {
  /** Sleeping rooms — the only thing MAYA will raise a bill over. */
  billable: number | null;
  /** Active types that read as something other than a bedroom, and their rooms. */
  excluded: { name: string; rooms: number }[];
};

/**
 * What the PMS says, split into what can be billed and what cannot.
 *
 * Every major PMS models an event space, a pickleball court, a parking bay and a
 * spa treatment as a bookable "room type", because sellable inventory is the
 * only primitive it has. Summing them and charging per room would bill a 20-room
 * inn with five courts for 25 rooms — and under an auto-correcting sweep that
 * becomes a real charge for rooms nobody sleeps in.
 *
 * is_active alone does not save us. It filters the ones an owner confirmed
 * during onboarding review, but not the ones on a property that skipped the
 * review, and not a court BUILT LATER — a new room type arrives from the sync
 * already active and is never re-analysed.
 *
 * So the name test runs here too, from the same function the review screen uses.
 * It is deliberately one-directional: a misjudged exclusion under-bills us,
 * which is recoverable, while a misjudged inclusion charges a customer for a
 * car park.
 *
 * Returns billable: null rather than 0 when there is nothing to count. A
 * property mid-import genuinely has no measurement, and reading that as "zero
 * rooms" would be the largest possible over-billing.
 */
export async function measureRooms(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<RoomMeasurement> {
  const { data, error } = await supabase
    .from("room_types")
    .select("name, display_name, total_rooms")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);

  if (error) {
    console.error(JSON.stringify({ fn: "measureRooms", hotel: hotelId, error: error.message }));
    return { billable: null, excluded: [] };
  }
  if (!data?.length) return { billable: null, excluded: [] };

  let billable = 0;
  const excluded: { name: string; rooms: number }[] = [];
  for (const rt of data) {
    const rooms = Number(rt.total_rooms) || 0;
    // Both names are checked: PMSes vary in which one carries the useful label,
    // and "Pickleball Court" appearing in either is enough.
    const label = String(rt.display_name || rt.name || "");
    if (nameLooksLikeNonRoom(label)) excluded.push({ name: label, rooms });
    else billable += rooms;
  }

  return { billable: billable > 0 ? billable : null, excluded };
}

/**
 * Compare what they run against what they pay for.
 *
 * ANY shortfall counts, deliberately. The price is rooms times a per-room rate,
 * so a single extra room is a real amount of money every month — there is no
 * tolerance band inside which under-billing is free.
 */
export function compareRooms(measured: number | null, billed: number | null): RoomVerdict {
  if (measured == null) return { kind: "unknown", reason: "no_room_data" };
  if (billed == null || billed < 1) return { kind: "unknown", reason: "not_measured" };

  if (measured > billed) return { kind: "short", measured, billed, shortBy: measured - billed };
  if (measured < billed) return { kind: "over", measured, billed, overBy: billed - measured };
  return { kind: "ok", measured, billed };
}

export type RoomCountRecord = {
  measured_rooms: number;
  measured_rooms_at: string;
  room_shortfall_since?: string | null;
};

/**
 * Persist a fresh measurement, and run the grace clock.
 *
 * room_shortfall_since is set the first time a property is seen short and left
 * alone on every later sync, so the deadline is measured from when the problem
 * started rather than being pushed forward every five minutes — which would mean
 * it never expired. It is cleared the moment the shortfall is resolved, so a
 * property that corrects itself and drifts again gets a fresh week.
 */
export async function recordRoomCount(
  supabase: SupabaseClient,
  hotelId: string,
  now: Date,
): Promise<RoomVerdict> {
  const { billable: measured, excluded } = await measureRooms(supabase, hotelId);
  if (excluded.length > 0) {
    console.log(
      JSON.stringify({ fn: "recordRoomCount", hotel: hotelId, notBilled: excluded }),
    );
  }

  const { data: sub } = await supabase
    .from("hotel_subscriptions")
    .select("billed_rooms, room_shortfall_since")
    .eq("hotel_id", hotelId)
    .maybeSingle();

  // No subscription means billing does not apply here — the sandbox, an
  // admin-created property. Measuring it would be noise.
  if (!sub) return { kind: "unknown", reason: "not_measured" };

  const verdict = compareRooms(measured, Number(sub.billed_rooms));
  if (measured == null) return verdict;

  const patch: RoomCountRecord = {
    measured_rooms: measured,
    measured_rooms_at: now.toISOString(),
  };

  if (verdict.kind === "short") {
    // Only start the clock; never restart it.
    if (!sub.room_shortfall_since) patch.room_shortfall_since = now.toISOString();
  } else if (sub.room_shortfall_since) {
    patch.room_shortfall_since = null;
  }

  const { error } = await supabase
    .from("hotel_subscriptions")
    .update(patch)
    .eq("hotel_id", hotelId);
  if (error) {
    console.error(JSON.stringify({ fn: "recordRoomCount", hotel: hotelId, error: error.message }));
  }

  return verdict;
}

/** Whether the grace period on a shortfall has run out. */
export function graceExpired(shortfallSince: string | null | undefined, now: Date): boolean {
  if (!shortfallSince) return false;
  const started = Date.parse(shortfallSince);
  if (Number.isNaN(started)) return false;
  return now.getTime() - started >= ROOM_SHORTFALL_GRACE_DAYS * 86_400_000;
}

/** Whole days left before MAYA corrects it for them; 0 once it is due. */
export function graceDaysLeft(shortfallSince: string | null | undefined, now: Date): number {
  if (!shortfallSince) return ROOM_SHORTFALL_GRACE_DAYS;
  const elapsed = now.getTime() - Date.parse(shortfallSince);
  return Math.max(0, Math.ceil(ROOM_SHORTFALL_GRACE_DAYS - elapsed / 86_400_000));
}
