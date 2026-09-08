/**
 * DELETE /api/challenges/[challengeId] — retract a challenge.
 *
 * Owners stay in control of their own corrections: retracting removes the
 * flag, the date becomes comparable again on the next evaluation, and any
 * corroboration it contributed is recounted from what remains.
 */

import { dbErrorResponse, isUuid } from "@/lib/api-guards";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ challengeId: string }> },
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

  const { challengeId } = await params;
  if (!isUuid(challengeId)) {
    return NextResponse.json({ error: "Bad challenge id" }, { status: 400 });
  }
  const { data: deleted, error } = await supabase
    .from("assumption_challenges")
    .delete()
    .eq("id", challengeId)
    .eq("hotel_id", hotelId)
    .select("id");
  if (error) {
    const { status, message } = dbErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
  // RLS makes an out-of-rights delete a silent no-op — surface it instead
  // of reporting success for a correction that is still in force.
  if (!deleted || deleted.length === 0) {
    return NextResponse.json(
      { error: "Nothing was removed — it may already be gone, or removing it needs manager access." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
