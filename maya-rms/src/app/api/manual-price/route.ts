/**
 * /api/manual-price — a human-typed rate for one or more nights of a room type.
 *
 * The typed number is a RESET POINT for the cell, not a nudge on top of what
 * MAYA was doing: it becomes the base, and every rule effect already holding
 * on the cell is suppressed (ladder rows stamped suppressed_at, pickup events
 * retired) so what gets published is the number the manager typed. Rules that
 * fire afterwards stack on the new base like they would on any other. The
 * reset itself is setManualPrices, which a rate changed in the PMS on a night
 * MAYA had sent goes through too.
 *
 * Writes run on the service-role client after the can_manage_hotel gate:
 * ladder_rule_state and pickup_event are engine tables the user-scoped client
 * has no business updating, and the re-evaluation that follows needs to write
 * published_price the same way the scheduled tick does.
 *
 * Clearing (DELETE) stamps cleared_at rather than deleting — the row is the
 * audit trail of who typed what — and lifts the ladder suppression so MAYA's
 * own pricing resumes. Retired pickup events stay retired: they were history.
 * Only tonight onwards is cleared: rules never price a night that has passed.
 *
 * The save says what happens to the price next (Pushed), checked the way the
 * scheduled syncs decide it: a stopped subscription, simulation, a connection
 * that is down, or a night past the push window each mean nothing goes out now.
 */

import { dbErrorResponse, isRealIsoDate, isUuid, NOT_READY_YET } from "@/lib/api-guards";
import { isEntitledStatus } from "@/lib/billing/entitlement";
import { currencySymbolFor } from "@/lib/changelog-route-helpers";
import { evaluateHotel } from "@/lib/engine";
import { clampPrice, priceBounds } from "@/lib/engine/pricing";
import { isMissingColumnError, isMissingRelationError } from "@/lib/engine/snapshots";
import { hotelRuleIds, setManualPrices } from "@/lib/pms/manual-price";
import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { lastNightOf, MAX_PRICING_HORIZON_DAYS } from "@/lib/pms/pricing-window";
import { SENDS_PRICES } from "@/lib/pms/send-status";
import { nudgeHotelSync } from "@/lib/pms/sync-nudge";
import { hotelToday } from "@/lib/simulator";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordIfSupport } from "@/lib/admin/god-mode";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { bad, gate, readBody } from "./gate";

// The save itself is quick; the re-evaluation behind it is not. Same cap as
// /api/evaluate rather than whatever the platform default happens to be.
export const maxDuration = 300;

/** Inclusive number of nights one request may cover. */
const MAX_SPAN_DAYS = 366;
/**
 * How far ahead a price may be typed: the furthest night the engine can ever
 * price (evaluateHotel caps its window at MAX_PRICING_HORIZON_DAYS). A night
 * past the hotel's window is kept and priced when the window reaches it.
 */
const MAX_DAYS_AHEAD = MAX_PRICING_HORIZON_DAYS - 1;
/** Stored verbatim on every row of a span; enough for a sentence, not a memo. */
const MAX_NOTE_CHARS = 500;
/** numeric(10,2) overflows past this and surfaces as a 500. */
const MAX_PRICE = 99_999_999.99;

/**
 * What happens to the saved price next, so the editor's line is true.
 *
 * "zero_not_sent": a comp night's 0 on a live hotel. No rate push takes a
 * rate of 0 yet (PmsRatePushAdapter acceptsZeroRate), so the push holds it and
 * the change log tells the owner to set it in the PMS.
 * "billing_paused": the subscription has stopped, and the scheduled syncs
 * skip the hotel (splitByEntitlement), so nothing goes out. The response
 * carries billingStatus, because the way back differs by status.
 * "reconnect": the hotel's connection is Disconnected, which the syncs never
 * claim, so nothing goes out until the owner reconnects.
 * "connection_error": the connection reads Error. The syncs keep claiming it
 * and trying to read (claim_pms_sync_batch skips only Disconnected and
 * Pending); the first read that works turns it Connected and that same tick
 * sends the price. No nudge: a read is what it is waiting for.
 * "saved": the hotel's mode or its connection could not be read just now, so
 * the line promises nothing about sending.
 */
type Pushed =
  | "nudged"
  | "next_cycle"
  | "simulation"
  | "beyond_window"
  | "zero_not_sent"
  | "billing_paused"
  | "reconnect"
  | "connection_error"
  | "saved";

