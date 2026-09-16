/**
 * /api/manual-price — a human-typed rate for one or more nights of a room type.
 *
 * The typed number is a RESET POINT for the cell, not a nudge on top of what
 * MAYA was doing: it becomes the base, and every rule effect already holding
 * on the cell is suppressed (ladder rows stamped suppressed_at, pickup events
 * retired) so what gets published is the number the manager typed. Rules that
 * fire afterwards stack on the new base like they would on any other.
 *
 * Writes run on the service-role client after the can_manage_hotel gate:
 * ladder_rule_state and pickup_event are engine tables the user-scoped client
 * has no business updating, and the re-evaluation that follows needs to write
 * published_price the same way the scheduled tick does.
 *
 * Clearing (DELETE) stamps cleared_at rather than deleting — the row is the
 * audit trail of who typed what — and lifts the ladder suppression so MAYA's
 * own pricing resumes. Retired pickup events stay retired: they were history.
 */

import { dbErrorResponse, isRealIsoDate, isUuid } from "@/lib/api-guards";
import { currencySymbolFor } from "@/lib/changelog-route-helpers";
import { evaluateHotel } from "@/lib/engine";
import { clampPrice } from "@/lib/engine/pricing";
import { isMissingRelationError } from "@/lib/engine/snapshots";
import { enforceRateLimit } from "@/lib/rate-limit";
import { roleLabel } from "@/lib/roles";
import { hotelToday } from "@/lib/simulator";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse, after } from "next/server";

// The save itself is quick; the re-evaluation behind it is not. Same cap as
// /api/evaluate rather than whatever the platform default happens to be.
export const maxDuration = 300;

/** Inclusive number of nights one request may cover. */
const MAX_SPAN_DAYS = 366;
/** The scheduled rate push covers [today, today + 59]; past that, cron gets it. */
const PUSH_WINDOW_DAYS = 59;
/** The engine prices a year ahead (evaluateHotel caps its horizon at 365). */
const MAX_DAYS_AHEAD = 364;
/** Stored verbatim on every row of a span; enough for a sentence, not a memo. */
const MAX_NOTE_CHARS = 500;
/** numeric(10,2) overflows past this and surfaces as a 500. */
const MAX_PRICE = 99_999_999.99;

/**
 * Which sync function to nudge for a hotel's PMS, and the secret it checks.
 * Each function accepts `{ hotel_id }` for a single-property run. A PMS not
 * listed here is pushed on its own cron cycle.
 */
const SYNC_NUDGE: Record<string, { fn: string; header: string; env: string }> = {
  cloudbeds: { fn: "cloudbeds-scheduled-sync", header: "x-cloudbeds-cron-secret", env: "CLOUDBEDS_CRON_SECRET" },
  think: { fn: "think-scheduled-sync", header: "x-think-cron-secret", env: "THINK_CRON_SECRET" },
  mews: { fn: "mews-scheduled-sync", header: "x-mews-cron-secret", env: "MEWS_CRON_SECRET" },
};

type Pushed = "nudged" | "next_cycle" | "simulation" | "beyond_window";

/**
 * How many of the saved nights the scheduled push covers today (`now`) and how
 * many sit past its horizon and go out as the window reaches them (`later`).
 * A range straddling the edge is the common case for a season set in one go,
 * and "sending now" for all of it would be a lie about the far end.
 */
type PushWindow = { now: number; later: number };

type PostBody = {
  hotelId?: unknown;
  roomTypeId?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  price?: unknown;
  note?: unknown;
};

type Range = { hotelId: string; roomTypeId: string; dateFrom: string; dateTo: string };

type Gate =
  | { ok: true; userId: string; admin: SupabaseClient }
  | { ok: false; response: NextResponse };

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

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
    return NextResponse.json({ error: "This needs a database update first." }, { status: 503 });
  }
  const { status, message } = dbErrorResponse(error);
  return NextResponse.json({ error: message }, { status });
}

async function readBody(req: Request): Promise<PostBody> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as PostBody) : {};
  } catch {
    return {};
  }
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

/** Nights of the range on each side of the push horizon [today, today + 59]. */
function splitByPushWindow(range: Range, today: string): PushWindow {
  const nights = daysBetween(range.dateFrom, range.dateTo) + 1;
  const lastPushed = isoDatePlus(today, PUSH_WINDOW_DAYS);
  // dateFrom is never before today on a save; a clear can name earlier
  // nights, which the push doesn't carry either way, so they count as "now"
  // only insofar as they are inside the window.
  const inside = daysBetween(range.dateFrom, lastPushed) + 1;
  const now = Math.max(0, Math.min(nights, inside));
  return { now, later: nights - now };
}

