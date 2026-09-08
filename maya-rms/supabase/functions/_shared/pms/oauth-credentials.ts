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
 *
 * Refreshing is a side effect on the vendor's side — answering our POST burns
 * the refresh token we sent. Everything below exists because of that:
 * refreshes for one connection are serialized, the write-back is retried and
 * kept in memory if it never lands, and a token rotated by someone else is
 * adopted rather than treated as our failure.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mwsEnv } from "../mews/env.ts";

/** Refresh if the token expires within this many ms (default 2 min). */
const REFRESH_SKEW_MS = 2 * 60 * 1000;

/** Write-back attempts for the rotated secret, and the pause between them. */
const PERSIST_ATTEMPTS = 3;
const PERSIST_RETRY_MS = 150;

/** Ceiling on the token POST — it holds the connection lock while in flight. */
const REFRESH_TIMEOUT_MS = 20_000;

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

// ── Per-connection serialization ────────────────────────────────────────────

function connKey(hotelId: string, pmsType: OAuthPmsType): string {
  return `${hotelId}|${pmsType}`;
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after any other refresh or secret write for the same connection has
 * finished. Overlapping callers are routine — the 5-min fleet cron and the
 * onboarding worker (which resolves credentials per page) hit the same hotel —
 * and two refreshes in flight at once both POST the same refresh token, so the
 * loser gets invalid_grant and a rotating provider may kill the token family.
 * Queueing means the second caller re-reads and finds the fresh token instead.
 *
 * Only covers this isolate; cross-process overlap is handled by adopting a
 * token someone else rotated (see adoptTokenRotatedElsewhere).
 */
function withConnectionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const link: Promise<void> = run.then(
    () => {},
    () => {},
  ).then(() => {
    if (locks.get(key) === link) locks.delete(key);
  });
  locks.set(key, link);
  return run;
}

// ── Unpersisted rotations ───────────────────────────────────────────────────

type PendingRotation = {
  secret: Record<string, unknown>;
  /** The refresh token the vendor consumed to issue `secret`. */
  consumedRefreshToken: string;
  /** The access token stored alongside it, i.e. the one `secret` supersedes. */
  previousAccessToken: string;
};

/**
 * Rotations the vendor performed but that we could not write back. Vault is
 * left holding a refresh token the vendor has already burned, so throwing these
 * away is what used to wedge a connection until a human redid OAuth. Kept here
 * so the next call for the same connection can flush them.
 */
const pendingRotations = new Map<string, PendingRotation>();

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function readSecret(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
): Promise<{ secret: StoredSecret } | { error: string }> {
  const { data: secretRaw, error: getErr } = await supabase.rpc("pms_secret_get", {
    p_hotel_id: hotelId,
    p_pms_type: pmsType,
  });
  if (getErr) return { error: `pms_secret_get: ${getErr.message}` };
  const secret = normalize(secretRaw);
  if (!secret) {
    return { error: `No ${pmsType} credentials in Vault for hotel ${hotelId}. Connect via OAuth first.` };
  }
  return { secret };
}

/** Write the secret, retrying — a statement timeout here costs us a live token. */
async function persistSecret(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
  secret: Record<string, unknown>,
): Promise<string | null> {
  let lastErr = "unknown error";
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(PERSIST_RETRY_MS * attempt);
    const { error } = await supabase.rpc("pms_secret_set", {
      p_hotel_id: hotelId,
      p_pms_type: pmsType,
      p_secret: secret,
    });
    if (!error) return null;
    lastErr = error.message;
  }
  return lastErr;
}

/**
 * Pick the secret we should actually be using. A pending rotation only wins
 * while Vault still holds the exact pair we refreshed from — anything else there
 * means a manual reconnect or another process has written since, and clobbering
 * that would be worse than the wedge we're recovering. Both tokens have to
 * match: a provider that doesn't rotate refresh tokens leaves that one identical
 * across someone else's refresh, so it alone can't spot a foreign write.
 */
function effectiveSecret(key: string, stored: StoredSecret): { secret: StoredSecret; pending: boolean } {
  const rotation = pendingRotations.get(key);
  if (!rotation) return { secret: stored, pending: false };
  const storedRefresh = pick(stored.refreshToken, stored.refresh_token);
  const storedAccess = pick(stored.accessToken, stored.access_token);
  if (
    storedRefresh === rotation.consumedRefreshToken &&
    storedAccess === rotation.previousAccessToken
  ) {
    return { secret: rotation.secret as StoredSecret, pending: true };
  }
  pendingRotations.delete(key);
  return { secret: stored, pending: false };
}

