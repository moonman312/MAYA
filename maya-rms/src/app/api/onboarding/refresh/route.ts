import { requireEntitledHotel } from "@/lib/billing/require-entitled";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * "Ask Maya for help" on an existing hotel: queues a fresh import + analysis
 * in SUGGESTION mode. Nothing is changed automatically — the run produces
 * per-item suggestions the user accepts or rejects on the review page.
 *
 * Service role is needed because import_jobs writes are worker-only under
 * RLS; authorization is the caller's manage rights on the hotel, checked
 * first via their own session.
 */
export async function POST() {
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
  const { data: canManage } = await supabase.rpc("can_manage_hotel", {
    target_hotel_id: hotelId,
  });
  if (!canManage) {
    return NextResponse.json(
      { error: "You need admin access on this property to run an analysis." },
      { status: 403 },
    );
  }

  const paid = await requireEntitledHotel(supabase, hotelId);
  if (!paid.ok) return paid.response;

  // A refresh fans out into a full PMS re-import — this hotel's own Cloudbeds
  // or Mews allowance, spent hundreds of calls at a time. Same key and
  // reasoning as the manual sync routes.
  const throttled = await enforceRateLimit(
    "reanalyse",
    hotelId,
    "An analysis was just run. Let that one finish before starting another.",
  );
  if (throttled) return throttled;

  // The hotel needs a connected PMS to re-pull from.
  const { data: conn } = await supabase
    .from("pms_connections")
    .select("pms_type, status")
    .eq("hotel_id", hotelId)
    .eq("status", "connected")
    .limit(1)
    .maybeSingle();
  if (!conn) {
    return NextResponse.json(
      { error: "Connect your property system first — there's nothing to analyze yet." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // One active job per hotel (also enforced by a partial unique index).
  const { data: active } = await admin
    .from("import_jobs")
    .select("id")
    .eq("hotel_id", hotelId)
    .in("status", ["queued", "running"])
    .maybeSingle();
  if (active) {
    return NextResponse.json({ ok: true, jobId: active.id, alreadyRunning: true });
  }

  const { data: job, error } = await admin
    .from("import_jobs")
    .insert({
      hotel_id: hotelId,
      pms_type: conn.pms_type,
      status: "queued",
      phase: "discover",
      requested_by: user.id,
      stats: { mode: "refresh" },
    })
    .select("id")
    .single();
  if (error || !job) {
    return NextResponse.json({ error: error?.message ?? "Could not queue" }, { status: 500 });
  }

  await admin
    .from("onboarding_states")
    .upsert(
      {
        hotel_id: hotelId,
        import_job_id: job.id,
        review_completed_at: null, // reopen the review for the new results
        updated_at: new Date().toISOString(),
      },
      { onConflict: "hotel_id" },
    );

  // Nudge the worker; cron is the fallback driver.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.ONBOARDING_CRON_SECRET;
  if (supabaseUrl && secret) {
    fetch(`${supabaseUrl}/functions/v1/onboarding-import-worker`, {
      method: "POST",
      headers: { "x-onboarding-cron-secret": secret },
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, jobId: job.id });
}
