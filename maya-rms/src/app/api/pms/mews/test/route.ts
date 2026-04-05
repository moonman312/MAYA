import { mewsConfigurationGet } from "@/lib/mews/client";
import { requireSupabaseHotel } from "@/lib/require-supabase-hotel";
import { resolveMewsCredentials, summarizeEnterprise } from "@/lib/mews/resolve-credentials";
import type { MewsCredentialsInput } from "@/lib/mews/types";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type Body = {
  mews?: MewsCredentialsInput;
};

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

    const resolved = await resolveMewsCredentials(ctx.supabase, ctx.hotelId, body.mews ?? null);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }

    const config = (await mewsConfigurationGet(resolved.creds)) as Record<string, unknown>;
    const enterprise = summarizeEnterprise(config);

    if (resolved.connectionId) {
      await ctx.supabase
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