/**
 * How many of the saved nights the scheduled push covers today (`now`) and how
 * many sit past its horizon and go out as the window reaches them (`later`).
 * A range straddling the edge is the common case for a season set in one go,
 * and "sending now" for all of it would be a lie about the far end. `days` is
 * the window's length, so the copy names the window the push really uses.
 */
type PushWindow = { now: number; later: number; days: number };

type PostBody = {
  hotelId?: unknown;
  roomTypeId?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  price?: unknown;
  note?: unknown;
};

type Range = { hotelId: string; roomTypeId: string; dateFrom: string; dateTo: string };

/**
 * The route's failure shape. One case is not a fault: manual_price arrives in
 * its own migration, and this code can be deployed ahead of it. Then the save
 * is refused as "needs an update", loudly logged, and nothing about the page
 * that called breaks — a 500 here reads as MAYA being broken, which it isn't.
 */
function failed(error: unknown, step: string): NextResponse {
  if (isMissingRelationError(error)) {
    console.error(
      JSON.stringify({
        fn: "manual-price",
        step,
        warning: "manual_price table is missing — run 99_supabase_migration_manual_price_v1.sql",
      }),
    );
    return NextResponse.json({ error: NOT_READY_YET }, { status: 503 });
  }
  const { status, message } = dbErrorResponse(error);
  return NextResponse.json({ error: message }, { status });
}

function isoDatePlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

function datesInRange(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  for (let i = 0, n = daysBetween(fromIso, toIso); i <= n; i++) {
    out.push(isoDatePlus(fromIso, i));
  }
  return out;
}

/**
 * Nights of the range on each side of the push window, [today, today + horizon
 * - 1] on the hotel's calendar: the nights the scheduled tick prices and
 * pushes (pricing-window.ts), `days` long as the hotel's last pass was
 * (hotelPricingHorizon).
 */
function splitByPushWindow(range: Range, today: string, days: number): PushWindow {
  const nights = daysBetween(range.dateFrom, range.dateTo) + 1;
  const lastPushed = lastNightOf(today, days);
  // dateFrom is never before today: a save refuses earlier nights and a
  // clear starts from today.
  const inside = daysBetween(range.dateFrom, lastPushed) + 1;
  const now = Math.max(0, Math.min(nights, inside));
  return { now, later: nights - now, days };
}

/** Shape checks that need no database: ids, dates, ordering, span. */
function parseRange(body: PostBody): { ok: true; range: Range } | { ok: false; response: NextResponse } {
  const { hotelId, roomTypeId, dateFrom } = body;
  if (typeof roomTypeId !== "string" || !isUuid(roomTypeId)) {
    return { ok: false, response: bad("Pick a room type.") };
  }
  if (typeof dateFrom !== "string" || !isRealIsoDate(dateFrom)) {
    return { ok: false, response: bad("Start date must be a real date (YYYY-MM-DD).") };
  }
  const dateTo = body.dateTo == null || body.dateTo === "" ? dateFrom : body.dateTo;
  if (typeof dateTo !== "string" || !isRealIsoDate(dateTo)) {
    return { ok: false, response: bad("End date must be a real date (YYYY-MM-DD).") };
  }
  if (dateTo < dateFrom) {
    return { ok: false, response: bad("End date can't be before the start date.") };
  }
  if (daysBetween(dateFrom, dateTo) + 1 > MAX_SPAN_DAYS) {
    return { ok: false, response: bad(`One change can cover at most ${MAX_SPAN_DAYS} nights.`) };
  }
  return { ok: true, range: { hotelId: hotelId as string, roomTypeId, dateFrom, dateTo } };
}

/**
 * Re-price the saved nights so published_price carries the new base right
 * away, then ask the sync function to push it. Neither may fail the save:
 * the rows it wrote marked those nights for the next scheduled tick, which
 * prices and pushes them regardless.
 *
 * `now` is the instant stamped on the rows (set_at / cleared_at) and is
 * passed through as the engine's evaluation time on purpose: the run's
 * snapshot then lands exactly at set_at, so a pickup baseline floored to
 * the override sees every booking that predates it, and a ladder rule's
 * "did this hold when the price was typed" probe has a snapshot to read.
 */
async function republish(
  admin: SupabaseClient,
  range: Range,
  today: string,
  now: string,
): Promise<PushOutcome & { pushWindow: PushWindow }> {
  const horizonDays = await hotelPricingHorizon(admin, range.hotelId);
  const pushWindow = splitByPushWindow(range, today, horizonDays);
  const outcome = await pushFor(admin, range, today, now, pushWindow, horizonDays);
  return { ...outcome, pushWindow };
}

