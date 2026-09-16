/**
 * POST /api/events — record a product moment that has no database write of
 * its own (a screen viewed, "How did we know?" opened).
 *
 * Only names in lib/analytics/events.ts get through, with only the typed
 * properties listed there, and the person is whoever the session says, never
 * the body. The property is the one the body names only when the caller is a
 * member of it: a parked Marketplace property is not active yet, so it is not
 * in the cookie's list, and the subscribe screen for it is exactly the moment
 * worth recording against it. Without a hotel id the active-property cookie
 * decides, and a signup that has no property yet records against no hotel.
 *
 * Analytics never costs a page anything. Every outcome past the auth and
 * allowlist checks answers 204, including the ones where nothing was recorded.
 */

import { cleanUiEvent } from "@/lib/analytics/events";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const recorded = () => new NextResponse(null, { status: 204 });

export async function POST(request: Request) {
  if (!isSupabaseConfigured() || !isAdminConfigured()) return recorded();

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const throttled = await enforceRateLimit("productEvent", user.id);
  if (throttled) return throttled;

  const clean = cleanUiEvent(await request.json().catch(() => null));
  if (!clean) return NextResponse.json({ error: "Unknown event." }, { status: 400 });

  try {
    const admin = createAdminClient();
    const hotelId = await hotelFor(admin, supabase, user.id, clean.hotelId);
    const { error } = await admin.rpc("product_event_emit", {
      p_event: clean.event,
      p_hotel_id: hotelId,
      p_user_id: user.id,
      p_properties: clean.properties,
      p_source: "app",
    });
    if (error) {
      console.error(JSON.stringify({ fn: "api/events", event: clean.event, error: error.message }));
    }
  } catch (e) {
    console.error(
      JSON.stringify({ fn: "api/events", event: clean.event, error: e instanceof Error ? e.message : String(e) }),
    );
  }
  return recorded();
}

async function hotelFor(
  admin: SupabaseClient,
  supabase: SupabaseClient,
  userId: string,
  named: string | null,
): Promise<string | null> {
  if (named) {
    const { data } = await admin
      .from("hotel_memberships")
      .select("hotel_id")
      .eq("hotel_id", named)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    return data ? named : null;
  }
  return resolveAccessibleHotelId(supabase);
}
