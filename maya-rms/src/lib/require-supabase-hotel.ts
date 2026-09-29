import { GOD_MODE_OFF } from "@/lib/admin/god-mode";
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
  /** The signed-in person, as the auth service verified them. */
  userId: string;
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
        { error: "You don't have access to this property." },
        { status: 400 },
      ),
    };
  }

  return { ok: true, supabase, hotelId, userId: user.id };
}

/**
 * Whether the caller holds `minRole` or higher at this hotel. A platform
 * admin with no membership passes only in God Mode (god_mode_active(),
 * decided by the database from their verified token and open window).
 */
export async function hasHotelRank(
  supabase: SupabaseClient,
  hotelId: string,
  minRole: HotelRole,
): Promise<boolean> {
  // Verified by the auth service, not read off the cookie: the browser can
  // edit the cookie, and the select policy lets any member read every
  // membership row of their hotel, so a Viewer could otherwise pass this
  // check under a General Manager's id.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id;
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

  const { data: active } = await supabase.rpc("god_mode_active");
  return active === true;
}

/**
 * requireSupabaseHotel plus a rank floor; 403 below it. A platform admin
 * outside God Mode is told how to turn it on rather than which role they
 * lack.
 */
export async function requireSupabaseHotelRank(
  cookieStore: CookieStore,
  minRole: HotelRole,
): Promise<{ ok: true } & SupabaseHotelContext | { ok: false; response: NextResponse }> {
  const ctx = await requireSupabaseHotel(cookieStore);
  if (!ctx.ok) return ctx;

  if (!(await hasHotelRank(ctx.supabase, ctx.hotelId, minRole))) {
    const { data: isAdmin } = await ctx.supabase.rpc("is_platform_admin");
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            isAdmin === true
              ? GOD_MODE_OFF
              : `This needs ${roleLabel(minRole)} access or higher on this property.`,
        },
        { status: 403 },
      ),
    };
  }

  return ctx;
}