type PushOutcome = { pushed: Pushed; billingStatus?: string };

/**
 * The subscription's status when it has stopped MAYA's work on the hotel,
 * else null. The same answer the scheduled syncs act on (splitByEntitlement):
 * no subscription row is not stopped, and neither is a failed read, which
 * fails open there too.
 */
async function stoppedSubscription(admin: SupabaseClient, hotelId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("hotel_subscriptions")
    .select("status")
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (error || !data) return null;
  const status = String((data as { status?: unknown }).status);
  return isEntitledStatus(status) ? null : status;
}

/**
 * How the hotel's connection is down, when nothing of its works: "error"
 * when a connection MAYA sends to reads Error (the syncs keep trying it, and
 * the first read that works sends the price), "disconnected" when one reads
 * Disconnected (the syncs never claim it, so the price waits for a
 * reconnect), false otherwise. A working connection beside a stale one
 * decides it, as it does for the nudge (hotelPmsType); Pending, or no
 * connection, is not down. Null when the connections could not be read:
 * nobody can say.
 */
async function connectionDown(admin: SupabaseClient, hotelId: string): Promise<"disconnected" | "error" | false | null> {
  const { data, error } = await admin.from("pms_connections").select("pms_type, status").eq("hotel_id", hotelId);
  if (error) return null;
  const rows = ((data ?? []) as { pms_type?: unknown; status?: unknown }[]).map((r) => ({
    pms: String(r.pms_type),
    status: String(r.status),
  }));
  if (rows.some((r) => r.status === "connected" || r.status === "degraded")) return false;
  const sending = rows.filter((r) => SENDS_PRICES.has(r.pms));
  if (sending.some((r) => r.status === "error")) return "error";
  return sending.some((r) => r.status === "disconnected") ? "disconnected" : false;
}

