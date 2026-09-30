/**
 * What every Settings route shares: a signed-in person on a property, and,
 * for the property-wide sections, whether they may change them. Property-wide
 * settings take the same check as rules and manual prices, can_manage_hotel()
 * (Revenue Manager and up; a platform admin only in God Mode), and the
 * database's row level security takes it again on the write.
 */

import { GOD_MODE_OFF } from "@/lib/admin/god-mode";
import { requireSupabaseHotel, type SupabaseHotelContext } from "@/lib/require-supabase-hotel";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** Said to anyone below Revenue Manager, beside the property's settings. */
export const PROPERTY_SETTINGS_FORBIDDEN = "Only a Revenue Manager or above can change these.";

/** Local demo mode, with no database to save to. */
export const SETTINGS_NEED_A_PROPERTY = "Settings can be saved once a property is connected.";

export type SettingsContext = { ok: true } & SupabaseHotelContext;

export async function settingsContext(): Promise<SettingsContext | { ok: false; response: NextResponse }> {
  if (!isSupabaseConfigured()) {
    return { ok: false, response: NextResponse.json({ error: SETTINGS_NEED_A_PROPERTY }, { status: 501 }) };
  }
  return requireSupabaseHotel(await cookies());
}

/**
 * Null when this person may change the property's settings, otherwise the
 * sentence that says why not: a platform admin outside God Mode is told how
 * to turn it on rather than which role they lack.
 */
export async function propertyEditRefusal(ctx: SupabaseHotelContext): Promise<string | null> {
  const { data: canManage } = await ctx.supabase.rpc("can_manage_hotel", { target_hotel_id: ctx.hotelId });
  if (canManage === true) return null;
  let isAdmin = false;
  try {
    const { data } = await ctx.supabase.rpc("is_platform_admin");
    isAdmin = data === true;
  } catch {
    // Reads as a member's refusal.
  }
  return isAdmin ? GOD_MODE_OFF : PROPERTY_SETTINGS_FORBIDDEN;
}

export async function readBody(req: Request): Promise<unknown> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return null;
  }
}
