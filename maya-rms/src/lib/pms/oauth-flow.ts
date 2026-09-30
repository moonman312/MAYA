import "server-only";
import { godModeStatus, recordIfSupport } from "@/lib/admin/god-mode";
import { createAdminClient, isAdminConfigured } from "@/utils/supabase/admin";
import { createClient as createSSRClient } from "@/utils/supabase/server";
import { findPendingHotelForUser } from "@/lib/billing/pending-hotel";
import { pmsSignupCodeRequired } from "@/lib/billing/pms-gates";
import { isStripeConfigured } from "@/lib/billing/stripe";
import { handleOnboardingConnect } from "@/lib/onboarding/connect";
import { links } from "@/lib/deep-links";
import { activeHotelCookieOptions, MAYA_ACTIVE_HOTEL_COOKIE } from "@/lib/hotel-context";
import { ensureAppStateWebhook } from "@/lib/pms/cloudbeds-webhooks";
import { cloudbedsListPropertiesOrThrow } from "../../../supabase/functions/_shared/cloudbeds/client";
import { defaultCloudbedsBaseUrl } from "../../../supabase/functions/_shared/cloudbeds/constants";
import { enterpriseKey, handleMarketplaceConnect, type MarketplaceTokens } from "@/lib/pms/marketplace-connect";
import { findMarketplaceClaimForHotel, hasEntitledSubscription } from "@/lib/pms/marketplace-activate";
import { queueImportAfterPurge } from "@/lib/pms/purged";
import { resumeImportAfterReconnect } from "@/lib/pms/eager-import";
import { hotelsConnectedInsideMaya, storedPropertyId } from "@/lib/pms/stored-property";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOnboardingStep } from "@/lib/onboarding/step";
import { markConnectionReauthorized } from "@/lib/pms/connection-stamps";
import { pmsCallbackUrl, requireRegistry, type PmsType } from "@/lib/pms/registry";
import { signOnboardingState, signState, verifyState } from "@/lib/pms/oauth-state";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/** What staff see when their God Mode window ended before the vendor sent them back. */
const GOD_MODE_ENDED =
  "God Mode ended before the sign-in finished, so nothing was changed. Turn it on again and start the reconnect from MAYA.";

/**
 * Who the OAuth dance is for:
 * - hotel: connecting an existing hotel again (General Manager or above, or
 *   a platform admin).
 * - onboarding: a new user with no hotel — any authenticated session;
 *   the callback creates the hotel from PMS data.
 */
