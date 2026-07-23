/**
 * POST /api/pms/cloudbeds/sync — manual single-hotel Cloudbeds sync.
 *
 * Parity with POST /api/pms/mews/sync: uses the user-scoped Supabase client
 * (RLS applies; caller must be able to manage the active hotel), resolves the
 * OAuth secret from Vault, runs the shared Cloudbeds pipeline. Useful for the
 * admin "Test/Sync" button and debugging. Cron uses the Edge Function instead.
 */

import { runCloudbedsSyncForHotel } from "@/lib/cloudbeds/sync-hotel";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = { daysBack?: number; daysForward?: number };

export async function POST(req: Request) {
  try {
    const ctx = await requireSupabaseHotel(await cookies());
    if (!ctx.ok) return ctx.response;

    let body: Body = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text) as Body;
    } catch {
      body = {};
    }

    const result = await runCloudbedsSyncForHotel(ctx.supabase, ctx.hotelId, {
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

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloudbeds sync failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
