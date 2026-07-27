import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient as createSSRClient } from "@/utils/supabase/server";
import { MAYA_ACTIVE_HOTEL_COOKIE } from "@/lib/hotel-context";
import { createOnboardingAdapter } from "@/lib/pms/onboarding-adapter";
import type { PmsType } from "@/lib/pms/registry";
import type { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export type OnboardingTokens = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: unknown;
  expiresAt: string;
};

/**
 * Finish the onboarding OAuth callback: the user has no hotel yet, so we
 * create everything from PMS data — hotel, membership, settings, connection —
 * then queue the background import and send them to the questions step.
 *
 * The PMS is the source of truth: name, timezone, and currency come from
 * discoverProperty(). The user is asked for nothing; they can rename the
 * property later (user input wins).
 */
export async function handleOnboardingConnect(
  cookieStore: CookieStore,
  pmsType: PmsType,
  stateUserId: string,
  tokens: OnboardingTokens,
): Promise<Response> {
  // The callback is a browser redirect, so the session cookie is present.
  // Refuse states replayed by a different (or absent) session.
  const ssr = createSSRClient(cookieStore);
  const {
    data: { user },
  } = await ssr.auth.getUser();
  if (!user || user.id !== stateUserId) {
    return onboardingError(
      "This connection link belongs to a different account. Please sign in and try again.",
    );
  }

  const admin = createAdminClient();

  // 1. Ask the PMS who this property is. The adapter takes freshly-minted
  //    tokens directly (the Vault secret doesn't exist yet — no hotel does).
  //    The throwaway id only scopes reads that return nothing pre-creation.
  const preResolved = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    propertyId: null as string | null,
  };
  let profile;
  try {
    const probe = await createOnboardingAdapter(admin, randomUUID(), pmsType, preResolved);
    profile = await probe.discoverProperty();
  } catch (e) {
    return onboardingError(
      `We connected to your account but couldn't read your property details: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 2. Create the hotel. PMS name first; suffix on collision so creation
  //    never blocks (hotels.name is globally unique). User can rename later.
  const baseName = profile.name?.trim() || "My Property";
  let hotelId: string | null = null;
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
    const { data, error } = await admin
      .from("hotels")
      .insert({
        name,
        timezone: profile.timezone ?? "UTC",
        currency: profile.currency ?? "USD",
        external_enterprise_id: null,
        is_active: true,
      })
      .select("id")
      .single();
    if (!error && data) {
      hotelId = String(data.id);
      break;
    }
    lastErr = error?.message ?? "unknown insert error";
    if (error?.code !== "23505") break; // only retry unique-name collisions
  }
  if (!hotelId) {
    return onboardingError(`Could not create your property: ${lastErr}`);
  }

  // 3. Membership: service role means auth.uid() is null, so the
  //    auto-membership trigger won't fire — insert explicitly.
  const { error: memberErr } = await admin.from("hotel_memberships").insert({
    hotel_id: hotelId,
    user_id: user.id,
    role: "hotel_admin",
    status: "active",
  });
  if (memberErr) {
    return onboardingError(`Could not link you to your property: ${memberErr.message}`);
  }

  // 4. Settings (simulation mode ON — nothing touches live rates until the
  //    user deliberately flips it).
  await admin.from("hotel_settings").upsert(
    {
      hotel_id: hotelId,
      pricing_horizon_days: 365,
      pickup_window_cycles: 1,
      simulation_mode: true,
      rounding_mode: "none",
    },
    { onConflict: "hotel_id" },
  );

  // 5. Tokens into Vault (now that the hotel exists), incl. discovered
  //    property id so the worker skips re-discovery.
  const { error: secretErr } = await admin.rpc("pms_secret_set", {
    p_hotel_id: hotelId,
    p_pms_type: pmsType,
    p_secret: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      scope: tokens.scope,
      expiresAt: tokens.expiresAt,
      propertyId: preResolved.propertyId ?? profile.externalPropertyId ?? null,
    },
  });
  if (secretErr) {
    return onboardingError(`Could not store your connection securely: ${secretErr.message}`);
  }

  const now = new Date().toISOString();
  await admin.from("pms_connections").upsert(
    {
      hotel_id: hotelId,
      pms_type: pmsType,
      status: "connected",
      last_tested_at: now,
      updated_at: now,
    },
    { onConflict: "hotel_id,pms_type" },
  );

  // 6. Queue the background import + onboarding state.
  const { data: job } = await admin
    .from("import_jobs")
    .insert({
      hotel_id: hotelId,
      pms_type: pmsType,
      status: "queued",
      phase: "discover",
      requested_by: user.id,
    })
    .select("id")
    .single();

  await admin.from("onboarding_states").upsert(
    {
      hotel_id: hotelId,
      path: "guided",
      import_job_id: job?.id ?? null,
      connected_at: now,
    },
    { onConflict: "hotel_id" },
  );

  await admin.rpc("platform_log_event", {
    p_event_type: "onboarding.pms_connected",
    p_entity_type: "pms_connection",
    p_entity_id: hotelId,
    p_hotel_id: hotelId,
    p_detail: { pms_type: pmsType, via: "onboarding_oauth" },
  });

  // 7. Nudge the worker so the import starts immediately; pg_cron is the
  //    guaranteed driver if this fetch is dropped.
  kickImportWorker();

  // 8. Off to the questions, with the active-hotel cookie set.
  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "") ?? "";
  const res = NextResponse.redirect(`${base}/onboarding/questions`, { status: 302 });
  res.cookies.set(MAYA_ACTIVE_HOTEL_COOKIE, hotelId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return res;
}

function kickImportWorker(): void {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.ONBOARDING_CRON_SECRET;
  if (!supabaseUrl || !secret) return;
  fetch(`${supabaseUrl}/functions/v1/onboarding-import-worker`, {
    method: "POST",
    headers: { "x-onboarding-cron-secret": secret },
  }).catch(() => {
    // Cron picks the job up within a minute.
  });
}

function onboardingError(message: string): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Connection problem</title></head>
<body style="font-family: system-ui, sans-serif; background: #020617; color: #e2e8f0; padding: 3rem;">
  <h1 style="font-size:1.25rem">We hit a snag connecting your property</h1>
  <p style="color:#94a3b8;max-width:36rem;line-height:1.6">${message.replace(/</g, "&lt;")}</p>
  <p><a href="/onboarding/connect" style="color:#38bdf8">Try again</a></p>
</body></html>`;
  return new Response(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
