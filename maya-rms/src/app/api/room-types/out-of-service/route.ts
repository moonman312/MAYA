/**
 * /api/room-types/out-of-service — rooms a property has taken off sale.
 *
 * A renovation, a burst pipe, a floor closed for the season: the PMS still
 * lists the room type at its full count, so occupancy reads low and every
 * occupancy-driven rule under-fires. One row here — a date range and how many
 * units — is subtracted from sellable_units in the engine's snapshots. Nothing
 * is pushed to the PMS and no new PMS scope is needed.
 *
 * Clearing stamps cleared_at rather than deleting; the row is the record of
 * who blocked what. Writes go through the service-role client behind the
 * can_manage_hotel gate, and each add or clear is logged.
 */

import { isRealIsoDate, isUuid } from "@/lib/api-guards";
import { enforceRateLimit } from "@/lib/rate-limit";
import { roleLabel } from "@/lib/roles";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { NEEDS_MIGRATION, isPreMigration, scheduleReprice } from "../reprice";

export const maxDuration = 300;

/** Inclusive nights one block may span. A year of renovation is one row; longer is two. */
const MAX_SPAN_DAYS = 366;
const MAX_REASON_CHARS = 200;

type Body = {
  hotelId?: unknown;
  roomTypeId?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  units?: unknown;
  reason?: unknown;
  id?: unknown;
};

type Gate =
  | { ok: true; userId: string; admin: SupabaseClient }
  | { ok: false; response: NextResponse };

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

function needsMigration(hotelId: string, what: string): NextResponse {
  console.warn(
    JSON.stringify({
      fn: "room-types/out-of-service",
      step: "pre-migration",
      hotelId,
      message: `${what}: room_type_out_of_service is missing — run the room classification migration.`,
    }),
  );
  return NextResponse.json({ error: NEEDS_MIGRATION }, { status: 503 });
}

async function readBody(req: Request): Promise<Body> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as Body) : {};
  } catch {
    return {};
  }
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * The most units already out on any one night of [startDate, endDate].
 * Night by night rather than a sum of rows: two rows that both touch the
 * range but not each other are not stacked, and two that do are.
 */
export function peakUnitsOut(
  rows: { start_date: string; end_date: string; units: number }[],
  startDate: string,
  endDate: string,
): number {
  let peak = 0;
  const d = new Date(`${startDate}T00:00:00Z`);
  for (let night = startDate; night <= endDate; ) {
    let out = 0;
    for (const r of rows) if (night >= r.start_date && night <= r.end_date) out += r.units;
    if (out > peak) peak = out;
    d.setUTCDate(d.getUTCDate() + 1);
    night = d.toISOString().slice(0, 10);
  }
  return peak;
}

