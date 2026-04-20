import { listAccessibleHotels, MAYA_ACTIVE_HOTEL_COOKIE } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 400;

export async function POST(req: Request) {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json({ error: "Not available in demo mode." }, { status: 501 });
    }

    const supabase = createClient(await cookies());
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as { hotelId?: string };
    const hotelId = typeof body.hotelId === "string" ? body.hotelId.trim() : "";
    if (!hotelId) {
      return NextResponse.json({ error: "hotelId required." }, { status: 400 });
    }

    const hotels = await listAccessibleHotels(supabase);
    if (!hotels.some((h) => h.id === hotelId)) {
      return NextResponse.json({ error: "Hotel not accessible." }, { status: 403 });
    }

    const res = NextResponse.json({ ok: true, activeHotelId: hotelId });
    res.cookies.set(MAYA_ACTIVE_HOTEL_COOKIE, hotelId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE_SEC,
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to set hotel." },
      { status: 500 },
    );
  }
}