export type OAuthTarget =
  | { kind: "hotel"; hotelId: string; from?: "admin" }
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
  // Set when MAYA staff start a reconnect in God Mode: when their window ends.
  let godModeUntilMs: number | undefined;
  if (target.kind === "hotel") {
    // The rank the Reconnect button is drawn for (/api/pms/activity), platform
    // admins included. can_manage_hotel also lets a Revenue Manager in, so the
    // link used to reconnect for someone who was never shown the button.
    if (!(await canReconnectHotel(ssr, target.hotelId))) {
      return renderNotice("Reconnecting needs General Manager access or higher on this property.", 403);
    }
    // The connection itself is written by the vendor's callback with the
    // service role, so support's reconnect is recorded here, where the person
    // and their window are known. Its state runs out with the window, and the
    // callback asks again whether they may still change the property.
    if (isAdminConfigured()) {
      const support = await recordIfSupport(ssr, createAdminClient(), {
        userId: user.id,
        hotelId: target.hotelId,
        tableName: "pms_connections",
        rowId: target.hotelId,
        op: "update",
        after: { pms_type: pmsType },
        summary: `Started reconnecting the property system (${pmsType}).`,
      });
      if (support) {
        const window = await godModeStatus(ssr);
        godModeUntilMs = window.expiresAt ? Date.parse(window.expiresAt) : Date.now();
      }
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

    // The access-code gate, per PMS (/admin/pms-access). Checkout only demands
    // a code for the PMS the buyer DECLARED, so paying is not the same thing as
    // being let into this one: declaring an open PMS and then connecting a
    // gated one would otherwise walk straight past the gate. Enforced here and
    // not again in the callback — the signed state the callback insists on is
    // only ever minted below this line.
    if (isStripeConfigured()) {
      try {
        const admin = createAdminClient();
        if (await pmsSignupCodeRequired(admin, pmsType)) {
          const pendingHotelId = await findPendingHotelForUser(admin, user.id);
          const { data: sub } = pendingHotelId
            ? await admin
                .from("hotel_subscriptions")
                .select("signup_code_id")
                .eq("hotel_id", pendingHotelId)
                .maybeSingle()
            : { data: null };
          if (!sub?.signup_code_id) {
            const name = requireRegistry(pmsType).displayName;
            return NextResponse.json(
              {
                error:
                  `${name} needs an access code to connect. Use the system you ` +
                  `signed up with, or get in touch and we'll sort you out.`,
              },
              { status: 403 },
            );
          }
        }
      } catch (e) {
        console.error(
          JSON.stringify({
            fn: "buildAuthorizeRedirect",
            step: "pms_gate",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        return NextResponse.json(
          { error: "We couldn't verify your signup just now. Please try again in a moment." },
          { status: 503 },
        );
      }
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
      : signState(target.hotelId, pmsType, { userId: user.id, from: target.from, godModeUntilMs });
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
 * via `pms_secret_set`, and redirects back to where the connect started.
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
  if (!code) {
    return renderCallbackError(pmsType, "Missing `code` from vendor.");
  }

  // FLOW A: Cloudbeds started this, not us, so there is no state we signed.
  // Required for all new apps since 2020-11-01 — the user clicks "Connect App"
  // in the Marketplace and arrives here with nothing but a grant. Refusing it
  // (which is what a missing/unverifiable state used to do) is exactly the
  // failure a certification reviewer sees.
  //
  // A state we cannot verify is treated the same way rather than as an attack:
  // the grant still has to be spent against the vendor to learn anything, and
  // identity comes from what Cloudbeds says the token is for, never from the
  // URL. A forged state therefore buys nothing a bare Flow A callback does not
  // already allow.
  const verified = state ? verifyState(state, pmsType) : null;
  // Except a link we signed that simply ran out: that one is ours, so it is
  // no Marketplace grant. Taken as one, it ended ThinkReservations on a
  // Marketplace error with a link to the staff console. Nothing is exchanged.
  if (verified != null && !verified.ok && verified.expired) {
    return renderNotice(verified.support ? GOD_MODE_ENDED : "That sign-in link ran out after 15 minutes. Start again from MAYA.");
  }
  // Ours, from before the person starting it was put in the link. Not a
  // Marketplace grant, and not finished for whoever holds it.
  if (verified != null && !verified.ok && verified.stale) {
    return renderNotice("That link is from before an update to MAYA. Start the reconnect again from MAYA.");
  }
  // A reconnect finishes only for the person who started it, and only while
  // they may still reconnect this property: the link is good for 15 minutes
  // wherever the browser is sent, so someone at another hotel approving it
  // would otherwise store their login under this property. For MAYA staff in
  // God Mode this is also the check that their window has not ended. Asked
  // before the grant is spent, so nothing about the property is touched.
  if (verified != null && verified.ok && verified.intent === "hotel") {
    const ssr = createSSRClient(cookieStore);
    const {
      data: { user },
    } = await ssr.auth.getUser();
    if (!user || user.id !== verified.userId) {
      return renderNotice(
        "This reconnect link was started from a different account. Sign in as the person who started it, or start the reconnect again from MAYA.",
        403,
      );
    }
    if (!(await canReconnectHotel(ssr, verified.hotelId))) {
      return renderNotice(
        verified.support ? GOD_MODE_ENDED : "Reconnecting needs General Manager access or higher on this property.",
        403,
      );
    }
  }
  const isMarketplace = !state || (verified != null && !verified.ok);
  if (verified != null && !verified.ok) {
    console.warn(
      JSON.stringify({
        fn: "handleOAuthCallback",
        pmsType,
        event: "unverifiable_state_treated_as_marketplace",
        reason: verified.error,
      }),
    );
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

  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "") ?? "";

  // FLOW A: no state, so the property is identified from the grant itself.
  if (isMarketplace) {
    // A property connected from inside MAYA is reconnected here only for the
    // person its own Reconnect button is for, so who is at the browser is
    // asked, once, and only when such a property turns up.
    const ssr = createSSRClient(cookieStore);
    let signedIn: Promise<boolean> | null = null;
    const outcome = await handleMarketplaceConnect(pmsType, secretPayload, {
      canReconnect: async (hotelId) => {
        signedIn ??= ssr.auth.getUser().then(({ data }) => Boolean(data.user));
        return (await signedIn) && (await canReconnectHotel(ssr, hotelId));
      },
      reconnect: async (hotelId) => {
        const done = await reconnectHotel(hotelId, pmsType, secretPayload, "marketplace_flow_a");
        return done.ok ? { ok: true } : { ok: false, message: done.message };
      },
    });
    if (outcome.kind === "error") return renderCallbackError(pmsType, outcome.message);
    if (outcome.kind === "refused") return renderNotice(outcome.message, 403);
    if (outcome.kind === "reconnected") {
      if (outcome.inApp) return reconnectedRedirect(base, outcome.hotelId);
      // Flow A's own wording: after connecting, "Connect App" becomes "Login".
      return NextResponse.redirect(`${base}/login?reconnected=1`, { status: 302 });
    }
    return NextResponse.redirect(`${base}/login?claim=${outcome.token}`, { status: 302 });
  }

  if (!verified || !verified.ok) {
    return renderCallbackError(pmsType, "State verification failed.");
  }

  // Onboarding: no hotel exists yet — hand off to the hotel-creating flow.
  if (verified.intent === "onboarding") {
    return handleOnboardingConnect(cookieStore, pmsType, verified.userId, secretPayload);
  }

  const { hotelId } = verified;
  const done = await reconnectHotel(hotelId, pmsType, secretPayload, "oauth");
  if (!done.ok) return done.plain ? renderNotice(done.message) : renderCallbackError(pmsType, done.message);

  if (verified.from === "admin") {
    return NextResponse.redirect(`${base}/admin/hotels/${hotelId}?pmsConnected=1`, {
      status: 302,
    });
  }
  // A parked property is not on the dashboard yet: back to the payment
  // screen its reconnect prompt was on.
  if (done.parked) return NextResponse.redirect(`${base}/onboarding`, { status: 302 });
  return reconnectedRedirect(base, hotelId);
}

/**
 * An existing hotel connected again with a fresh grant: its Reconnect button,
 * the staff console, and a Marketplace "Connect App" on a property connected
 * from inside MAYA all come through here.
 */
async function reconnectHotel(
  hotelId: string,
  pmsType: PmsType,
  secretPayload: MarketplaceTokens,
  via: "oauth" | "marketplace_flow_a",
): Promise<{ ok: true; parked: boolean } | { ok: false; message: string; plain: boolean }> {
  const admin = createAdminClient();

  // Every Cloudbeds reconnect has to be for the property this hotel is
  // connected to, and that is settled before its credential is overwritten.
  const bound = await boundPropertyForGrant(admin, hotelId, pmsType, secretPayload);
  if (!bound.ok) return { ok: false, message: bound.message, plain: true };

  const { error: secretErr } = await admin.rpc("pms_secret_set", {
    p_hotel_id: hotelId,
    p_pms_type: pmsType,
    p_secret: bound.propertyId ? { ...secretPayload, propertyId: bound.propertyId } : secretPayload,
  });
  if (secretErr) return { ok: false, message: `pms_secret_set: ${secretErr.message}`, plain: false };

  // The reconnect prompt sends a Marketplace property here too, including one
  // whose owner never paid and whose data the retention sweep removed. Owning
  // it is not paying for it, so it comes back parked exactly as the Marketplace
  // reconnect leaves it (marketplace-connect.ts), and activation lifts it when
  // a subscription lands. Any other hotel connects as it always has.
  const parked = await parkedMarketplaceHotel(admin, hotelId);

  const now = new Date().toISOString();
  const { error: pcErr } = await admin
    .from("pms_connections")
    .upsert(
      {
        hotel_id: hotelId,
        pms_type: pmsType,
        status: parked ? "pending" : "connected",
        last_tested_at: now,
        updated_at: now,
      },
      { onConflict: "hotel_id,pms_type" },
    );
  if (pcErr) return { ok: false, message: `pms_connections upsert: ${pcErr.message}`, plain: false };
  // A person re-authorized: rate pushes held for a missing permission or a
  // refused grant go out on the next tick instead of a day later.
  await markConnectionReauthorized(admin, hotelId, pmsType, now);

  // A property the sweep emptied gets its full history read again; a plain
  // reconnect would only ever sync the recent window. Otherwise an import the
  // lost connection stopped or wore out carries on from where it was, as the
  // Marketplace reconnect does; a parked property's waits for its payment
  // screen. Never fails the connect.
  const importStep = async () => {
    const afterPurge = await queueImportAfterPurge(admin, hotelId, pmsType, null);
    if (!afterPurge.queued && afterPurge.reason === "not_purged" && !parked) {
      await resumeImportAfterReconnect(admin, hotelId);
    }
  };
  await importStep().catch((e: unknown) => {
    console.error(
      JSON.stringify({
        fn: "handleOAuthCallback",
        step: "import",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  });

  // Cloudbeds only: ask to be told when this property uninstalls the app, so a
  // revoked grant is not first noticed as a 401 five minutes later. Deliberately
  // not fatal — an unsubscribed connection still works.
  if (pmsType === "cloudbeds" && typeof secretPayload.accessToken === "string") {
    const hook = await ensureAppStateWebhook(
      {
        accessToken: secretPayload.accessToken,
        tokenType: typeof secretPayload.tokenType === "string" ? secretPayload.tokenType : "Bearer",
        baseUrl: defaultCloudbedsBaseUrl(),
        // A hotel with no property on record yet resolves it on its first
        // sync, not here, and Cloudbeds infer it from the grant when it is
        // omitted.
        propertyId: bound.propertyId ?? "",
      },
      hotelId,
    );
    if (!hook.ok) {
      console.error(
        JSON.stringify({ fn: "handleOAuthCallback", step: "webhook", hotelId, reason: hook.reason }),
      );
    }
  }

  await admin.rpc("platform_log_event", {
    p_event_type: "pms.connected",
    p_entity_type: "pms_connection",
    p_entity_id: hotelId,
    p_hotel_id: hotelId,
    p_detail: { pms_type: pmsType, via },
  });

  return { ok: true, parked };
}

/**
 * General Manager or above on this hotel, or a platform admin. Asked of the
 * database, where can_manage_finances takes the caller from the verified
 * token (auth.uid()), in the same query that answers, so no separate auth
 * round trip is needed to trust the id.
 */
async function canReconnectHotel(ssr: SupabaseClient, hotelId: string): Promise<boolean> {
  const { data, error } = await ssr.rpc("can_manage_finances", { target_hotel_id: hotelId });
  return !error && data === true;
}

/**
 * Back to the dashboard's PMS tab on the property just reconnected, with the
 * short note that says it worked. The property is made the active one, so
 * the note sits over the right connection; the cookie is only ever honoured
 * for a property the person belongs to (hotel-context.ts).
 */
function reconnectedRedirect(base: string, hotelId: string): Response {
  const res = NextResponse.redirect(
    `${base}${links.internalHref({ dest: "pms", params: {} }, { note: "reconnected" })}`,
    { status: 302 },
  );
  res.cookies.set(MAYA_ACTIVE_HOTEL_COOKIE, hotelId, activeHotelCookieOptions());
  return res;
}

/**
 * The Cloudbeds property this hotel is connected to, checked against what the
 * new grant can reach, before anything of the existing connection is touched.
 *
 * A Marketplace hotel's is on its row, and the retention sweep may have
 * deleted its credential, so a reconnect through this door has to supply it
 * again. A hotel connected from inside MAYA keeps it with its credential.
 * Either way a login for some other property stops here: its bookings must
 * not be read and priced, nor rates sent to it, under this hotel. A group
 * login that reaches the property is fine, and the ID stored with the new
 * tokens says which sibling. A hotel with no property on record yet is
 * refused a login for a property that is already another MAYA hotel's, and
 * is bound to the property when the login reaches exactly one.
 */
async function boundPropertyForGrant(
  admin: SupabaseClient,
  hotelId: string,
  pmsType: PmsType,
  tokens: { accessToken: string; tokenType: string },
): Promise<{ ok: true; propertyId: string | null } | { ok: false; message: string }> {
  if (pmsType !== "cloudbeds") return { ok: true, propertyId: null };
  let propertyId: string | null = null;
  try {
    // Read directly so a failed read stops here. The shared lookup reads an
    // error as "no claim", which would skip the very check this is.
    const { data: claimRow, error: claimErr } = await admin
      .from("pms_marketplace_claims")
      .select("token")
      .eq("hotel_id", hotelId)
      .not("claimed_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    const { data, error } = await admin
      .from("hotels")
      .select("external_enterprise_id")
      .eq("id", hotelId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const enterpriseId = data?.external_enterprise_id ? String(data.external_enterprise_id) : "";
    const prefix = `${pmsType}:`;
    if (enterpriseId.startsWith(prefix)) propertyId = enterpriseId.slice(prefix.length) || null;
    if (claimRow && !propertyId) {
      return { ok: false, message: "Reconnect this property from the Cloudbeds Marketplace." };
    }
    propertyId ??= await storedPropertyId(admin, hotelId, pmsType);
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "handleOAuthCallback",
        step: "bound_property",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return { ok: false, message: "We couldn't check this login just now. Try connecting again in a moment." };
  }
  const bare = { accessToken: tokens.accessToken, tokenType: tokens.tokenType, baseUrl: defaultCloudbedsBaseUrl() };
  let reachable: string[];
  try {
    reachable = (await cloudbedsListPropertiesOrThrow(bare)).map((p) => p.propertyId);
  } catch {
    // An outage is not an answer. Saying "different property" here would send
    // the owner looking for a login they already used.
    return { ok: false, message: "Cloudbeds didn't answer. Try connecting again in a moment." };
  }

  if (!propertyId) {
    // No property on record yet (the placeholder checkout makes, or a hotel
    // whose first sync never ran). Any login would have been taken, so a
    // property that is already another MAYA hotel's must not be stored
    // under this one: its bookings would be read and priced, and prices
    // sent to it, from the wrong property. A login that reaches exactly one
    // property is bound to it here, so the check holds from now on.
    try {
      if (await anyPropertyBelongsElsewhere(admin, hotelId, pmsType, reachable)) {
        return { ok: false, message: ALREADY_ANOTHER_HOTELS };
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          fn: "handleOAuthCallback",
          step: "property_elsewhere",
          hotelId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return { ok: false, message: "We couldn't check this login just now. Try connecting again in a moment." };
    }
    return { ok: true, propertyId: reachable.length === 1 ? reachable[0] : null };
  }

  if (!reachable.includes(propertyId)) {
    return { ok: false, message: "This login is for a different property." };
  }
  return { ok: true, propertyId };
}

/** What the person is told when the login they used is for a property another MAYA hotel already is. */
export const ALREADY_ANOTHER_HOTELS =
  "This Cloudbeds login is for a property that is already connected to another property in MAYA, so nothing was changed. " +
  "If that property should be this one, ask its General Manager for an invitation, or email us.";

/**
 * Whether any of these Cloudbeds properties is already some other MAYA
 * hotel's: a Marketplace hotel carries its property on its row and counts
 * once someone is a member of it (an unclaimed parked row is nobody's yet);
 * a hotel connected from inside MAYA keeps its property with its credential.
 * Throws when anything cannot be read, so an outage is never "not in MAYA".
 */
async function anyPropertyBelongsElsewhere(
  admin: SupabaseClient,
  hotelId: string,
  pmsType: PmsType,
  propertyIds: string[],
): Promise<boolean> {
  if (propertyIds.length === 0) return false;
  const { data: keyed, error } = await admin
    .from("hotels")
    .select("id")
    .in(
      "external_enterprise_id",
      propertyIds.map((p) => enterpriseKey(pmsType, p)),
    )
    .neq("id", hotelId);
  if (error) throw new Error(`hotels: ${error.message}`);
  for (const h of keyed ?? []) {
    const { data: members, error: memberErr } = await admin
      .from("hotel_memberships")
      .select("user_id")
      .eq("hotel_id", String(h.id))
      .limit(1);
    if (memberErr) throw new Error(`hotel_memberships: ${memberErr.message}`);
    if ((members ?? []).length > 0) return true;
  }
  const inside = await hotelsConnectedInsideMaya(admin, pmsType, propertyIds);
  for (const hotel of inside.values()) if (hotel.id !== hotelId) return true;
  return false;
}

/**
 * A claimed Marketplace hotel with no live subscription, on an install that
 * takes payments. Same test the claim and the Marketplace reconnect use,
 * with the same reading of a failed lookup.
 */
async function parkedMarketplaceHotel(admin: SupabaseClient, hotelId: string): Promise<boolean> {
  if (!isStripeConfigured()) return false;
  try {
    if (!(await findMarketplaceClaimForHotel(admin, hotelId))) return false;
    return !(await hasEntitledSubscription(admin, hotelId));
  } catch (e) {
    console.error(
      JSON.stringify({
        fn: "handleOAuthCallback",
        step: "parked_check",
        hotelId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return false;
  }
}

/**
 * One plain sentence for the person at the browser, and the way back to their
 * dashboard. For a refusal they can act on; driver detail belongs in the log.
 */
function renderNotice(message: string, status = 400): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>MAYA</title></head>
<body style="font-family: system-ui, sans-serif; background: #020617; color: #e2e8f0; padding: 3rem;">
  <p style="max-width:36rem;line-height:1.6">${message.replace(/</g, "&lt;")}</p>
  <p><a href="/" style="color:#38bdf8">Open MAYA</a></p>
</body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
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
