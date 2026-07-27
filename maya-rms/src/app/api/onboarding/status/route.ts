import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Onboarding status for the signed-in user's active hotel: where they are in
 * the flow plus live import-job progress (drives the progress bar the
 * questions and progress pages poll).
 */
export async function GET() {
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
    return NextResponse.json({ connected: false });
  }

  const [{ data: state }, { data: hotel }] = await Promise.all([
    supabase
      .from("onboarding_states")
      .select(
        "path, import_job_id, connected_at, questions, questions_completed_at, review_completed_at",
      )
      .eq("hotel_id", hotelId)
      .maybeSingle(),
    supabase.from("hotels").select("name, currency").eq("id", hotelId).maybeSingle(),
  ]);

  let job = null;
  if (state?.import_job_id) {
    const { data } = await supabase
      .from("import_jobs")
      .select(
        "status, phase, window_index, windows_completed, rows_upserted, reservations_enumerated, oldest_stay_date, newest_stay_date, last_error, started_at, finished_at",
      )
      .eq("id", state.import_job_id)
      .maybeSingle();
    job = data;
  }

  const { count: proposedFindings } = await supabase
    .from("onboarding_findings")
    .select("id", { count: "exact", head: true })
    .eq("hotel_id", hotelId)
    .eq("status", "proposed");

  return NextResponse.json({
    connected: true,
    hotelId,
    hotelName: hotel?.name ?? null,
    currency: hotel?.currency ?? null,
    state: state ?? null,
    job,
    proposedFindings: proposedFindings ?? 0,
  });
}
