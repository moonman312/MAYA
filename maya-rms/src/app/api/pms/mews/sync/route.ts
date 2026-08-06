import type { MewsCredentialsInput } from "@/lib/mews/types";
import { runMewsSyncForHotel } from "@/lib/mews/sync-hotel";
import { requireEntitledHotel } from "@/lib/billing/require-entitled";
import { enforceRateLimit } from "@/lib/rate-limit";
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

    const paid = await requireEntitledHotel(ctx.supabase, ctx.hotelId);
    if (!paid.ok) return paid.response;

    // Every manual sync spends this hotel's own PMS allowance, and
    // exhausting that is what gets credentials suspended. Keyed on the
    // hotel rather than the user: three managers each clicking twice is
    // the same load on Cloudbeds as one manager clicking six times.
    const throttled = await enforceRateLimit("pmsSync", ctx.hotelId,
      "You've triggered a lot of syncs. Bookings also sync automatically every few minutes.");
    if (throttled) return throttled;

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

    const admin = createAdminClient();

    // The request counter above bounds how often; this bounds how many at
    // once. It is the same lease the scheduled worker claims, so a second
    // press — or a press during a cron tick — is told a sync is already
    // running instead of starting a concurrent one on the same connection.
    // 'missing' (no connection row — body/env credentials) runs unleased:
    // there is nothing to hold.
    const { data: claim, error: claimErr } = await admin.rpc("claim_pms_sync_one", {
      p_hotel_id: ctx.hotelId,
      p_pms_type: "mews",
      p_lease_seconds: 600,
      p_owner: "manual",
    });
    if (claimErr) {
      return NextResponse.json(
        { ok: false, error: "Could not start the sync — try again in a moment." },
        { status: 503 },
      );
    }
    if (claim === "busy") {
      return NextResponse.json(
        { ok: false, error: "A sync for this hotel is already running. Give it a minute to finish." },
        { status: 409 },
      );
    }
    const releaseClaim = async (ok: boolean) => {
      if (claim !== "claimed") return;
      const { error: releaseErr } = await admin.rpc("release_pms_sync", {
        p_hotel_id: ctx.hotelId,
        p_pms_type: "mews",
        p_ok: ok,
      });
      if (releaseErr) {
        // Not fatal: the lease expires on its own.
        console.error(
          JSON.stringify({ fn: "mews-manual-sync", step: "release", hotelId: ctx.hotelId, error: releaseErr.message }),
        );
      }
    };

    // Service-role client: pms_secret_get is service-role-only and the
    // pms_connections stamp is GM-gated under RLS. The rank gate above is
    // the authorization.
    let result: Awaited<ReturnType<typeof runMewsSyncForHotel>>;
    try {
      result = await runMewsSyncForHotel(admin, ctx.hotelId, {
        mews: body.mews ?? null,
        daysBack: body.daysBack,
        daysForward: body.daysForward,
      });
    } catch (error) {
      await releaseClaim(false);
      throw error;
    }
    await releaseClaim(result.ok);

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