/**
 * Sign-in, hotel rank, service-role availability, and the per-user budget —
 * in that order, so a signed-out caller can't spend rate-limit hits and a
 * viewer can't learn whether the server is fully configured.
 */
async function gate(hotelId: unknown): Promise<Gate> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Supabase is required to set a manual price." },
        { status: 501 },
      ),
    };
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (typeof hotelId !== "string" || !isUuid(hotelId)) {
    return { ok: false, response: bad("Pick a property first.") };
  }

  const { data: canManage } = await supabase.rpc("can_manage_hotel", {
    target_hotel_id: hotelId,
  });
  if (!canManage) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This needs ${roleLabel("revenue_manager")} access or higher on this property.` },
        { status: 403 },
      ),
    };
  }

  const throttled = await enforceRateLimit(
    "manualPrice",
    user.id,
    "That's a lot of price changes at once. Give it a minute and try again.",
  );
  if (throttled) return { ok: false, response: throttled };

  if (!isAdminConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Manual prices need SUPABASE_SERVICE_ROLE_KEY set on the server." },
        { status: 503 },
      ),
    };
  }

  return { ok: true, userId: user.id, admin: createAdminClient() };
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
 * Re-price the hotel so published_price carries the new base right away,
 * then ask the sync function to push it. Neither may fail the save: the
 * next scheduled tick re-evaluates and pushes regardless.
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
): Promise<{ pushed: Pushed; pushWindow: PushWindow }> {
  const pushWindow = splitByPushWindow(range, today);
  const pushed = await pushFor(admin, range, today, now, pushWindow);
  return { pushed, pushWindow };
}

async function pushFor(
  admin: SupabaseClient,
  range: Range,
  today: string,
  now: string,
  pushWindow: PushWindow,
): Promise<Pushed> {
  // Only as far as the change reaches. A full-horizon run is minutes of
  // reads, and everything past dateTo is untouched by this save.
  const horizonDays = Math.max(1, daysBetween(today, range.dateTo) + 1);
  try {
    await evaluateHotel(admin, range.hotelId, now, horizonDays);
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

  const { data: settings } = await admin
    .from("hotel_settings")
    .select("simulation_mode")
    .eq("hotel_id", range.hotelId)
    .maybeSingle();
  // Same reading as the push gate itself: no settings row is not Live.
  if (settings?.simulation_mode !== false) return "simulation";
  // Only when NOTHING in the range is pushable. A range that straddles the
  // horizon is nudged for the near nights; the far ones go as they come into
  // window, and the response says how many that is.
  if (pushWindow.now === 0) return "beyond_window";

  const nudge = SYNC_NUDGE[await hotelPmsType(admin, range.hotelId)];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const secret = nudge ? process.env[nudge.env] : undefined;
  if (!nudge || !supabaseUrl || !secret) return "next_cycle";

  // Past the response rather than fire-and-forget: a serverless instance can
  // be frozen the moment the reply is sent, before the request leaves the
  // socket, and the UI has just been told the push is on its way.
  after(() =>
    fetch(`${supabaseUrl}/functions/v1/${nudge.fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [nudge.header]: secret },
      body: JSON.stringify({ hotel_id: range.hotelId }),
    }).catch(() => {
      // Cron pushes it within five minutes.
    }),
  );
  return "nudged";
}

/** The PMS this hotel is connected to; a live connection wins over a stale one. */
async function hotelPmsType(admin: SupabaseClient, hotelId: string): Promise<string> {
  const { data } = await admin.from("pms_connections").select("pms_type, status").eq("hotel_id", hotelId);
  const rows = data ?? [];
  const live = rows.find((r) => r.status === "connected") ?? rows[0];
  return live ? String(live.pms_type) : "";
}

