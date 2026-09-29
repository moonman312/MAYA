/**
 * The door every manual price write goes through: setting a price, clearing
 * it, and asking for one more send of a price the property system refused
 * (./retry). One gate so the three can never drift apart on who may do it or
 * how often.
 */

import { isUuid } from "@/lib/api-guards";
import { enforceRateLimit } from "@/lib/rate-limit";
import { roleLabel } from "@/lib/roles";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export type Gate =
  | { ok: true; userId: string; admin: SupabaseClient; supabase: SupabaseClient }
  | { ok: false; response: NextResponse };

export function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function readBody<T>(req: Request): Promise<T> {
  try {
    const text = await req.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

/**
 * Sign-in, hotel rank, service-role availability, and the per-user budget —
 * in that order, so a signed-out caller can't spend rate-limit hits and a
 * viewer can't learn whether the server is fully configured.
 */
export async function gate(hotelId: unknown): Promise<Gate> {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Supabase is required to set a manual price." },
        { status: 501 },
      ),
    };
  }

  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (typeof hotelId !== "string" || !isUuid(hotelId)) {
    return { ok: false, response: bad("Pick a property first.") };
  }

  const { data: canManage } = await supabase.rpc("can_manage_hotel", {
    target_hotel_id: hotelId,
  });
  if (!canManage) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This needs ${roleLabel("revenue_manager")} access or higher on this property.` },
        { status: 403 },
      ),
    };
  }

  const throttled = await enforceRateLimit(
    "manualPrice",
    user.id,
    "That's a lot of price changes at once. Give it a minute and try again.",
  );
  if (throttled) return { ok: false, response: throttled };

  if (!isAdminConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Manual prices need SUPABASE_SERVICE_ROLE_KEY set on the server." },
        { status: 503 },
      ),
    };
  }

  return { ok: true, userId: user.id, admin: createAdminClient(), supabase };
}
