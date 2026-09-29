/**
 * GET /api/manual-price/send-status?hotelId&roomTypeId&date — what became of
 * the price on one night after its save (lib/pms/send-status.ts): sent,
 * still being retried and how many tries are left, or stopped, with the
 * open sending problem it is filed under. The price editor asks a few times
 * after a save and once when it opens on a night with a typed price.
 *
 * Anyone who can read the hotel may ask; `canRetry` says whether the caller
 * may press Try again (the same rank that may type a price). Reads run on
 * the service-role client after that check, like the manual price route's.
 */

import { dbErrorResponse, isRealIsoDate, isUuid } from "@/lib/api-guards";
import { readSendStatus } from "@/lib/pms/send-status";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(req: Request) {
  try {
    if (!isSupabaseConfigured()) return NextResponse.json({ applicable: false });
    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const params = new URL(req.url).searchParams;
    const hotelId = params.get("hotelId") ?? "";
    const roomTypeId = params.get("roomTypeId") ?? "";
    const date = params.get("date") ?? "";
    if (!isUuid(hotelId)) return bad("Pick a property first.");
    if (!isUuid(roomTypeId)) return bad("Pick a room type.");
    if (!isRealIsoDate(date)) return bad("date must be a real date (YYYY-MM-DD).");

    const [{ data: accessible }, { data: canManage }] = await Promise.all([
      supabase.rpc("is_hotel_accessible", { target_hotel_id: hotelId }),
      supabase.rpc("can_manage_hotel", { target_hotel_id: hotelId }),
    ]);
    if (!accessible) return NextResponse.json({ error: "No access to that property." }, { status: 403 });
    if (!isAdminConfigured()) {
      return NextResponse.json(
        { error: "Manual prices need SUPABASE_SERVICE_ROLE_KEY set on the server." },
        { status: 503 },
      );
    }

    const status = await readSendStatus(createAdminClient(), { hotelId, roomTypeId, date });
    return NextResponse.json({ ...status, canRetry: canManage === true });
  } catch (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
