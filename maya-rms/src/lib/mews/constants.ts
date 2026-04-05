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

/** Mews caps each reservations request at 100 hours; use 96h chunks like Python. */
export const MEWS_MAX_FETCH_WINDOW_MS = 96 * 60 * 60 * 1000;
