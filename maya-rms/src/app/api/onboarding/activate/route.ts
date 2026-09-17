import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { requestBaseRateRefresh } from "@/lib/pms/connection-stamps";
import { requestIp, requestUserAgent } from "@/lib/legal/acceptance";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal/versions";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * The "go live" switch: turns simulation mode off so the starter rules start
 * actually publishing prices. RLS restricts hotel_settings writes to
 * hotel_admin/manager, so membership is the authorization.
 *
 * Terms 3.3 treats this press as confirming the rules and limits were
 * reviewed, and the screen says so beside the button. Which Terms were in
 * force, who pressed it and from where go into platform_audit_events next to
 * the act. The property.went_live product event (a database trigger) only
 * knows the user.
 *
 * It also makes the next scheduled tick re-read the hotel's base rates before
 * its first live push (requestBaseRateRefresh).
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
  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return NextResponse.json({ error: "No hotel" }, { status: 400 });
  }

  const { error, data } = await supabase
    .from("hotel_settings")
    .update({ simulation_mode: false, updated_at: new Date().toISOString() })
    .eq("hotel_id", hotelId)
    .select("hotel_id");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.length) {
    // RLS silently filters non-managers into a 0-row update; say so honestly.
    return NextResponse.json(
      { error: "You need admin access on this property to go live." },
      { status: 403 },
    );
  }

  await recordGoLive(request, hotelId, user.id);
  if (isAdminConfigured()) await requestBaseRateRefresh(createAdminClient(), hotelId);
  return NextResponse.json({ ok: true });
}

/**
 * Evidence, not a condition: the switch has already happened, and a failed
 * write is logged rather than turned into an error for a change that stuck.
 */
async function recordGoLive(request: Request, hotelId: string, userId: string): Promise<void> {
  const body = (await request.json().catch(() => null)) as { termsVersion?: unknown } | null;
  // What the page showed, kept beside what the server has in force. A tab
  // left open across a release is the only way the two differ.
  const shown = typeof body?.termsVersion === "string" ? body.termsVersion.slice(0, 16) : null;
  const detail = {
    actor_user_id: userId,
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    shown_terms_version: shown,
    ip: requestIp(request.headers),
    user_agent: requestUserAgent(request.headers),
  };

  if (!isAdminConfigured()) {
    console.error(
      JSON.stringify({ fn: "onboarding/activate", step: "audit", hotelId, warning: "no service role, go-live not recorded", detail }),
    );
    return;
  }
  try {
    // actor_user_id rides in detail: platform_log_event stores auth.uid(),
    // which is null under the service role.
    const { error } = await createAdminClient().rpc("platform_log_event", {
      p_event_type: "hotel.went_live",
      p_entity_type: "hotel",
      p_entity_id: hotelId,
      p_hotel_id: hotelId,
      p_detail: detail,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "onboarding/activate",
        step: "audit",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
        detail,
      }),
    );
  }
}
