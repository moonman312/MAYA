import type { MewsCredentialsInput } from "@/lib/mews/types";
import { runMewsSyncForHotel } from "@/lib/mews/sync-hotel";
import { requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = {
  mews?: MewsCredentialsInput;
  daysBack?: number;
  daysForward?: number;
};

export async function POST(req: Request) {
  try {
    const ctx = await requireSupabaseHotelRank(await cookies(), "revenue_manager");
    if (!ctx.ok) return ctx.response;

    if (!isAdminConfigured()) {
      return NextResponse.json(
        { error: "Manual sync needs SUPABASE_SERVICE_ROLE_KEY set on the server." },
        { status: 503 },
      );
    }

    let body: Body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text) as Body;
    } catch {
      body = {};
    }

    // Service-role client: pms_secret_get is service-role-only and the
    // pms_connections stamp is GM-gated under RLS. The rank gate above is
    // the authorization.
    const result = await runMewsSyncForHotel(createAdminClient(), ctx.hotelId, {
      mews: body.mews ?? null,
      daysBack: body.daysBack,
      daysForward: body.daysForward,
    });

    if (!result.ok) {
      if (result.mewsStatus != null) {
        const status = result.mewsStatus >= 500 ? 502 : 400;
        return NextResponse.json(
          {
            ok: false,
            error: result.error,
            mewsStatus: result.mewsStatus,
            ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
          },
          { status },
        );
      }
      const looksLikeCredential = /No Mews credentials|credentials/i.test(result.error);
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: looksLikeCredential ? 400 : 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      fetchWindowUtc: result.fetchWindowUtc,
      apiWindows: result.apiWindows,
      roomTypesUpserted: result.roomTypesUpserted,
      reservationRowsUpserted: result.reservationRowsUpserted,
      ingest: result.ingest,
      credentialSource: result.credentialSource,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mews sync failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
