import { mewsConfigurationGet } from "@/lib/mews/client";
import { requireSupabaseHotelRank } from "@/lib/require-supabase-hotel";
import { resolveMewsCredentials, summarizeEnterprise } from "@/lib/mews/resolve-credentials";
import type { MewsCredentialsInput } from "@/lib/mews/types";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = {
  mews?: MewsCredentialsInput;
};

export async function POST(req: Request) {
  try {
    const ctx = await requireSupabaseHotelRank(await cookies(), "revenue_manager");
    if (!ctx.ok) return ctx.response;

    if (!isAdminConfigured()) {
      return NextResponse.json(
        { error: "Connection test needs SUPABASE_SERVICE_ROLE_KEY set on the server." },
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
    const admin = createAdminClient();
    const resolved = await resolveMewsCredentials(admin, ctx.hotelId, body.mews ?? null);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }

    const config = (await mewsConfigurationGet(resolved.creds)) as Record<string, unknown>;
    const enterprise = summarizeEnterprise(config);

    if (resolved.connectionId) {
      await admin
        .from("pms_connections")
        .update({
          status: "connected",
          last_tested_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", resolved.connectionId);
    }

    return NextResponse.json({
      ok: true,
      enterprise,
      credentialSource: resolved.source,
      connectionUpdated: Boolean(resolved.connectionId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mews test failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
