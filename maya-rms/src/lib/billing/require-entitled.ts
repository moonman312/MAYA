import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isHotelEntitled } from "./entitlement";

/**
 * Refuses work for a hotel whose subscription has lapsed.
 *
 * The scheduled sync already skips these hotels, so this only closes the
 * hand-triggered doors that would otherwise let a lapsed property keep pulling
 * its PMS and repricing on demand. 402 rather than 403: nothing is wrong with
 * who they are, only with what they owe, and the client can tell the two apart
 * to decide whether to send them to billing or to their administrator.
 */
export async function requireEntitledHotel(
  supabase: SupabaseClient,
  hotelId: string,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  if (await isHotelEntitled(supabase, hotelId)) return { ok: true };

  return {
    ok: false,
    response: NextResponse.json(
      {
        error: "This property's subscription is not active, so MAYA has paused work on it.",
        billingUrl: "/account/billing",
      },
      { status: 402 },
    ),
  };
}
