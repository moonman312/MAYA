/** Mirrors `shared/legacy-python/config.py` Mews settings. */

export const MEWS_CLIENT_NAME = process.env.MEWS_CLIENT_NAME ?? "MAYA 0.1.0";

const MEWS_ENV = process.env.MEWS_ENV ?? process.env.MAYA_MEWS_ENV ?? "demo";

const DEFAULT_BASE_URLS: Record<string, string> = {
  demo: "https://api.mews-demo.com/api/connector/v1",
  production: "https://api.mews.com/api/connector/v1",
};

export function defaultMewsBaseUrl(): string {
  const fromEnv = process.env.MEWS_BASE_URL ?? process.env.MAYA_MEWS_BASE_URL;
  if (fromEnv && fromEnv.startsWith("http")) return fromEnv.replace(/\/$/, "");
  return DEFAULT_BASE_URLS[MEWS_ENV] ?? DEFAULT_BASE_URLS.demo;
}

/**
 * Mews limits each reservations/getAll time filter to at most ~3 months (docs).
 * Use up to 90 days per request to minimize round-trips (override via env).
 */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_DAYS = readPositiveIntEnv("MEWS_RESERVATIONS_WINDOW_DAYS", 90);

export const MEWS_MAX_FETCH_WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

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
