/**
 * God Mode for platform admins: GET says whether it is on for the caller and
 * until when (the banner reads this on every page, so it costs nothing for
 * everyone else), POST opens a window, DELETE closes it.
 *
 * Everything runs through the caller's own session client: the database
 * functions decide from the verified token (a platform admin, and aal2 after
 * a code from their authenticator app) and never from anything sent here.
 */

import { godModeStatus } from "@/lib/admin/god-mode";
import { resolveAccessibleHotelId } from "@/lib/hotel-context";
import { createClient } from "@/utils/supabase/server";
import { isSupabaseConfigured } from "@/utils/supabase/shared";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const off = () => NextResponse.json({ admin: false }, NO_STORE);

export async function GET() {
  if (!isSupabaseConfigured()) return off();
  const supabase = createClient(await cookies());
  // A cookie read, no auth round-trip: nobody signed in means nothing to say,
  // and for everyone else the one RPC below carries the verified token.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return off();

  const status = await godModeStatus(supabase);
  if (!status.admin) return off();

  // The property the admin is looking at, for the banner's wording.
  let hotel: { id: string; name: string } | null = null;
  if (status.active) {
    const hotelId = await resolveAccessibleHotelId(supabase);
    if (hotelId) {
      const { data } = await supabase.from("hotels").select("id, name").eq("id", hotelId).maybeSingle();
      if (data?.id) hotel = { id: String(data.id), name: String(data.name) };
    }
  }

  return NextResponse.json(
    {
      admin: true,
      aal: status.aal,
      active: status.active,
      sessionId: status.sessionId,
      startedAt: status.startedAt,
      expiresAt: status.expiresAt,
      hotel,
    },
    NO_STORE,
  );
}

/** What the person is told when the database refused, or has no God Mode yet. */
function refusal(error: { code?: string; message?: string }, fallback: string): NextResponse {
  if (error.code === "42501") {
    return NextResponse.json({ error: error.message ?? fallback }, { status: 403, ...NO_STORE });
  }
  if (error.code === "PGRST202" || error.code === "42883") {
    return NextResponse.json({ error: "God Mode isn't set up on this database yet." }, { status: 503, ...NO_STORE });
  }
  console.error(JSON.stringify({ fn: "api/admin/god-mode", code: error.code, error: error.message }));
  return NextResponse.json({ error: fallback }, { status: 500, ...NO_STORE });
}

export async function POST() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase.rpc("god_mode_start");
  if (error) return refusal(error, "Could not turn on God Mode. Try again in a moment.");
  const row = (data ?? {}) as Record<string, unknown>;
  return NextResponse.json(
    {
      ok: true,
      active: true,
      sessionId: typeof row.id === "string" ? row.id : null,
      startedAt: typeof row.started_at === "string" ? row.started_at : null,
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    },
    NO_STORE,
  );
}

export async function DELETE() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }
  const supabase = createClient(await cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase.rpc("god_mode_end");
  if (error) return refusal(error, "Could not turn off God Mode. Try again in a moment.");
  return NextResponse.json({ ok: true, active: false }, NO_STORE);
}
