/**
 * POST /api/room-types/limits: remove one room type's floor or ceiling,
 * putting it back to no limit (a floor of 1.00, a ceiling of 99,999.99).
 *
 * The setup review lists every floor and ceiling the answers and the import
 * set, each with this one-click remove (Jake, 2026-09-30, audit A21): the
 * import writes them without asking, and the go-live confirm asks the owner
 * to stand behind them. Body: { hotelId, roomTypeId, limit: "floor" | "ceiling" }.
 *
 * The remove holds: it stamps floor_cleared_at or ceiling_cleared_at beside
 * the limit, and an import never fills a stamped limit again, from the rates
 * or from the answers (_shared/onboarding/limit-removals.ts). The review opens
 * while the import is still reading, so this often comes before its last
 * pass. The owner's own acts (the five questions again, a suggestion card,
 * PIE's price limits) still set one.
 *
 * Written under the person's own session, as the import from PIE writes
 * limits: row security asks for a Revenue Manager or higher, and in God Mode
 * the database records the change as support's. The update to room_types
 * marks the property for pricing again (the pricing cadence triggers), and the
 * sync is nudged so the change shows within a cycle.
 */

import { isUuid } from "@/lib/api-guards";
import { noLimitPatch, type LimitKind } from "@/lib/onboarding/limits";
import {
  isMissingRemovalColumn,
  LIMIT_REMOVALS_MIGRATION,
  removalStamp,
} from "../../../../../supabase/functions/_shared/onboarding/limit-removals";
import { enforceRateLimit } from "@/lib/rate-limit";
import { roleLabel } from "@/lib/roles";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { scheduleReprice } from "../reprice";

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase is required to change limits." }, { status: 501 });
  }
  const body = (await req.json().catch(() => null)) as { hotelId?: unknown; roomTypeId?: unknown; limit?: unknown } | null;
  const hotelId = body?.hotelId;
  const roomTypeId = body?.roomTypeId;
  const limit = body?.limit;
  if (typeof hotelId !== "string" || !isUuid(hotelId)) return bad("Pick a property first.");
  if (typeof roomTypeId !== "string" || !isUuid(roomTypeId)) return bad("Pick a room type.");
  if (limit !== "floor" && limit !== "ceiling") return bad("Say which limit to remove.");

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: canManage } = await supabase.rpc("can_manage_hotel", { target_hotel_id: hotelId });
  if (!canManage) {
    return NextResponse.json(
      { error: `This needs ${roleLabel("revenue_manager")} access or higher on this property.` },
      { status: 403 },
    );
  }

  const throttled = await enforceRateLimit("manualPrice", user.id, "That's a lot of changes at once. Give it a minute and try again.");
  if (throttled) return throttled;

  const write = (patch: Record<string, unknown>) =>
    supabase.from("room_types").update(patch).eq("id", roomTypeId).eq("hotel_id", hotelId).select("id, floor_price, ceiling_price");
  let { data, error } = await write({ ...noLimitPatch(limit as LimitKind), ...removalStamp(limit as LimitKind) });
  if (error && isMissingRemovalColumn(error)) {
    // Before 99_supabase_migration_room_type_limit_removals_v1.sql: the limit
    // still goes, but an import can fill it again.
    console.warn(
      JSON.stringify({ fn: "room-types/limits", hotelId, roomTypeId, schema: "pre-migration", migration: LIMIT_REMOVALS_MIGRATION }),
    );
    ({ data, error } = await write(noLimitPatch(limit as LimitKind)));
  }
  if (error) {
    console.error(JSON.stringify({ fn: "room-types/limits", hotelId, roomTypeId, limit, error: error.message }));
    return NextResponse.json({ error: "That didn't save. Try again." }, { status: 500 });
  }
  const row = (data ?? [])[0] as { floor_price?: unknown; ceiling_price?: unknown } | undefined;
  if (!row) return bad("That room type isn't on this property.");

  if (isAdminConfigured()) await scheduleReprice(createAdminClient(), hotelId, "room-types/limits");
  return NextResponse.json({ ok: true, floor_price: Number(row.floor_price), ceiling_price: Number(row.ceiling_price) });
}
