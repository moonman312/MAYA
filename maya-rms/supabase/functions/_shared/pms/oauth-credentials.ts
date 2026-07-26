/**
 * Shared OAuth credential resolution + refresh for OAuth2 PMSes (Cloudbeds, Think).
 *
 * The OAuth *connect* flow (src/lib/pms/oauth-flow.ts) already stores a secret
 * payload in Vault via the `pms_secret_set` RPC:
 *
 *   { accessToken, refreshToken, tokenType, scope, expiresAt, propertyId? }
 *
 * Access tokens live ~1h, so a cron sync running every 5 min must refresh them
 * before expiry. This module:
 *   1. Reads the secret via `pms_secret_get` (service role bypasses RLS).
 *   2. If `expiresAt` is within REFRESH_SKEW_MS, POSTs a refresh_token grant to
 *      the vendor token endpoint and writes the rotated tokens back via
 *      `pms_secret_set`.
 *   3. Returns a ready-to-use access token.
 *
 * Generic across OAuth2 PMSes — Think reuses it unchanged (Auth0 issues
 * offline_access refresh tokens).
 *
 * ⚠ VERIFY per vendor before production: some providers rotate the refresh
 * token on each use (must persist the new one — handled here), some don't
 * return `refresh_token` on refresh (we keep the old one), and Cloudbeds'
 * token host has changed once already (see registry note). Endpoints are env-
 * overridable so you never need a code change to fix a moved URL.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mwsEnv } from "../mews/env.ts";

/** Refresh if the token expires within this many ms (default 2 min). */
const REFRESH_SKEW_MS = 2 * 60 * 1000;

export type OAuthPmsType = "cloudbeds" | "think";

export type ResolvedOAuthCredentials = {
  accessToken: string;
  tokenType: string;
  scope: string | null;
  expiresAt: string | null;
  /** Cloudbeds property id (a.k.a. propertyID) if we have discovered/stored it. */
  propertyId: string | null;
  /** true when this call performed a refresh (useful for logging). */
  refreshed: boolean;
};

type StoredSecret = {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string | null;
  refresh_token?: string | null;
  tokenType?: string;
  token_type?: string;
  scope?: string | null;
  expiresAt?: string | null;
  expires_at?: string | null;
  propertyId?: string | null;
  property_id?: string | null;
};

/** Cross-runtime env read (Deno Edge + Node/Next), same helper Mews uses. */
function env(name: string): string | undefined {
  return mwsEnv(name);
}

/** Vendor OAuth2 config. Endpoints are env-overridable (no code change to move a URL). */
function oauthConfig(pmsType: OAuthPmsType): {
  tokenUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  audience?: string;
} {
  if (pmsType === "cloudbeds") {
    const base = (env("CLOUDBEDS_AUTHORIZE_BASE_URL") ?? "https://hotels.cloudbeds.com").replace(/\/$/, "");
    return {
      // NOTE: Cloudbeds token endpoint is /api/v1.x/access_token (no /oauth segment).
      tokenUrl: env("CLOUDBEDS_TOKEN_URL") ?? `${base}/api/v1.3/access_token`,
      clientId: env("CLOUDBEDS_CLIENT_ID"),
      clientSecret: env("CLOUDBEDS_CLIENT_SECRET"),
    };
  }
  // think
  return {
    tokenUrl: env("THINK_TOKEN_URL") ?? "https://auth.thinkreservations.com/oauth/token",
    clientId: env("THINK_CLIENT_ID"),
    clientSecret: env("THINK_CLIENT_SECRET"),
    audience: env("THINK_API_AUDIENCE") ?? "https://api.thinkreservations.com/",
  };
}

function normalize(raw: unknown): StoredSecret | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as StoredSecret;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as StoredSecret;
  return null;
}

function pick<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v != null && v !== "") return v;
  return null;
}

/**
 * Resolve a usable access token for an OAuth PMS, refreshing if near expiry and
 * persisting the rotated secret back to Vault.
 */