async function pushFor(
  admin: SupabaseClient,
  range: Range,
  today: string,
  now: string,
  pushWindow: PushWindow,
  horizonDays: number,
): Promise<PushOutcome> {
  // Only the nights saved, inside the window: nothing else moved.
  const lastInWindow = lastNightOf(today, horizonDays);
  const nights = datesInRange(range.dateFrom < today ? today : range.dateFrom, range.dateTo).filter(
    (d) => d <= lastInWindow,
  );
  try {
    if (nights.length > 0) await evaluateHotel(admin, range.hotelId, now, horizonDays, { nights, runKind: "save" });
  } catch (error) {
    console.error(
      JSON.stringify({
        fn: "manual-price",
        step: "evaluate",
        hotelId: range.hotelId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const [billingStatus, { data: settings, error: settingsError }, down] = await Promise.all([
    stoppedSubscription(admin, range.hotelId),
    admin.from("hotel_settings").select("simulation_mode").eq("hotel_id", range.hotelId).maybeSingle(),
    connectionDown(admin, range.hotelId),
  ]);
  // A stopped subscription first: nothing runs or goes out for the hotel,
  // live or not, and the way back is on the Billing page.
  if (billingStatus) return { pushed: "billing_paused", billingStatus };
  // A mode or connection that could not be read: "saved", and no promise
  // either way. The push decides for itself on its next cycle.
  if (settingsError) return { pushed: "saved" };
  // Same reading as the push gate itself: no settings row is not Live.
  if (settings?.simulation_mode !== false) return { pushed: "simulation" };
  if (down === null) return { pushed: "saved" };
  // On Error the syncs are already trying to read; the read that works
  // sends the price on that tick, so a nudge would only add a call to a
  // system that is not answering. Disconnected is never claimed at all.
  if (down === "error") return { pushed: "connection_error" };
  if (down) return { pushed: "reconnect" };
  // Only when NOTHING in the range is pushable. A range that straddles the
  // horizon is nudged for the near nights; the far ones go as they come into
  // window, and the response says how many that is.
  if (pushWindow.now === 0) return { pushed: "beyond_window" };

  // The UI has just been told the push is on its way (sync-nudge.ts).
  return { pushed: await nudgeHotelSync(admin, range.hotelId) };
}

export async function POST(req: Request) {
  try {
    const body = await readBody<PostBody>(req);
    const gated = await gate(body.hotelId);
    if (!gated.ok) return gated.response;
    const { userId, admin } = gated;

    const parsed = parseRange(body);
    if (!parsed.ok) return parsed.response;
    const range = parsed.range;

    const rawPrice = body.price;
    const typed =
      typeof rawPrice === "number"
        ? rawPrice
        : typeof rawPrice === "string" && rawPrice.trim() !== ""
          ? Number(rawPrice)
          : Number.NaN;
    // The column is numeric(10,2). Rounded up front so the preview, the
    // optimistic badge and the stored row all show the same cents.
    const price = Math.round(typed * 100) / 100;
    if (!Number.isFinite(price) || price < 0) {
      return bad("Price must be a number of zero or more.");
    }
    if (price > MAX_PRICE) return bad("That price is more than MAYA can store.");
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
    if (note && note.length > MAX_NOTE_CHARS) {
      return bad(`Keep the note under ${MAX_NOTE_CHARS} characters.`);
    }

    const [{ data: hotel }, { data: roomType }] = await Promise.all([
      admin.from("hotels").select("timezone, currency").eq("id", range.hotelId).maybeSingle(),
      admin
        .from("room_types")
        .select("id, floor_price, ceiling_price")
        .eq("id", range.roomTypeId)
        .eq("hotel_id", range.hotelId)
        .maybeSingle(),
    ]);
    if (!hotel) return bad("Pick a property first.");
    if (!roomType) return bad("That room type isn't on this property.");

    const today = hotelToday(String(hotel.timezone ?? "UTC"));
    if (range.dateFrom < today) {
      return bad("Manual prices apply to tonight onwards; earlier nights have already sold.");
    }
    if (range.dateTo > isoDatePlus(today, MAX_DAYS_AHEAD)) {
      return bad(`You can set a price up to ${MAX_DAYS_AHEAD + 1} nights ahead.`);
    }

    // Reject rather than clamp. A typed number that silently comes back as a
    // different number is exactly the kind of surprise this screen exists to
    // remove; the manager can lift the floor or ceiling if they mean it. A
    // price of 0 is a comp night, not a price under the floor: the engine
    // publishes it as it is (priceBounds), and the floor can't go to 0.
    const sym = currencySymbolFor(hotel.currency ? String(hotel.currency) : null);
    const floor = Number(roomType.floor_price);
    const ceiling = Number(roomType.ceiling_price);
    if (price > 0 && price < floor) {
      return bad(`Below this room type's floor of ${sym}${floor.toFixed(2)}.`);
    }
    if (price > ceiling) {
      return bad(`Above this room type's ceiling of ${sym}${ceiling.toFixed(2)}.`);
    }

    const now = new Date().toISOString();
    const dates = datesInRange(range.dateFrom, range.dateTo);

    // The row, then the reset: every effect already holding on these cells
    // suppressed or retired (setManualPrices).
    const { suppressedRules, retiredPickups, pausedRules } = await setManualPrices(
      admin,
      range.hotelId,
      dates.map((stayDate) => ({ roomTypeId: range.roomTypeId, stayDate, price })),
      { source: "maya", setBy: userId, note },
      now,
    );

    const republished = await republish(admin, range, today, now);
    const { pushWindow, billingStatus } = republished;
    // A 0 never goes out, connected or not; only a hotel where nothing goes
    // out at all says so its own way.
    const pushed: Pushed =
      price === 0 && republished.pushed !== "simulation" && republished.pushed !== "billing_paused"
        ? "zero_not_sent"
        : republished.pushed;

    // Nothing is left applying on the cell, so base and final only part ways
    // at a clamp — and validation already ruled that out. Computed with the
    // engine's own bounds and clampPrice anyway so the preview can't drift from it.
    const bounds = priceBounds(floor, ceiling, price, "manual");
    const clamp = clampPrice(price, bounds.floor, bounds.ceiling);
    const preview = dates.map((stay_date) => ({
      stay_date,
      base: price,
      final: clamp.final,
      clamped_by: clamp.clamped_by,
    }));

    await recordIfSupport(gated.supabase, admin, {
      userId,
      hotelId: range.hotelId,
      tableName: "manual_price",
      rowId: `${range.roomTypeId}:${range.dateFrom}:${range.dateTo}`,
      op: "insert",
      after: { room_type_id: range.roomTypeId, date_from: range.dateFrom, date_to: range.dateTo, price },
      summary:
        dates.length === 1
          ? `Set a manual price of ${price} on ${range.dateFrom}.`
          : `Set a manual price of ${price} on ${dates.length} nights from ${range.dateFrom} to ${range.dateTo}.`,
    });

    return NextResponse.json({
      ok: true,
      cells: dates.length,
      suppressedRules,
      retiredPickups,
      // Rules, counted once each: a rule can hold several fires on one night.
      pausedRules,
      pushed,
      ...(pushed === "billing_paused" && billingStatus ? { billingStatus } : {}),
      pushWindow,
      preview,
    });
  } catch (error) {
    return failed(error, "save");
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await readBody<PostBody>(req);
    const gated = await gate(body.hotelId);
    if (!gated.ok) return gated.response;
    const { userId, admin } = gated;

    const parsed = parseRange(body);
    if (!parsed.ok) return parsed.response;

    const { data: hotel } = await admin
      .from("hotels")
      .select("timezone")
      .eq("id", parsed.range.hotelId)
      .maybeSingle();
    if (!hotel) return bad("Pick a property first.");

    // Rules price tonight onwards only, so a night that has passed is never
    // priced again and clearing it would change nothing. Those nights keep
    // their row as the record of what was sold at; a range reaching into the
    // past clears from tonight.
    const today = hotelToday(String(hotel.timezone ?? "UTC"));
    if (parsed.range.dateTo < today) {
      return NextResponse.json({ ok: true, cells: 0, passed: true });
    }
    const range: Range = { ...parsed.range, dateFrom: parsed.range.dateFrom < today ? today : parsed.range.dateFrom };

    const now = new Date().toISOString();
    const { data: cleared, error: clearErr } = await admin
      .from("manual_price")
      .update({ cleared_at: now, cleared_by: userId })
      .eq("hotel_id", range.hotelId)
      .eq("room_type_id", range.roomTypeId)
      .gte("stay_date", range.dateFrom)
      .lte("stay_date", range.dateTo)
      .is("cleared_at", null)
      .select("stay_date");
    if (clearErr) throw clearErr;

    // MAYA's own pricing resumes, so rules that were holding get their say back.
    const ruleIds = await hotelRuleIds(admin, range.hotelId);
    if (ruleIds.length > 0) {
      const { error } = await admin
        .from("ladder_rule_state")
        .update({ suppressed_at: null })
        .in("rule_id", ruleIds)
        .eq("room_type_id", range.roomTypeId)
        .gte("stay_date", range.dateFrom)
        .lte("stay_date", range.dateTo)
        .not("suppressed_at", "is", null);
      if (error) throw error;
    }

    await republish(admin, range, today, now);

    await recordIfSupport(gated.supabase, admin, {
      userId,
      hotelId: range.hotelId,
      tableName: "manual_price",
      rowId: `${range.roomTypeId}:${range.dateFrom}:${range.dateTo}`,
      op: "update",
      after: { room_type_id: range.roomTypeId, date_from: range.dateFrom, date_to: range.dateTo, cleared: (cleared ?? []).length },
      summary: `Cleared the manual price on ${(cleared ?? []).length} night${(cleared ?? []).length === 1 ? "" : "s"} from ${range.dateFrom} to ${range.dateTo}.`,
    });

    return NextResponse.json({ ok: true, cells: (cleared ?? []).length });
  } catch (error) {
    return failed(error, "clear");
  }
}

export async function GET(req: Request) {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json({ overrides: [] });
    }
    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = new URL(req.url).searchParams;
    const hotelId = params.get("hotelId") ?? "";
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";
    if (!isUuid(hotelId)) return bad("Pick a property first.");
    if (!isRealIsoDate(from) || !isRealIsoDate(to)) {
      return bad("from and to must be real dates (YYYY-MM-DD).");
    }
    if (to < from) return bad("to can't be before from.");

    // Reads go through the caller's own client: manual_price is readable by
    // anyone on the hotel under RLS, and a stranger simply sees nothing.
    // Where a price came from arrives in a later migration; without it every
    // price reads as typed in MAYA.
    const read = (columns: string) =>
      supabase
        .from("manual_price")
        .select(columns)
        .eq("hotel_id", hotelId)
        .gte("stay_date", from)
        .lte("stay_date", to)
        .is("cleared_at", null)
        .order("stay_date", { ascending: true });
    let { data, error } = await read("stay_date, room_type_id, price, set_at, set_by, source, pms_type");
    if (error && isMissingColumnError(error)) {
      ({ data, error } = await read("stay_date, room_type_id, price, set_at, set_by"));
    }
    if (error) throw error;

    return NextResponse.json({
      overrides: ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
        stay_date: String(r.stay_date),
        room_type_id: String(r.room_type_id),
        price: Number(r.price),
        set_at: String(r.set_at),
        set_by: r.set_by == null ? null : String(r.set_by),
        source: r.source === "pms" ? "pms" : "maya",
        pms_type: r.source === "pms" && r.pms_type != null ? String(r.pms_type) : null,
      })),
    });
  } catch (error) {
    return failed(error, "list");
  }
}
