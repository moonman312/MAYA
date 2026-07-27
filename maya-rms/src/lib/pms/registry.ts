import "server-only";

/**
 * Central metadata for every PMS this app can integrate with.
 * Consumed by the Command Center UI (to render "Connect" buttons vs credential
 * forms), by OAuth connect/callback routes (auth URLs, scopes), and by env
 * validation (is this PMS actually configured on this deployment?).
 *
 * Adding a new PMS means:
 *   1. Add its value to the `pms_type` enum in Postgres
 *   2. Add an entry here
 *   3. Add the connect/callback routes if it uses OAuth
 *   4. Add credential handling in resolve-credentials.ts (or the future adapter)
 */

export type PmsType = "mews" | "cloudbeds" | "think" | "opera" | "other";
export type AuthKind = "static_tokens" | "oauth2_authorization_code";

export type PmsRegistryEntry = {
  type: PmsType;
  displayName: string;
  authKind: AuthKind;
  /** OAuth2 only. Vendor's authorize endpoint. */
  authorizeUrl?: string;
  /** OAuth2 only. Token exchange endpoint. */
  tokenUrl?: string;
  /** OAuth2 only. Some vendors (Auth0-backed Think) require an `audience` param. */
  audience?: string;
  /** OAuth2 only. Scopes to request during the authorize call. */
  scopes?: string[];
  /** OAuth2 only. Names of env vars we require to actually run the flow. */
  requiredEnvVars: string[];
  /** Docs / dashboard URL to help operators when config is missing. */
  vendorConsoleUrl?: string;
  /**
   * True when an OnboardingPmsAdapter exists for this PMS (see
   * supabase/functions/_shared/pms/onboarding-adapter.ts). Drives which
   * PMSes the onboarding connect page offers vs. shows as "coming soon".
   */
  onboardingSupported?: boolean;
};

const CLOUDBEDS_AUTHORIZE_BASE =
  process.env.CLOUDBEDS_AUTHORIZE_BASE_URL?.replace(/\/$/, "") ??
  "https://hotels.cloudbeds.com";

export const PMS_REGISTRY: Record<Exclude<PmsType, "opera" | "other">, PmsRegistryEntry> = {
  mews: {
    type: "mews",
    displayName: "Mews",
    authKind: "static_tokens",
    requiredEnvVars: [],
    vendorConsoleUrl: "https://app.mews.com/",
  },
  cloudbeds: {
    type: "cloudbeds",
    displayName: "Cloudbeds",
    authKind: "oauth2_authorization_code",
    authorizeUrl:
      process.env.CLOUDBEDS_AUTHORIZE_URL ??
      `${CLOUDBEDS_AUTHORIZE_BASE}/api/v1.3/oauth`,
    // NOTE: Cloudbeds' token endpoint is /api/v1.x/access_token — there is no
    // /oauth segment in the path (that's only on the authorize endpoint).
    // The old `/api/v1.3/oauth/access_token` value 404'd with Cloudbeds'
    // website HTML during code exchange.
    tokenUrl:
      process.env.CLOUDBEDS_TOKEN_URL ??
      `${CLOUDBEDS_AUTHORIZE_BASE}/api/v1.3/access_token`,
    scopes: [
      "read:reservation",
      "write:reservation",
      "read:room",
      "read:rate",
      "write:rate",
      "read:hotel",
    ],
    requiredEnvVars: ["CLOUDBEDS_CLIENT_ID", "CLOUDBEDS_CLIENT_SECRET"],
    vendorConsoleUrl: "https://hotels.cloudbeds.com/",
    onboardingSupported: true,
  },
  think: {
    type: "think",
    displayName: "Think Reservations",
    authKind: "oauth2_authorization_code",
    authorizeUrl:
      process.env.THINK_AUTHORIZE_URL ?? "https://auth.thinkreservations.com/authorize",
    tokenUrl:
      process.env.THINK_TOKEN_URL ?? "https://auth.thinkreservations.com/oauth/token",
    audience:
      process.env.THINK_API_AUDIENCE ?? "https://api.thinkreservations.com/",
    scopes: [
      "offline_access",
      "read:rate",
      "write:rate",
      "read:availability",
      "read:reservation",
      "read:room",
    ],
    requiredEnvVars: ["THINK_CLIENT_ID", "THINK_CLIENT_SECRET"],
    vendorConsoleUrl: "https://manage.thinkreservations.com/",
  },
};

/**
 * True if the environment has every required var populated for this PMS.
 * The UI uses this to decide between "Connect" and "Not configured" states.
 */
export function isPmsConfigured(type: PmsType): boolean {
  const entry = getRegistry(type);
  if (!entry) return false;
  return entry.requiredEnvVars.every((name) => {
    const val = process.env[name];
    return typeof val === "string" && val.length > 0;
  });
}

export function getRegistry(type: PmsType): PmsRegistryEntry | null {
  if (type === "opera" || type === "other") return null;
  return PMS_REGISTRY[type] ?? null;
}

export function requireRegistry(type: PmsType): PmsRegistryEntry {
  const r = getRegistry(type);
  if (!r) throw new Error(`No PMS registry entry for '${type}'.`);
  return r;
}

/** Callback URL for a given PMS. Uses MAYA_INVITE_REDIRECT_BASE as the origin. */
export function pmsCallbackUrl(type: PmsType): string {
  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "MAYA_INVITE_REDIRECT_BASE not set; cannot construct PMS callback URL.",
    );
  }
  return `${base}/api/pms/${type}/callback`;
}

/** Snapshot for the /admin UI: PMS metadata + whether it's ready to connect. */
export type PmsRegistryStatus = {
  type: PmsType;
  displayName: string;
  authKind: AuthKind;
  configured: boolean;
  missingEnvVars: string[];
  callbackUrl: string | null;
  onboardingSupported: boolean;
};

export function listPmsStatuses(): PmsRegistryStatus[] {
  const base = process.env.MAYA_INVITE_REDIRECT_BASE?.replace(/\/$/, "") ?? null;
  return Object.values(PMS_REGISTRY).map((entry) => ({
    type: entry.type,
    displayName: entry.displayName,
    authKind: entry.authKind,
    configured: isPmsConfigured(entry.type),
    missingEnvVars: entry.requiredEnvVars.filter((name) => !process.env[name]),
    callbackUrl: base ? `${base}/api/pms/${entry.type}/callback` : null,
    onboardingSupported: entry.onboardingSupported === true,
  }));
}
