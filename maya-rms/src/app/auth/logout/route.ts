import { MAYA_ACTIVE_HOTEL_COOKIE } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  if (isSupabaseConfigured()) {
    const supabase = createClient(await cookies());
    await supabase.auth.signOut();
  }
  const res = NextResponse.redirect(new URL("/login", request.url));
  res.cookies.set(MAYA_ACTIVE_HOTEL_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
