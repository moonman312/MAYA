import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { marketplaceReconnectNeeded } from "@/lib/pms/purged";
import { getRegistry, type PmsType } from "@/lib/pms/registry";
import { hasHotelRank } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
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
        "status, phase, window_index, windows_completed, rows_upserted, reservations_enumerated, oldest_stay_date, newest_stay_date, last_error, started_at, finished_at, stats",
      )
      .eq("id", state.import_job_id)
      .maybeSingle();
    job = data;
  }

  const { data: settings } = await supabase
    .from("hotel_settings")
    .select("simulation_mode")
    .eq("hotel_id", hotelId)
    .maybeSingle();

  const [{ count: proposedFindings }, { data: latestProposed }] = await Promise.all([
    supabase
      .from("onboarding_findings")
      .select("id", { count: "exact", head: true })
      .eq("hotel_id", hotelId)
      .eq("status", "proposed"),
    // The import analyses twice, so a question can arrive after the owner has
    // finished reviewing the first set; this is how the dashboard tells.
    supabase
      .from("onboarding_findings")
      .select("created_at")
      .eq("hotel_id", hotelId)
      .eq("status", "proposed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // Paid for, but its connection is gone: the retention sweep removed this
  // never-paid property's data before the payment. The import has nothing to
  // read until the owner reconnects, so the progress screens show the
  // reconnect prompt instead of waiting on it.
  let reconnect = null;
  if (isAdminConfigured()) {
    try {
      const needed = await marketplaceReconnectNeeded(createAdminClient(), hotelId);
      const registry = needed ? getRegistry(needed.pmsType as PmsType) : null;
      if (needed && registry) {
        reconnect = {
          pmsType: needed.pmsType,
          authKind: registry.authKind,
          displayName: registry.displayName,
          canManage: await hasHotelRank(supabase, hotelId, "general_manager"),
          historyRemoved: needed.historyRemoved,
        };
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          fn: "onboardingStatus",
          step: "reconnect_needed",
          hotelId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  return NextResponse.json({
    connected: true,
    reconnect,
    hotelId,
    hotelName: hotel?.name ?? null,
    currency: hotel?.currency ?? null,
    state: state ?? null,
    job,
    proposedFindings: proposedFindings ?? 0,
    latestProposedAt: latestProposed?.created_at ?? null,
    simulationMode: settings?.simulation_mode !== false,
  });
}
