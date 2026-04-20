import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export type CookieStore = Awaited<ReturnType<typeof cookies>>;

export type SupabaseHotelContext = {
  supabase: SupabaseClient;
  hotelId: string;
};

export async function requireSupabaseHotel(
  cookieStore: CookieStore,
): Promise<{ ok: true } & SupabaseHotelContext | { ok: false; response: NextResponse }> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and a publishable key.",
        },
        { status: 503 },
      ),
    };
  }

  const supabase = createClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const hotelId = await resolveAccessibleHotelId(supabase);
  if (!hotelId) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "No accessible hotel. Ask an administrator for membership, or set a default hotel for local dev.",
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, supabase, hotelId };
}
