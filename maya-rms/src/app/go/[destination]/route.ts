/**
 * GET /go/<destination>: the one way in for a link into MAYA, from the docs,
 * an email or anywhere else.
 *
 * It checks the link against src/lib/deep-links/registry.json, sends a
 * signed-out visitor to sign in and back, uses the active property (or the
 * one the link names, only when MAYA made the click and the person can open
 * it), reroutes a role that cannot act there, then sends the browser to the
 * app's own address for that place. It reads and never writes, apart from
 * that active-property cookie. It records no analytics: the page the person
 * lands on does, so link scanners and prefetches leave no trace.
 */

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { resolveGo } from "@/lib/deep-links/go";
import { listUnpaidMarketplaceHotels } from "@/lib/billing/pending-hotel";
import { isStripeConfigured } from "@/lib/billing/stripe";
import {
  activeHotelCookieOptions,
  listAccessibleHotels,
  MAYA_ACTIVE_HOTEL_COOKIE,
  resolveAccessibleHotelId,
} from "@/lib/hotel-context";
import { memberRole } from "@/lib/deep-links/member-role";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ destination: string }> }) {
  const { destination } = await params;
  const configured = isSupabaseConfigured();
  const supabase = configured ? createClient(await cookies()) : null;
  let userId: string | null = null;

  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`;
  const result = await resolveGo(
    {
      destination,
      search: request.nextUrl.searchParams,
      fetchSite: request.headers.get("sec-fetch-site"),
      prefetch: /prefetch|prerender/i.test(purpose) || request.headers.has("next-router-prefetch"),
    },
    {
      configured,
      async userId() {
        if (!supabase) return null;
        const { data } = await supabase.auth.getUser();
        userId = data.user?.id ?? null;
        return userId;
      },
      async accessibleHotelIds() {
        return supabase ? (await listAccessibleHotels(supabase)).map((h) => h.id) : [];
      },
      async activeHotelId() {
        return supabase ? resolveAccessibleHotelId(supabase) : null;
      },
      async roleOn(hotelId) {
        return supabase && userId ? memberRole(supabase, userId, hotelId) : null;
      },
      async isPlatformAdmin() {
        if (!supabase) return false;
        const { data } = await supabase.rpc("is_platform_admin");
        return Boolean(data);
      },
      async hasUnpaidProperties() {
        if (!userId || !isStripeConfigured() || !isAdminConfigured()) return false;
        try {
          return (await listUnpaidMarketplaceHotels(createAdminClient(), userId)).length > 0;
        } catch {
          return false;
        }
      },
    },
  );

  // A relative Location: the browser resolves it against this same origin,
  // so no Host header ever decides where anyone is sent.
  const res = new NextResponse(null, { status: 303, headers: { Location: result.location } });
  if (result.setHotel) res.cookies.set(MAYA_ACTIVE_HOTEL_COOKIE, result.setHotel, activeHotelCookieOptions());
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("X-Robots-Tag", "noindex");
  res.headers.set("Referrer-Policy", "same-origin");
  return res;
}
