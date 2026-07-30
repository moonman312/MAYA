import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient as createSSRClient } from "@/utils/supabase/server";
import { handleOnboardingConnect } from "@/lib/onboarding/connect";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
import { pmsCallbackUrl, requireRegistry, type PmsType } from "@/lib/pms/registry";
import { signOnboardingState, signState, verifyState } from "@/lib/pms/oauth-state";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Who the OAuth dance is for:
 * - hotel: admin connecting an existing hotel (requires manage rights).
 * - onboarding: a new user with no hotel — any authenticated session;
 *   the callback creates the hotel from PMS data.
 */
export type OAuthTarget =
  | { kind: "hotel"; hotelId: string }
  | { kind: "onboarding" };

/**
 * Build the vendor's authorize URL for `pmsType`, signing state so the callback
 * can verify hotel_id + protect against CSRF. Called from GET routes on
 * /api/pms/{cloudbeds,think}/connect.
 */
export async function buildAuthorizeRedirect(
  cookieStore: CookieStore,
  pmsType: PmsType,
  target: OAuthTarget,
): Promise<Response> {
  const ssr = createSSRClient(cookieStore);
  const {
    data: { user },
  } = await ssr.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (target.kind === "hotel") {
    const { data: isAdmin } = await ssr.rpc("is_platform_admin", { p_user_id: user.id });
    const { data: canManage } = await ssr.rpc("can_manage_hotel", {
      target_hotel_id: target.hotelId,
    });
    if (!isAdmin && !canManage) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    // The paywall. Connecting a PMS is what turns a signup into a working
    // property, so this endpoint is the thing payment actually gates — and it
    // used to gate nothing but having an account, which /login hands out freely.
    // Anyone who knew this URL got a permanent property for nothing.
    //
    // resolveOnboardingStep is asked rather than re-deriving it here: it is
    // already the one agreed reading of where someone is in the flow, including
    // the deliberate escape hatch for deployments with no Stripe keys. A fourth
    // independent opinion about whether they have paid is how this got missed.
    if ((await resolveOnboardingStep(ssr)) !== "connect") {
      return NextResponse.json(
        { error: "Payment is needed before connecting a PMS.", billingUrl: "/onboarding" },
        { status: 402 },
      );
    }
  }

  const registry = requireRegistry(pmsType);
  if (registry.authKind !== "oauth2_authorization_code") {
    return NextResponse.json(
      { error: `${registry.displayName} does not use OAuth` },
      { status: 400 },
    );
  }

  const clientIdEnv = registry.requiredEnvVars.find((v) => v.endsWith("_CLIENT_ID"));
  const clientId = clientIdEnv ? process.env[clientIdEnv] : null;
  if (!clientId) {
    return NextResponse.json(
      {
        error:
          `${registry.displayName} is not configured on this deployment. ` +
          `Set ${registry.requiredEnvVars.join(", ")}, then try again.`,
      },
      { status: 503 },
    );
  }

  const state =
    target.kind === "onboarding"
      ? signOnboardingState(user.id, pmsType)
      : signState(target.hotelId, pmsType);
  const redirectUri = pmsCallbackUrl(pmsType);

  const url = new URL(registry.authorizeUrl!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  if (registry.scopes?.length) {
    url.searchParams.set("scope", registry.scopes.join(" "));
  }
  if (registry.audience) {
    url.searchParams.set("audience", registry.audience);
  }

  return NextResponse.redirect(url.toString(), { status: 302 });
}

/**
 * Handle the callback from the vendor. Verifies state, exchanges code for
 * tokens via the standard OAuth2 token endpoint, stores everything in Vault
 * via `pms_secret_set`, and redirects to the hotel detail page.
 */
export async function handleOAuthCallback(
  cookieStore: CookieStore,
  pmsType: PmsType,
  searchParams: URLSearchParams,
): Promise<Response> {
  const errorParam = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (errorParam) {
    return renderCallbackError(
      pmsType,
      `${errorParam}: ${searchParams.get("error_description") ?? "vendor returned an error"}`,
    );
  }
  if (!code || !state) {
    return renderCallbackError(pmsType, "Missing `code` or `state` from vendor.");
  }

  const verified = verifyState(state, pmsType);
  if (!verified.ok) {
    return renderCallbackError(pmsType, `State verification failed: ${verified.error}`);
  }

  const registry = requireRegistry(pmsType);
  const clientIdEnv = registry.requiredEnvVars.find((v) => v.endsWith("_CLIENT_ID"));
  const clientSecretEnv = registry.requiredEnvVars.find((v) => v.endsWith("_CLIENT_SECRET"));
  const clientId = clientIdEnv ? process.env[clientIdEnv] : null;
  const clientSecret = clientSecretEnv ? process.env[clientSecretEnv] : null;
  if (!clientId || !clientSecret) {
    return renderCallbackError(pmsType, `${registry.displayName} not configured on this deployment.`);
  }

  const redirectUri = pmsCallbackUrl(pmsType);

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  if (registry.audience) tokenBody.set("audience", registry.audience);

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(registry.tokenUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
  } catch (err) {
    return renderCallbackError(
      pmsType,
      `Token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tokenText = await tokenResponse.text();
  let tokenJson: Record<string, unknown>;
  try {
    tokenJson = JSON.parse(tokenText) as Record<string, unknown>;
  } catch {
    return renderCallbackError(
      pmsType,
      `Non-JSON response from token endpoint (${tokenResponse.status}): ${tokenText.slice(0, 200)}`,
    );
  }

  if (!tokenResponse.ok) {
    return renderCallbackError(
      pmsType,
      `Token exchange failed (${tokenResponse.status}): ${JSON.stringify(tokenJson)}`,
    );
  }

  const accessToken = tokenJson.access_token;
  const refreshToken = tokenJson.refresh_token;
  const expiresIn = typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : 3600;
  const scope = tokenJson.scope;
  const tokenType = tokenJson.token_type ?? "Bearer";

  if (typeof accessToken !== "string" || !accessToken) {
    return renderCallbackError(pmsType, "Vendor response missing access_token.");
  }

  const secretPayload = {
    accessToken,
    refreshToken: typeof refreshToken === "string" ? refreshToken : null,
    tokenType: typeof tokenType === "string" ? tokenType : "Bearer",
    scope,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };

  // Onboarding: no hotel exists yet — hand off to the hotel-creating flow.
  if (verified.intent === "onboarding") {
    return handleOnboardingConnect(cookieStore, pmsType, verified.userId, secretPayload);
  }

  const { hotelId } = verified;
  const admin = createAdminClient();

  const { error: secretErr } = await admin.rpc("pms_secret_set", {
    p_hotel_id: hotelId,
    p_pms_type: pmsType,
    p_secret: secretPayload,
  });
  if (secretErr) return renderCallbackError(pmsType, `pms_secret_set: ${secretErr.message}`);

  const now = new Date().toISOString();
  const { error: pcErr } = await admin
    .from("pms_connections")
    .upsert(
      {
        hotel_id: hotelId,
        pms_type: pmsType,
        status: "connected",
        last_tested_at: now,
        updated_at: now,
      },
      { onConflict: "hotel_id,pms_type" },
    );
  if (pcErr) return renderCallbackError(pmsType, `pms_connections upsert: ${pcErr.message}`);

  await admin.rpc("platform_log_event", {
    p_event_type: "pms.connected",
    p_entity_type: "pms_connection",
    p_entity_id: hotelId,
    p_hotel_id: hotelId,
    p_detail: { pms_type: pmsType, via: "oauth" },
  });

  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "") ?? "";
  return NextResponse.redirect(`${base}/admin/hotels/${hotelId}?pmsConnected=1`, {
    status: 302,
  });
}

function renderCallbackError(pmsType: PmsType, message: string): Response {
  const registry = requireRegistry(pmsType);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${registry.displayName} connection failed</title></head>
<body style="font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 3rem;">
  <h1 style="color:#f87171">${registry.displayName} connection failed</h1>
  <p><code style="background:#1e293b;padding:.5rem;border-radius:.25rem;display:block;white-space:pre-wrap;">${message.replace(/</g, "&lt;")}</code></p>
  <p><a href="/admin" style="color:#38bdf8">Return to Command Center</a></p>
</body></html>`;
  return new Response(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
