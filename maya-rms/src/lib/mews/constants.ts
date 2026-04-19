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

/** Mews `reservations/getAll` rejects `StartUtc`/`EndUtc` spans over 100:00:00. */
const MEWS_MAX_INTERVAL_HOURS_CAP = 100;

function readOptionalPositiveInt(name: string): number | null {
  const raw = process.env[name]?.trim();
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