/** ladder_rule_state carries no hotel_id; the hotel's rules are the join. */
async function hotelRuleIds(admin: SupabaseClient, hotelId: string): Promise<string[]> {
  const { data, error } = await admin.from("pricing_rules").select("id").eq("hotel_id", hotelId);
  if (error) throw error;
  return (data ?? []).map((r) => String(r.id));
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
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
      return bad("MAYA prices up to a year ahead.");
    }

    // Reject rather than clamp. A typed number that silently comes back as a
    // different number is exactly the kind of surprise this screen exists to
    // remove; the manager can lift the floor or ceiling if they mean it.
    const sym = currencySymbolFor(hotel.currency ? String(hotel.currency) : null);
    const floor = Number(roomType.floor_price);
    const ceiling = Number(roomType.ceiling_price);
    if (price < floor) {
      return bad(`Below this room type's floor of ${sym}${floor.toFixed(2)}.`);
    }
    if (price > ceiling) {
      return bad(`Above this room type's ceiling of ${sym}${ceiling.toFixed(2)}.`);
    }

    const now = new Date().toISOString();
    const dates = datesInRange(range.dateFrom, range.dateTo);

    const { error: upsertErr } = await admin.from("manual_price").upsert(
      dates.map((stay_date) => ({
        hotel_id: range.hotelId,
        room_type_id: range.roomTypeId,
        stay_date,
        price,
        note,
        set_by: userId,
        set_at: now,
        cleared_at: null,
        cleared_by: null,
      })),
      { onConflict: "hotel_id,stay_date,room_type_id" },
    );
    if (upsertErr) throw upsertErr;

    // Suppress what had already fired on these cells. Active ladder rows stay
    // is_active (the condition still holds and the rule must not re-fire on
    // the same trigger) but stop contributing until their next transition.
    let suppressedRules = 0;
    const ruleIds = await hotelRuleIds(admin, range.hotelId);
    if (ruleIds.length > 0) {
      const { data, error } = await admin
        .from("ladder_rule_state")
        .update({ suppressed_at: now })
        .in("rule_id", ruleIds)
        .eq("room_type_id", range.roomTypeId)
        .gte("stay_date", range.dateFrom)
        .lte("stay_date", range.dateTo)
        .eq("is_active", true)
        .is("suppressed_at", null)
        .select("rule_id");
      if (error) throw error;
      suppressedRules = (data ?? []).length;
    }

    const { data: retired, error: retireErr } = await admin
      .from("pickup_event")
      .update({ retired_at: now })
      .eq("hotel_id", range.hotelId)
      .eq("affected_room_type_id", range.roomTypeId)
      .gte("stay_date", range.dateFrom)
      .lte("stay_date", range.dateTo)
      .is("retired_at", null)
      .select("id");
    if (retireErr) throw retireErr;
    const retiredPickups = (retired ?? []).length;

    const { pushed, pushWindow } = await republish(admin, range, today, now);

    // Nothing is left applying on the cell, so base and final only part ways
    // at a clamp — and validation already ruled that out. Computed with the
    // engine's own clampPrice anyway so the preview can't drift from it.
    const clamp = clampPrice(price, floor, ceiling);
    const preview = dates.map((stay_date) => ({
      stay_date,
      base: price,
      final: clamp.final,
      clamped_by: clamp.clamped_by,
    }));

    return NextResponse.json({
      ok: true,
      cells: dates.length,
      suppressedRules,
      retiredPickups,
      pushed,
      pushWindow,
      preview,
    });
  } catch (error) {
    return failed(error, "save");
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await readBody(req);
    const gated = await gate(body.hotelId);
    if (!gated.ok) return gated.response;
    const { userId, admin } = gated;

    const parsed = parseRange(body);
    if (!parsed.ok) return parsed.response;
    const range = parsed.range;

    const { data: hotel } = await admin
      .from("hotels")
      .select("timezone")
      .eq("id", range.hotelId)
      .maybeSingle();
    if (!hotel) return bad("Pick a property first.");

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

    await republish(admin, range, hotelToday(String(hotel.timezone ?? "UTC")), now);

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
    const { data, error } = await supabase
      .from("manual_price")
      .select("stay_date, room_type_id, price, set_at, set_by")
      .eq("hotel_id", hotelId)
      .gte("stay_date", from)
      .lte("stay_date", to)
      .is("cleared_at", null)
      .order("stay_date", { ascending: true });
    if (error) throw error;

    return NextResponse.json({
      overrides: (data ?? []).map((r) => ({
        stay_date: String(r.stay_date),
        room_type_id: String(r.room_type_id),
        price: Number(r.price),
        set_at: String(r.set_at),
        set_by: r.set_by == null ? null : String(r.set_by),
      })),
    });
  } catch (error) {
    return failed(error, "list");
  }
}