/** Sign-in, hotel rank, budget, service role — in that order, like manual-price. */
async function gate(hotelId: unknown): Promise<Gate> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Supabase is required to block rooms." },
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
  const { data: canManage } = await supabase.rpc("can_manage_hotel", { target_hotel_id: hotelId });
  if (!canManage) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This needs ${roleLabel("revenue_manager")} access or higher on this property.` },
        { status: 403 },
      ),
    };
  }
  // Each save re-prices the horizon, same as a manual price; shares its budget.
  const throttled = await enforceRateLimit(
    "manualPrice",
    user.id,
    "That's a lot of changes at once. Give it a minute and try again.",
  );
  if (throttled) return { ok: false, response: throttled };
  if (!isAdminConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Blocking rooms needs SUPABASE_SERVICE_ROLE_KEY set on the server." },
        { status: 503 },
      ),
    };
  }
  return { ok: true, userId: user.id, admin: createAdminClient() };
}

/**
 * The actor goes in detail: platform_log_event stores auth.uid(), which is
 * null under the service role. Same key every room-type event uses
 * (actor_user_id) so one query over platform_audit_events answers "who".
 */
async function audit(
  admin: SupabaseClient,
  hotelId: string,
  roomTypeId: string,
  actorUserId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.rpc("platform_log_event", {
    p_event_type: "room_type.out_of_service",
    p_entity_type: "room_type",
    p_entity_id: roomTypeId,
    p_hotel_id: hotelId,
    p_detail: { room_type_id: roomTypeId, actor_user_id: actorUserId, ...detail },
  });
  if (error) {
    console.error(
      JSON.stringify({ fn: "room-types/out-of-service", step: "audit", hotelId, error: error.message }),
    );
  }
}

function failed(error: unknown): NextResponse {
  console.error(
    JSON.stringify({
      fn: "room-types/out-of-service",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return NextResponse.json(
    { error: "Something went wrong on our side. Try again in a moment." },
    { status: 500 },
  );
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const gated = await gate(body.hotelId);
    if (!gated.ok) return gated.response;
    const { userId, admin } = gated;
    const hotelId = body.hotelId as string;

    const { roomTypeId, startDate, endDate } = body;
    if (typeof roomTypeId !== "string" || !isUuid(roomTypeId)) return bad("Pick a room type.");
    if (typeof startDate !== "string" || !isRealIsoDate(startDate)) {
      return bad("Start date must be a real date (YYYY-MM-DD).");
    }
    if (typeof endDate !== "string" || !isRealIsoDate(endDate)) {
      return bad("End date must be a real date (YYYY-MM-DD).");
    }
    if (endDate < startDate) return bad("End date can't be before the start date.");
    if (daysBetween(startDate, endDate) + 1 > MAX_SPAN_DAYS) {
      return bad(`One block can cover at most ${MAX_SPAN_DAYS} nights.`);
    }
    const units = typeof body.units === "string" && body.units.trim() !== "" ? Number(body.units) : body.units;
    if (typeof units !== "number" || !Number.isInteger(units) || units < 1) {
      return bad("Units must be a whole number of at least 1.");
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    if (reason && reason.length > MAX_REASON_CHARS) {
      return bad(`Keep the reason under ${MAX_REASON_CHARS} characters.`);
    }

    const { data: roomType, error: rtErr } = await admin
      .from("room_types")
      .select("id, name, display_name, total_rooms")
      .eq("id", roomTypeId)
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (rtErr) throw rtErr;
    if (!roomType) return bad("That room type isn't on this property.");
    const name = String(roomType.display_name || roomType.name || "");
    const total = Number(roomType.total_rooms) || 0;
    if (units > total) {
      return bad(`${name} has ${total} room${total === 1 ? "" : "s"} — you can't block more than that.`);
    }

    // Blocks stack (the snapshot sums every open row on a night), so the cap
    // has to look at what is already out on these dates, not just this row.
    // Two rows of 8 on a 12-room type would otherwise sell -4 rooms.
    const { data: overlapping, error: overlapErr } = await admin
      .from("room_type_out_of_service")
      .select("start_date, end_date, units")
      .eq("hotel_id", hotelId)
      .eq("room_type_id", roomTypeId)
      .is("cleared_at", null)
      .lte("start_date", endDate)
      .gte("end_date", startDate);
    if (overlapErr) {
      if (isPreMigration(overlapErr)) return needsMigration(hotelId, "POST refused");
      throw overlapErr;
    }
    const alreadyOut = peakUnitsOut(
      (overlapping ?? []).map((r) => ({
        start_date: String(r.start_date),
        end_date: String(r.end_date),
        units: Number(r.units) || 0,
      })),
      startDate,
      endDate,
    );
    if (alreadyOut > 0 && alreadyOut + units > total) {
      return bad(
        `${name} already has ${alreadyOut} room${alreadyOut === 1 ? "" : "s"} out of service on some of those nights — ` +
          `that leaves ${total - alreadyOut} you can still block.`,
      );
    }

    const { data: inserted, error: insErr } = await admin
      .from("room_type_out_of_service")
      .insert({
        hotel_id: hotelId,
        room_type_id: roomTypeId,
        start_date: startDate,
        end_date: endDate,
        units,
        reason,
        created_by: userId,
      })
      .select("id")
      .single();
    if (insErr) {
      if (isPreMigration(insErr)) return needsMigration(hotelId, "POST refused");
      throw insErr;
    }
    const id = String(inserted?.id ?? "");

    await audit(admin, hotelId, roomTypeId, userId, {
      action: "added",
      id,
      name,
      start_date: startDate,
      end_date: endDate,
      units,
      reason,
    });
    scheduleReprice(admin, hotelId, "room-types/out-of-service");

    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return failed(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await readBody(req);
    const gated = await gate(body.hotelId);
    if (!gated.ok) return gated.response;
    const { userId, admin } = gated;
    const hotelId = body.hotelId as string;

    const { id } = body;
    if (typeof id !== "string" || !isUuid(id)) return bad("Pick a block to clear.");

    const now = new Date().toISOString();
    const { data: cleared, error } = await admin
      .from("room_type_out_of_service")
      .update({ cleared_at: now, cleared_by: userId })
      .eq("id", id)
      .eq("hotel_id", hotelId)
      .is("cleared_at", null)
      .select("id, room_type_id, start_date, end_date, units");
    if (error) {
      if (isPreMigration(error)) return needsMigration(hotelId, "DELETE refused");
      throw error;
    }
    const row = (cleared ?? [])[0];
    if (!row) return NextResponse.json({ error: "That block is already cleared." }, { status: 404 });

    await audit(admin, hotelId, String(row.room_type_id), userId, {
      action: "cleared",
      id,
      start_date: row.start_date,
      end_date: row.end_date,
      units: row.units,
    });
    scheduleReprice(admin, hotelId, "room-types/out-of-service");

    return NextResponse.json({ ok: true, id, cleared_at: now, cleared_by: userId });
  } catch (error) {
    return failed(error);
  }
}

export async function GET(req: Request) {
  try {
    if (!isSupabaseConfigured()) return NextResponse.json({ blocks: [] });
    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const hotelId = new URL(req.url).searchParams.get("hotelId") ?? "";
    if (!isUuid(hotelId)) return bad("Pick a property first.");

    // The caller's own client: RLS scopes the rows to hotels they belong to,
    // and a stranger simply sees nothing.
    const { data, error } = await supabase
      .from("room_type_out_of_service")
      .select("id, room_type_id, start_date, end_date, units, reason, created_at")
      .eq("hotel_id", hotelId)
      .is("cleared_at", null)
      .order("start_date", { ascending: true });
    if (error) {
      if (isPreMigration(error)) return needsMigration(hotelId, "GET");
      throw error;
    }

    return NextResponse.json({
      blocks: (data ?? []).map((r) => ({
        id: String(r.id),
        room_type_id: String(r.room_type_id),
        start_date: String(r.start_date),
        end_date: String(r.end_date),
        units: Number(r.units),
        reason: r.reason == null ? null : String(r.reason),
        created_at: String(r.created_at),
      })),
    });
  } catch (error) {
    return failed(error);
  }
}