/**
 * Surface a dead or at-risk credential on the connection row. Self-clearing: a
 * successful sync stamps 'connected' again (cloudbeds/sync-hotel.ts).
 *
 * Only 'error' is durable enough for an operator to see in /api/pms/activity —
 * we return an error with it, so the caller bails before that stamp. 'degraded'
 * rides along with a *successful* resolve, so the same sync normally overwrites
 * it seconds later; the console.error at its call site is the real record.
 */
async function flagConnection(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
  status: "degraded" | "error",
): Promise<void> {
  try {
    await supabase
      .from("pms_connections")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("hotel_id", hotelId)
      .eq("pms_type", pmsType);
  } catch {
    // Advisory only — never fail a working sync over it.
  }
}

/**
 * Our POST failed, possibly because a refresh in another process consumed the
 * same token first. If Vault now holds a different, still-valid access token,
 * that one is the winner's and there is nothing to recover from.
 */
async function adoptTokenRotatedElsewhere(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
  previousAccessToken: string,
): Promise<ResolvedOAuthCredentials | null> {
  const read = await readSecret(supabase, hotelId, pmsType);
  if ("error" in read) return null;
  const s = read.secret;
  const accessToken = pick(s.accessToken, s.access_token);
  if (!accessToken || accessToken === previousAccessToken) return null;
  const expiresAt = pick(s.expiresAt, s.expires_at);
  if (expiresAt != null && new Date(expiresAt).getTime() < Date.now() + REFRESH_SKEW_MS) return null;
  return {
    accessToken,
    tokenType: pick(s.tokenType, s.token_type) ?? "Bearer",
    scope: pick(s.scope),
    expiresAt,
    propertyId: pick(s.propertyId, s.property_id),
    refreshed: false,
  };
}

/**
 * Resolve a usable access token for an OAuth PMS, refreshing if near expiry and
 * persisting the rotated secret back to Vault.
 */
export function resolveOAuthCredentials(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
): Promise<ResolvedOAuthCredentials | { error: string }> {
  return withConnectionLock(connKey(hotelId, pmsType), () =>
    resolveLocked(supabase, hotelId, pmsType),
  );
}

async function resolveLocked(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
): Promise<ResolvedOAuthCredentials | { error: string }> {
  const key = connKey(hotelId, pmsType);
  const read = await readSecret(supabase, hotelId, pmsType);
  if ("error" in read) return { error: read.error };

  const { secret, pending } = effectiveSecret(key, read.secret);
  if (pending) {
    const flushErr = await persistSecret(supabase, hotelId, pmsType, secret as Record<string, unknown>);
    if (!flushErr) pendingRotations.delete(key);
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
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
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
      const detail = JSON.stringify(json).slice(0, 300);
      const adopted = await adoptTokenRotatedElsewhere(supabase, hotelId, pmsType, accessToken);
      if (adopted) return adopted;
      if (/invalid_grant/i.test(detail)) {
        await flagConnection(supabase, hotelId, pmsType, "error");
        return {
          error: `${pmsType} refresh token was rejected (invalid_grant) — reconnect via OAuth. (${res.status}) ${detail}`,
        };
      }
      return { error: `${pmsType} token refresh failed (${res.status}): ${detail}` };
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

    const setErr = await persistSecret(supabase, hotelId, pmsType, updatedSecret);
    if (setErr) {
      // Old refresh token is already spent, so returning an error here would
      // both fail this tick and leave Vault holding a dead token forever. Serve
      // the live access token, keep the pair for the next call to flush, and
      // make the connection say it is running on something unsaved.
      pendingRotations.set(key, {
        secret: updatedSecret,
        consumedRefreshToken: refreshToken,
        previousAccessToken: accessToken,
      });
      console.error(
        `${pmsType} refresh for hotel ${hotelId} could not be persisted (${setErr}); holding rotated tokens in memory`,
      );
      await flagConnection(supabase, hotelId, pmsType, "degraded");
    } else {
      pendingRotations.delete(key);
    }

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
 *
 * Writes the whole secret blob, so it takes the same lock as a refresh — left
 * unserialized it would happily write the tokens it read back over ones a
 * refresh rotated in between, wedging the connection with no error anywhere.
 */
export function persistPropertyId(
  supabase: SupabaseClient,
  hotelId: string,
  pmsType: OAuthPmsType,
  propertyId: string,
): Promise<void> {
  const key = connKey(hotelId, pmsType);
  return withConnectionLock(key, async () => {
    const read = await readSecret(supabase, hotelId, pmsType);
    if ("error" in read) return;
    const { secret, pending } = effectiveSecret(key, read.secret);
    if (pick(secret.propertyId, secret.property_id) === propertyId) return;
    const { error } = await supabase.rpc("pms_secret_set", {
      p_hotel_id: hotelId,
      p_pms_type: pmsType,
      p_secret: { ...secret, propertyId },
    });
    if (!error && pending) pendingRotations.delete(key);
  });
}
