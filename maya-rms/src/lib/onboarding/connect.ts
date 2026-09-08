import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient as createSSRClient } from "@/utils/supabase/server";
import { findPendingHotelForUser } from "@/lib/billing/pending-hotel";
import { isStripeConfigured } from "@/lib/billing/stripe";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
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
 * Finish the onboarding OAuth callback: fill in everything from PMS data —
 * hotel, membership, settings, connection — then queue the background import and
 * send them on to the one choice left to make.
 *
 * The hotel row usually already exists: payment is the first step of onboarding
 * and a Stripe subscription needs a hotel_id to attach to, so checkout creates a
 * placeholder that this adopts and renames. When billing isn't configured there
 * is nothing to adopt and it creates one outright.
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

  // Checked here as well as at the authorize endpoint, because a signed state is
  // replayable for its whole lifetime — someone who reached this callback once
  // while entitled could otherwise re-run it later to mint further properties.
  // Cheap, and the alternative is a free hotel.
  if ((await resolveOnboardingStep(ssr)) !== "connect") {
    return onboardingError("Payment is needed before connecting a PMS.");
  }

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

  // 2. The hotel row. Payment comes before this step now, and checkout had to
  //    name a hotel for the subscription to attach to — so adopt the row it
  //    created rather than making a second one beside the one they paid for
  //    (lib/billing/pending-hotel.ts). PMS name first; suffix on collision so
  //    this never blocks (hotels.name is globally unique). User can rename later.
  const pendingHotelId = await findPendingHotelForUser(admin, user.id);

  // Creating a hotel outright is only ever right when there was no payment to
  // attach one to. On a deployment that CAN charge, reaching here without a
  // pending row means checkout never happened, and minting one anyway is how a
  // property ends up live having paid nothing. Structural rather than a check, so
  // no future edit to the guard above can quietly re-open it.
  if (!pendingHotelId && isStripeConfigured()) {
    return onboardingError("We couldn't find your subscription. Please start again from billing.");
  }

  const baseName = profile.name?.trim() || "My Property";
  let hotelId: string | null = null;
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
    const fields = {
      name,
      timezone: profile.timezone ?? "UTC",
      currency: profile.currency ?? "USD",
    };
    // Deliberately NOT clearing setup_pending_at or activating here. Everything
    // below this point can still fail — the Vault write especially — and
    // resolveOnboardingStep reads an active property as "connect already
    // finished". Flipping it up front meant a failed Vault write left a hotel
    // that had paid looking fully set up, on a dashboard with no PMS behind it
    // and no route back into this flow. Both flips happen at the end, once the
    // connection actually exists.
    const { data, error } = pendingHotelId
      ? await admin
          .from("hotels")
          .update(fields)
          .eq("id", pendingHotelId)
          .select("id")
          .single()
      : await admin
          .from("hotels")
          .insert({ ...fields, is_active: true, external_enterprise_id: null })
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
    console.error(
      JSON.stringify({ fn: "handleOnboardingConnect", step: "hotel_row", hotel: pendingHotelId, error: lastErr }),
    );
    return onboardingError("Could not create your property. Try again in a moment.");
  }

  // 3. Membership: service role means auth.uid() is null, so the
  //    auto-membership trigger won't fire — write it explicitly. Upsert because
  //    an adopted row already has one from checkout.
  const { error: memberErr } = await admin.from("hotel_memberships").upsert(
    {
      hotel_id: hotelId,
      user_id: user.id,
      role: "hotel_admin",
      status: "active",
    },
    { onConflict: "hotel_id,user_id" },
  );
  if (memberErr) {
    console.error(
      JSON.stringify({ fn: "handleOnboardingConnect", step: "membership", hotel: hotelId, error: memberErr.message }),
    );
    return onboardingError("Could not link you to your property. Try again in a moment.");
  }

  // 4. Settings (simulation mode ON — nothing touches live rates until the
  //    user deliberately flips it). Checked, because a hotel with no settings
  //    row reaches the dashboard and then cannot be taken live at all: the
  //    go-live path reads simulation_mode and 403s on a row that isn't there,
  //    with nothing on screen explaining why.
  const { error: settingsErr } = await admin.from("hotel_settings").upsert(
    {
      hotel_id: hotelId,
      pricing_horizon_days: 365,
      pickup_window_cycles: 1,
      simulation_mode: true,
      rounding_mode: "none",
    },
    { onConflict: "hotel_id" },
  );
  if (settingsErr) {
    console.error(
      JSON.stringify({ fn: "handleOnboardingConnect", step: "settings", hotel: hotelId, error: settingsErr.message }),
    );
    return onboardingError("Could not set up your pricing settings. Try again in a moment.");
  }

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
    console.error(
      JSON.stringify({ fn: "handleOnboardingConnect", step: "store_secret", hotel: hotelId, error: secretErr.message }),
    );
    return onboardingError("Could not store your connection securely. Try again in a moment.");
  }

  const now = new Date().toISOString();
  const { error: connErr } = await admin.from("pms_connections").upsert(
    {
      hotel_id: hotelId,
      pms_type: pmsType,
      status: "connected",
      last_tested_at: now,
      updated_at: now,
    },
    { onConflict: "hotel_id,pms_type" },
  );
  if (connErr) {
    console.error(
      JSON.stringify({ fn: "handleOnboardingConnect", step: "connection_row", hotel: hotelId, error: connErr.message }),
    );
    return onboardingError("Could not record your connection. Try again in a moment.");
  }

  // The connection is real, so the property becomes one. Until this line a
  // failure anywhere above leaves the row pending, which is what sends the owner
  // back here instead of to a dashboard that cannot price anything.
  const { error: activateErr } = await admin
    .from("hotels")
    .update({ is_active: true, setup_pending_at: null })
    .eq("id", hotelId);
  if (activateErr) {
    console.error(
      JSON.stringify({ fn: "handleOnboardingConnect", step: "activate", hotel: hotelId, error: activateErr.message }),
    );
    return onboardingError("Could not finish setting up your property. Try again in a moment.");
  }

  // 6. Queue the background import + onboarding state.
  //
  // Not fatal from here on: they have paid, connected, and the property is live.
  // Failing the whole callback over the import queue would send them back to a
  // connect screen for a connection that already works. But it must be LOUD —
  // silently, this is a hotel that sits on the progress page forever waiting for
  // an import that was never queued.
  const { data: job, error: jobErr } = await admin
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
  if (jobErr) {
    console.error(
      JSON.stringify({ fn: "handleOnboardingConnect", step: "queue_import", hotel: hotelId, error: jobErr.message }),
    );
  }

  const { error: stateErr } = await admin.from("onboarding_states").upsert(
    {
      hotel_id: hotelId,
      path: "guided",
      import_job_id: job?.id ?? null,
      connected_at: now,
    },
    { onConflict: "hotel_id" },
  );
  if (stateErr) {
    console.error(
      JSON.stringify({ fn: "handleOnboardingConnect", step: "onboarding_state", hotel: hotelId, error: stateErr.message }),
    );
  }

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

  // 8. Off to the last choice — hold my hand, or let me drive — with the
  //    active-hotel cookie set. The questions used to come straight after this;
  //    they now sit behind that choice, because the import is running either way.
  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "") ?? "";
  const res = NextResponse.redirect(`${base}/onboarding`, { status: 302 });
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

/**
 * Read by a customer who has just paid, so callers keep driver text in the
 * server log and pass a plain sentence — PostgREST and Vault name their
 * functions and tables in error messages.
 */
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
