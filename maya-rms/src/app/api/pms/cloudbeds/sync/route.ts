/**
 * POST /api/pms/cloudbeds/sync — manual single-hotel Cloudbeds sync.
 *
 * Parity with POST /api/pms/mews/sync: Revenue Manager and up may trigger it.
 * The pipeline itself runs on the service-role client — the Vault credential
 * RPCs are service-role-only since the RLS hardening, and the pms_connections
 * status stamp is GM-gated under RLS, so a user-scoped run would fail before
 * the first fetch. The rank gate above the client swap is the authorization.
 * Useful for the admin "Test/Sync" button and debugging. Cron uses the Edge
 * Function instead.
 */

import { runCloudbedsSyncForHotel } from "@/lib/cloudbeds/sync-hotel";
import { requireEntitledHotel } from "@/lib/billing/require-entitled";
import { requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = { daysBack?: number; daysForward?: number };

export async function POST(req: Request) {
  try {
    const ctx = await requireSupabaseHotelRank(await cookies(), "revenue_manager");
    if (!ctx.ok) return ctx.response;

    const paid = await requireEntitledHotel(ctx.supabase, ctx.hotelId);
    if (!paid.ok) return paid.response;

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

    const result = await runCloudbedsSyncForHotel(createAdminClient(), ctx.hotelId, {
      daysBack: body.daysBack,
      daysForward: body.daysForward,
    });

    if (!result.ok) {
      if (result.cloudbedsStatus != null) {
        const status = result.cloudbedsStatus >= 500 ? 502 : 400;
        return NextResponse.json(
          {
            ok: false,
            error: result.error,
            cloudbedsStatus: result.cloudbedsStatus,
            ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
          },
          { status },
        );
      }
      const looksLikeCredential = /credentials|OAuth|token|propertyID/i.test(result.error);
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: looksLikeCredential ? 400 : 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      fetchWindow: result.fetchWindow,
      apiPages: result.apiPages,
      roomTypesUpserted: result.roomTypesUpserted,
      reservationRowsUpserted: result.reservationRowsUpserted,
      ingest: result.ingest,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloudbeds sync failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
