import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Records the user's onboarding path choice on their profile, and on the
 * property they just connected.
 *
 * "self_serve" also stamps onboarding_dismissed_at so the dashboard stops
 * redirecting them here. What it deliberately does NOT do is stop anything: the
 * PMS import was queued by the connect callback and keeps running, so driving
 * yourself now means a dashboard filling itself in rather than an empty one.
 */
export async function POST(request: Request) {
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

  const body = (await request.json().catch(() => null)) as { path?: string } | null;
  const path = body?.path;
  if (path !== "guided" && path !== "self_serve") {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Upsert: profile rows are trigger-created for new users, but older
  // accounts may predate the trigger.
  const { error } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      onboarding_path: path,
      onboarding_dismissed_at: path === "self_serve" ? new Date().toISOString() : null,
    },
    { onConflict: "id" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Keep the property's own record in step with the profile. The guided surfaces
  // read onboarding_states, and a row still claiming "guided" after the owner
  // chose to drive is how someone who asked not to be led gets led anyway.
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (hotelId) {
    const { error: stateErr } = await supabase
      .from("onboarding_states")
      .upsert({ hotel_id: hotelId, path, updated_at: new Date().toISOString() }, { onConflict: "hotel_id" });
    // Not fatal — the profile is what routing reads, and this is the copy.
    if (stateErr) {
      console.error(JSON.stringify({ fn: "onboardingPath", hotelId, error: stateErr.message }));
    }
  }

  return NextResponse.json({ ok: true });
}
