import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Confirm or dismiss a finding, applying its side effect:
 * - closed_period confirm  -> insert hotel_closed_periods
 * - suspect_room_type confirm -> deactivate the room type
 * - duplicate_room_type dismiss -> reactivate (it was auto-deactivated)
 * - everything else: status change only
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ findingId: string }> },
) {
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

  const { findingId } = await params;
  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;
  if (action !== "confirm" && action !== "dismiss") {
    return NextResponse.json({ error: "action must be confirm or dismiss" }, { status: 400 });
  }

  const { data: finding } = await supabase
    .from("onboarding_findings")
    .select("id, kind, status, payload")
    .eq("id", findingId)
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (!finding) {
    return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  }

  const payload = (finding.payload ?? {}) as Record<string, unknown>;

  if (action === "confirm") {
    if (finding.kind === "closed_period") {
      // Seasonal findings carry every observed instance; one-offs carry one.
      const periods = Array.isArray(payload.periods)
        ? (payload.periods as Array<{ start_date: string; end_date: string }>)
        : payload.start_date && payload.end_date
          ? [{ start_date: String(payload.start_date), end_date: String(payload.end_date) }]
          : [];
      if (periods.length > 0) {
        const { error } = await supabase.from("hotel_closed_periods").insert(
          periods.map((p) => ({
            hotel_id: hotelId,
            room_type_id: null,
            start_date: p.start_date,
            end_date: p.end_date,
            source: "onboarding",
          })),
        );
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
      }
    }
    if (finding.kind === "suspect_room_type" && payload.room_type_id) {
      const { error } = await supabase
        .from("room_types")
        .update({ is_active: false })
        .eq("id", String(payload.room_type_id))
        .eq("hotel_id", hotelId);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  }

  if (
    action === "dismiss" &&
    finding.kind === "duplicate_room_type" &&
    finding.status === "auto_applied" &&
    payload.deactivate_room_type_id
  ) {
    // Undo the auto-fix: bring the room type back.
    await supabase
      .from("room_types")
      .update({ is_active: true })
      .eq("id", String(payload.deactivate_room_type_id))
      .eq("hotel_id", hotelId);
  }

  const { error: updErr } = await supabase
    .from("onboarding_findings")
    .update({
      status: action === "confirm" ? "confirmed" : "dismissed",
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", findingId);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
