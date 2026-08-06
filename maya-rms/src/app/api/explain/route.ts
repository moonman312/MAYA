/**
 * GET /api/explain?run_id=&stay_date=&room_type_id=
 *
 * The drill-down behind one changelog entry: the booking-speed observation
 * snapshots persisted with that evaluation, replayed exactly as they were
 * known at decision time. Fetched on demand when an owner expands "How did
 * we know?" — the changelog list itself stays slim because most readers
 * stop at the level-one sentence.
 */

import { dbErrorResponse, isRealIsoDate, isUuid } from "@/lib/api-guards";
import { buildExplainView, type ExplainView } from "@/lib/explain";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({ error: "No hotel" }, { status: 400 });
  }

  const url = new URL(request.url);
  const runId = url.searchParams.get("run_id") ?? "";
  const stayDate = url.searchParams.get("stay_date") ?? "";
  const roomTypeId = url.searchParams.get("room_type_id") ?? "";
  if (!isUuid(runId) || !isUuid(roomTypeId) || !isRealIsoDate(stayDate)) {
    return NextResponse.json(
      { error: "run_id, stay_date, and room_type_id are required" },
      { status: 400 },
    );
  }

  const { data: row, error } = await supabase
    .from("evaluation_audit")
    .select("details")
    .eq("hotel_id", hotelId)
    .eq("evaluation_run_id", runId)
    .eq("stay_date", stayDate)
    .eq("room_type_id", roomTypeId)
    .maybeSingle();
  if (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
  if (!row) {
    return NextResponse.json({ error: "No audit row for that entry" }, { status: 404 });
  }

  const details = (row.details ?? {}) as { booking_speed_observations?: unknown[] };
  const snapshots = Array.isArray(details.booking_speed_observations)
    ? details.booking_speed_observations
    : [];
  const views = snapshots
    .map(buildExplainView)
    .filter((v): v is ExplainView => v !== null);

  return NextResponse.json({ stay_date: stayDate, views });
}
