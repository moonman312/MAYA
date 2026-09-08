import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { roleLabel, roleRank, type HotelRole } from "@/lib/roles";
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

/**
 * Whether the caller holds `minRole` or higher at this hotel. Membership-less
 * platform operators pass via is_platform_admin (self-scoped since the
 * helpers lockdown).
 */
export async function hasHotelRank(
  supabase: SupabaseClient,
  hotelId: string,
  minRole: HotelRole,
): Promise<boolean> {
  // Cookie read only — requireSupabaseHotel already ran getUser() for this
  // request, and repeat auth round-trips trip the rate limiter (see
  // hotel-context.ts).
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return false;

  // Must filter on user_id: the select policy lets any member read the whole
  // hotel's membership list, not just their own row.
  const { data: rows, error } = await supabase
    .from("hotel_memberships")
    .select("role")
    .eq("hotel_id", hotelId)
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) return false;

  const best = Math.max(-1, ...(rows ?? []).map((r) => roleRank(String(r.role))));
  if (best >= roleRank(minRole)) return true;

  const { data: isAdmin } = await supabase.rpc("is_platform_admin");
  return Boolean(isAdmin);
}

/** requireSupabaseHotel plus a rank floor; 403 below it. */
export async function requireSupabaseHotelRank(
  cookieStore: CookieStore,
  minRole: HotelRole,
): Promise<{ ok: true } & SupabaseHotelContext | { ok: false; response: NextResponse }> {
  const ctx = await requireSupabaseHotel(cookieStore);
  if (!ctx.ok) return ctx;

  if (!(await hasHotelRank(ctx.supabase, ctx.hotelId, minRole))) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This needs ${roleLabel(minRole)} access or higher on this property.` },
        { status: 403 },
      ),
    };
  }

  return ctx;
}