export async function resolveOAuthCredentials(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
): Promise<ResolvedOAuthCredentials | { error: string }> {
  const { data: secretRaw, error: getErr } = await supabase.rpc("pms_secret_get", {
    p_hotel_id: hotelId,
    p_pms_type: pmsType,
  });
  if (getErr) return { error: `pms_secret_get: ${getErr.message}` };

  const secret = normalize(secretRaw);
  if (!secret) {
    return { error: `No ${pmsType} credentials in Vault for hotel ${hotelId}. Connect via OAuth first.` };
  }

  let accessToken = pick(secret.accessToken, secret.access_token);
  const refreshToken = pick(secret.refreshToken, secret.refresh_token);
  const tokenType = pick(secret.tokenType, secret.token_type) ?? "Bearer";
  let scope = pick(secret.scope);
  let expiresAt = pick(secret.expiresAt, secret.expires_at);
  const propertyId = pick(secret.propertyId, secret.property_id);

  if (!accessToken) {
    return { error: `${pmsType} secret is missing accessToken.` };
  }

  const needsRefresh =
    expiresAt != null && new Date(expiresAt).getTime() < Date.now() + REFRESH_SKEW_MS;

  let refreshed = false;

  if (needsRefresh) {
    if (!refreshToken) {
      // Can't refresh — surface a clear error so the operator re-connects.
      return {
        error: `${pmsType} access token expired and no refresh_token is stored — reconnect via OAuth.`,
      };
    }
    const cfg = oauthConfig(pmsType);
    if (!cfg.clientId || !cfg.clientSecret) {
      return { error: `${pmsType} client id/secret not set in Edge secrets; cannot refresh token.` };
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
    });
    if (cfg.audience) body.set("audience", cfg.audience);

    let res: Response;
    try {
      res = await fetch(cfg.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (e) {
      return { error: `${pmsType} token refresh unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }

    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { error: `${pmsType} token refresh returned non-JSON (${res.status}): ${text.slice(0, 200)}` };
    }
    if (!res.ok) {
      return { error: `${pmsType} token refresh failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}` };
    }

    const newAccess = typeof json.access_token === "string" ? json.access_token : null;
    if (!newAccess) return { error: `${pmsType} token refresh missing access_token.` };

    const newRefresh = typeof json.refresh_token === "string" ? json.refresh_token : refreshToken;
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    const newExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const newScope = typeof json.scope === "string" ? json.scope : scope;
    const newTokenType = typeof json.token_type === "string" ? json.token_type : tokenType;

    const updatedSecret = {
      accessToken: newAccess,
      refreshToken: newRefresh,
      tokenType: newTokenType,
      scope: newScope,
      expiresAt: newExpiresAt,
      ...(propertyId ? { propertyId } : {}),
    };

    const { error: setErr } = await supabase.rpc("pms_secret_set", {
      p_hotel_id: hotelId,
      p_pms_type: pmsType,
      p_secret: updatedSecret,
    });
    if (setErr) return { error: `pms_secret_set (after refresh): ${setErr.message}` };

    accessToken = newAccess;
    expiresAt = newExpiresAt;
    scope = newScope;
    refreshed = true;
  }

  return {
    accessToken: accessToken!,
    tokenType,
    scope,
    expiresAt,
    propertyId,
    refreshed,
  };
}

/**
 * Persist a discovered Cloudbeds propertyId into the Vault secret so subsequent
 * syncs skip the discovery call. Best-effort; failures are non-fatal.
 */
export async function persistPropertyId(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
  propertyId: string,
): Promise<void> {
  const { data: secretRaw } = await supabase.rpc("pms_secret_get", {
    p_hotel_id: hotelId,
    p_pms_type: pmsType,
  });
  const secret = normalize(secretRaw);
  if (!secret) return;
  await supabase.rpc("pms_secret_set", {
    p_hotel_id: hotelId,
    p_pms_type: pmsType,
    p_secret: { ...secret, propertyId },
  });
}
