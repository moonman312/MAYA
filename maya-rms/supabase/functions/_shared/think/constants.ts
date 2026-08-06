/**
 * ThinkReservations API constants.
 *
 * Think publishes a single production host — api.thinkreservations.com — and
 * confirmed it directly; there is no separate sandbox origin in their OpenAPI
 * document. The base URL stays env-overridable anyway so a staging proxy or a
 * recorded fixture server can stand in without a code change.
 */

import { mwsEnv } from "../mews/env.ts";

export const THINK_API_BASE_URL = (() => {
  const fromEnv = mwsEnv("THINK_API_BASE_URL");
  if (fromEnv && fromEnv.startsWith("http")) return fromEnv.replace(/\/$/, "");
  return "https://api.thinkreservations.com";
})();

/**
 * Wall-clock budget for one sync invocation. Same shape as the Cloudbeds and
 * Mews budgets: stopping deliberately with a checkpoint beats being killed
 * arbitrarily with nothing written. 210s leaves room inside a 300s tick for
 * the upserts, the reconcile and the evaluation that follow the pull.
 */
export const THINK_SYNC_BUDGET_MS = (() => {
  const n = Number.parseInt(mwsEnv("THINK_SYNC_BUDGET_MS") ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 210_000;
})();

/**
 * Page size for reservation pulls.
 *
 * The spec's declared default is 10, which is uselessly small at this lane's
 * 2 req/s: a 5,000-reservation property would be 500 requests — over four
 * minutes spent on paging alone, past the whole sync budget — where 200 a
 * page is 25 requests in under fifteen seconds. VERIFIED live 2026-08-05:
 * the envelope echoes size=200 back verbatim (500 too), so nothing clamps
 * at this value.
 */
export const THINK_PAGE_SIZE = Number(mwsEnv("THINK_PAGE_SIZE") ?? "200") || 200;

/**
 * Incremental pulls re-read this far behind the watermark. Think stamps
 * updatedAt server-side, so the overlap only has to cover replication skew
 * and a run that stamped its watermark mid-write — not clock drift between
 * us and them.
 */
export const THINK_INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000;

/** A full stay-window sweep at least this often — an updated_at pull cannot
 *  see a booking nobody touched, so something has to look at everything
 *  sometimes. */
export const THINK_FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
