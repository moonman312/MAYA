/**
 * Redeem a Flow A claim ticket for the signed-in user.
 *
 * The Cloudbeds Marketplace callback parks an unclaimed property and hands the
 * browser a one-time token; this is where that token becomes an owned hotel.
 * It requires an authenticated session by design — the ticket is not a
 * credential, so the worst a leaked one can do is let its holder attach a
 * property to their OWN account, and it expires and burns on use.
 */
import { redeemMarketplaceClaim } from "@/lib/pms/marketplace-claim";
import { MAYA_ACTIVE_HOTEL_COOKIE } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Server not configured." }, { status: 503 });
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to finish connecting." }, { status: 401 });
  }

  let token: string | null = null;
  try {
    const body = (await request.json()) as { token?: unknown };
    if (typeof body.token === "string" && body.token.trim()) token = body.token.trim();
  } catch {
    // fall through to the 400 below
  }
  if (!token) {
    return NextResponse.json({ error: "Missing connection token." }, { status: 400 });
  }

  const result = await redeemMarketplaceClaim(token, user.id);
  if (!result.ok) {
    const status = result.reason === "taken" ? 409 : result.reason === "failed" ? 500 : 400;
    return NextResponse.json({ error: result.message }, { status });
  }

  const res = NextResponse.json({ ok: true, hotelId: result.hotelId });
  res.cookies.set(MAYA_ACTIVE_HOTEL_COOKIE, result.hotelId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return res;
}
