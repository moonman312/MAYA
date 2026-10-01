/**
 * GET /api/property/mode: which mode the active property is in, for the strip
 * at the top of every property screen (src/lib/simulation-strip.ts), and
 * whether the person looking may take it live.
 *
 * Anyone who can open the property may ask. Go live is offered by the
 * person's own membership only (General Manager or Hotel Admin), never by a
 * platform admin's support view or God Mode: MAYA staff switch a property in
 * the Command Center. The switch itself is still the database's to allow
 * (POST /api/onboarding/activate, enforce_simulation_mode_rank).
 *
 * It names the property it answered for (hotelId, propertyName): the confirm
 * says which property goes live, and the go-live call carries that id so the
 * route can refuse if the active property changed in the meantime.
 *
 * And it says whether sending to that system is switched on (sendingOn), from
 * what the system's sync last reported (loadSendingSwitch, service role):
 * ThinkReservations' switch starts off, and while it is off the confirm says
 * going live sends nothing yet.
 */

import { memberRole } from "@/lib/deep-links/member-role";
import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { pricingHorizonDays } from "@/lib/pms/pricing-window";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { loadSendingSwitch } from "@/lib/pms/sending-switch";
import { pickConnection, propertyMode } from "@/lib/simulation-strip";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const ctx = await requireSupabaseHotel(await cookies());
  if (!ctx.ok) return ctx.response;
  const { supabase, hotelId, userId } = ctx;

  const [settings, connections, role, windowDays, hotel] = await Promise.all([
    supabase.from("hotel_settings").select("simulation_mode").eq("hotel_id", hotelId).maybeSingle(),
    supabase.from("pms_connections").select("pms_type, status").eq("hotel_id", hotelId),
    memberRole(supabase, userId, hotelId),
    isAdminConfigured() ? hotelPricingHorizon(createAdminClient(), hotelId) : Promise.resolve(pricingHorizonDays()),
    supabase.from("hotels").select("name").eq("id", hotelId).maybeSingle(),
  ]);
  const name = (hotel.data as { name?: unknown } | null)?.name;
  if (settings.error) {
    return NextResponse.json({ error: "Couldn't read this property's mode." }, { status: 500 });
  }

  const connectionRows = (connections.data ?? []) as { pms_type?: unknown; status?: unknown }[];
  const pmsType = pickConnection(connectionRows)?.pms_type;
  // Whether that system's sending is on: the confirm says "nothing is sent yet" when it is off.
  const sendingSwitch = isAdminConfigured() && pmsType != null ? await loadSendingSwitch(createAdminClient(), String(pmsType)) : null;

  return NextResponse.json({
    hotelId,
    propertyName: typeof name === "string" && name.trim() ? name.trim() : null,
    ...propertyMode({
      simulationMode: (settings.data as { simulation_mode?: boolean | null } | null)?.simulation_mode ?? null,
      connections: connectionRows,
      memberRole: role,
      windowDays,
      sendingSwitch,
    }),
  });
}
