/**
 * Cloudbeds classic PMS API constants.
 *
 * ⚠ VERIFY AGAINST LIVE DOCS (your plan doc flags this explicitly):
 * Cloudbeds runs two API generations concurrently right now —
 *   • Classic PMS API:  https://hotels.cloudbeds.com/api/v1.2/<method>
 *                       (also historically reachable at https://api.cloudbeds.com/api/v1.2)
 *                       endpoints: getReservations, getReservation, getRoomTypes, getRatePlans, getUserInfo
 *   • New resource API: https://api.cloudbeds.com/<resource>/v1/...
 * This adapter targets the CLASSIC PMS API because it exposes getReservations /
 * getRoomTypes directly and matches the e2e fixture's base_url. Confirm the host
 * + version your sandbox app is provisioned for, then set CLOUDBEDS_API_BASE_URL
 * (or pms_connections.base_url) accordingly — no code change needed to move it.
 *
 * Auth: Authorization: Bearer <access_token>   (OAuth tokens look like cbat_***)
 */

import { mwsEnv } from "../mews/env.ts";

const DEFAULT_BASE_URL = "https://hotels.cloudbeds.com/api/v1.2";

export function defaultCloudbedsBaseUrl(): string {
  const fromEnv = mwsEnv("CLOUDBEDS_API_BASE_URL") ?? mwsEnv("CLOUDBEDS_BASE_URL");
  if (fromEnv && fromEnv.startsWith("http")) return fromEnv.replace(/\/$/, "");
  return DEFAULT_BASE_URL;
}

/**
 * Reservation statuses to pull. Cloudbeds statuses:
 * confirmed, not_confirmed, canceled, checked_in, checked_out, no_show.
 * We pull the "active demand" set and treat canceled/no_show as removals.
 * ⚠ VERIFY status string spellings against your account's API responses.
 */
export const CLOUDBEDS_ACTIVE_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;
export const CLOUDBEDS_CANCELED_STATUSES = ["canceled", "cancelled", "no_show"] as const;

/** getReservations page size (Cloudbeds classic pages via pageNumber/pageSize). */
export const CLOUDBEDS_PAGE_SIZE = Number(mwsEnv("CLOUDBEDS_PAGE_SIZE") ?? "100") || 100;

/**
 * Whether to fetch per-reservation detail (getReservation) to obtain true
 * per-night rates. When false, nightly rate = reservation total / nights.
 * Detail calls are 1 request per reservation → gated by rate limits; keep off
 * for large full syncs, on for incremental syncs.
 */
export const CLOUDBEDS_FETCH_RATE_DETAIL =
  (mwsEnv("CLOUDBEDS_FETCH_RATE_DETAIL") ?? "false").toLowerCase() === "true";

/** Minimum ms between Cloudbeds calls (~5 req/s → 200ms). ⚠ VERIFY current limits. */
export const CLOUDBEDS_MIN_REQUEST_INTERVAL_MS =
  Number(mwsEnv("CLOUDBEDS_MIN_REQUEST_INTERVAL_MS") ?? "220") || 220;
