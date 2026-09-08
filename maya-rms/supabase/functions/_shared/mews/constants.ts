import { mwsEnv } from "./env.ts";

/** Mirrors `shared/legacy-python/config.py` Mews settings. */

export const MEWS_CLIENT_NAME = mwsEnv("MEWS_CLIENT_NAME") ?? "MAYA 0.1.0";

const MEWS_ENV =
  mwsEnv("MEWS_ENV") ?? mwsEnv("MAYA_MEWS_ENV") ?? "demo";

const DEFAULT_BASE_URLS: Record<string, string> = {
  demo: "https://api.mews-demo.com/api/connector/v1",
  production: "https://api.mews.com/api/connector/v1",
};

export function defaultMewsBaseUrl(): string {
  const fromEnv = mwsEnv("MEWS_BASE_URL") ?? mwsEnv("MAYA_MEWS_BASE_URL");
  if (fromEnv && fromEnv.startsWith("http")) return fromEnv.replace(/\/$/, "");
  return DEFAULT_BASE_URLS[MEWS_ENV] ?? DEFAULT_BASE_URLS.demo;
}

/**
 * Hosts MAYA is willing to call for Mews.
 *
 * A base URL that arrives in a request body is caller-controlled, and the
 * client builds every request as `${baseUrl}/${path}` — so without this
 * check any signed-in user could aim the server at a host of their choosing
 * and read the reply back through the error message (server-side request
 * forgery, with cloud metadata endpoints the usual target). The
 * env-configured URL is trusted because only the deployment can set it.
 */
export function isAllowedMewsBaseUrl(candidate: string): boolean {
  let origin: string;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return false;
    origin = parsed.origin;
  } catch {
    return false;
  }

  const allowed = new Set<string>();
  for (const url of Object.values(DEFAULT_BASE_URLS)) {
    allowed.add(new URL(url).origin);
  }
  const fromEnv = mwsEnv("MEWS_BASE_URL") ?? mwsEnv("MAYA_MEWS_BASE_URL");
  if (fromEnv && fromEnv.startsWith("http")) {
    try {
      allowed.add(new URL(fromEnv).origin);
    } catch {
      // A malformed env value simply contributes nothing to the allowlist.
    }
  }
  return allowed.has(origin);
}

/** Mews `reservations/getAll` rejects `StartUtc`/`EndUtc` spans over 100:00:00. */
const MEWS_MAX_INTERVAL_HOURS_CAP = 100;

function readOptionalPositiveInt(name: string): number | null {
  const raw = mwsEnv(name)?.trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Per-request chunk for `reservations/getAll` when splitting a long range.
 * Override with `MEWS_RESERVATIONS_WINDOW_HOURS`, or legacy `MEWS_RESERVATIONS_WINDOW_DAYS`
 * (converted to hours, capped at 100). Default 96 h matches legacy Python.
 */
function resolveFetchChunkHours(): number {
  const hours = readOptionalPositiveInt("MEWS_RESERVATIONS_WINDOW_HOURS");
  if (hours !== null) return Math.min(hours, MEWS_MAX_INTERVAL_HOURS_CAP);
  const days = readOptionalPositiveInt("MEWS_RESERVATIONS_WINDOW_DAYS");
  if (days !== null) return Math.min(days * 24, MEWS_MAX_INTERVAL_HOURS_CAP);
  return 96;
}

export const MEWS_MAX_FETCH_WINDOW_MS = resolveFetchChunkHours() * 60 * 60 * 1000;

/**
 * Legacy `reservations/getAll` (StartUtc/EndUtc) — include `Canceled` so we can
 * drop them locally; default API behavior omits canceled reservations.
 * @see https://docs.mews.com/connector-api/operations/reservations
 */
export const MEWS_RESERVATION_STATES = [
  "Enquired",
  "Confirmed",
  "Started",
  "Processed",
  "Canceled",
  "Optional",
  "Requested",
] as const;

/**
 * Wall-clock budget for one sync invocation. Same shape as the Cloudbeds
 * budget: stopping deliberately with a checkpoint beats being killed
 * arbitrarily with nothing written.
 */
export const MEWS_SYNC_BUDGET_MS = (() => {
  const n = Number.parseInt(mwsEnv("MEWS_SYNC_BUDGET_MS") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 210_000;
})();

/**
 * Incremental pulls re-read this far behind the watermark. Mews stamps
 * UpdatedUtc server-side, so the overlap only has to cover replication skew
 * and a run that stamped its watermark mid-write — not clock drift between us
 * and them.
 */
export const MEWS_INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000;

/** A full Colliding sweep at least this often — an Updated pull cannot see a
 *  booking nobody touched, so something has to look at everything sometimes. */
export const MEWS_FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
