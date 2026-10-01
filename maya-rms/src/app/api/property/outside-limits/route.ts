/**
 * GET /api/property/outside-limits?hotelId=…: how many nights in the pricing
 * window have, on some room type, the property's own rate outside that room
 * type's floor or ceiling (lib/onboarding/rates-outside-limits.ts). The go-live confirm
 * says so, since going live sends those nights moved inside the limits with
 * no rule behind it (Jake, 2026-09-30, audit A21).
 *
 * For the active property only, read under the caller's own session. A
 * `hotelId` naming another property (a tab left on it after a switch) gets
 * no number rather than the active one's. Anything that goes wrong answers
 * `nights: null` and the confirm simply leaves the line out: the count is a
 * courtesy, and going live never waits on it.
 */

import { hotelPricingHorizon } from "@/lib/pms/pricing-horizon";
import { pricingHorizonDays } from "@/lib/pms/pricing-window";
import { nightsWithRateOutsideLimits } from "@/lib/onboarding/rates-outside-limits";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const ctx = await requireSupabaseHotel(await cookies());
  if (!ctx.ok) return ctx.response;
  const { supabase, hotelId } = ctx;

  const asked = new URL(req.url).searchParams.get("hotelId");
  if (asked && asked !== hotelId) return NextResponse.json({ nights: null });

  try {
    const horizon = isAdminConfigured() ? await hotelPricingHorizon(createAdminClient(), hotelId) : pricingHorizonDays();
    const nights = await nightsWithRateOutsideLimits(supabase, hotelId, horizon);
    return NextResponse.json({ nights });
  } catch (e) {
    console.error(
      JSON.stringify({ fn: "property/outside-limits", hotelId, error: e instanceof Error ? e.message : String(e) }),
    );
    return NextResponse.json({ nights: null });
  }
}
