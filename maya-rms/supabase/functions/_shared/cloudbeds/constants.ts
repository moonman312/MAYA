/**
 * Cloudbeds classic PMS API constants.
 *
 * Cloudbeds runs two API generations concurrently —
 *   • Classic PMS API:  https://hotels.cloudbeds.com/api/v1.2/<method>
 *                       endpoints: getReservations, getReservation, getRoomTypes,
 *                       getRatePlans, getRate, getRateJobs, getTaxesAndFees, getHotels
 *   • New resource API: https://api.cloudbeds.com/<resource>/v1/...
 *                       (this is where the rate WRITE lives: rate_types/.../daily)
 * This adapter targets the CLASSIC PMS API because it exposes getReservations /
 * getRoomTypes directly and matches the e2e fixture's base_url.
 *
 * The host is settled, not a guess: scripts/cb-host-compare.mts runs every
 * mandatory RMS method against api.cloudbeds.com AND hotels.cloudbeds.com with a
 * live token, and on 2026-09-09 they answered identically — same statuses, same
 * row counts, same scope error on getTaxesAndFees. Either host works; the
 * default below is the one Cloudbeds documents for the classic API. Override
 * with CLOUDBEDS_API_BASE_URL or pms_connections.base_url if that ever changes.
 *
 * getUserInfo used to be listed here as a discovery endpoint. It is gone —
 * 404 on both hosts across v1.1/v1.2/v1.3. Property discovery uses getHotels.
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
 * Reservation statuses to pull.
 *
 * Verified against the live API 2026-09-10 — every value below is accepted, and
 * these are all of them: confirmed, not_confirmed, canceled, checked_in,
 * checked_out, no_show. We pull the "active demand" set and treat
 * canceled/no_show as removals.
 *
 * "cancelled" used to be in the canceled list as a defensive second spelling.
 * Cloudbeds only accept the American one and answer the British one with
 * "Parameter status is not valid" — so every full sweep spent one guaranteed
 * failing request, which cost nothing functionally (the same reservations come
 * back under "canceled") but showed as a red row in the property's own API log
 * and dragged its health below the healthy threshold.
 */
export const CLOUDBEDS_ACTIVE_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;
export const CLOUDBEDS_CANCELED_STATUSES = ["canceled", "no_show"] as const;

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

/**
 * Minimum ms between Cloudbeds calls on ONE property's credential.
 *
 * Verified July 2026 against developers.cloudbeds.com/docs/faq: 5 requests per
 * second for a property or group account, 10 for a tech partner. 220ms is 4.5/s,
 * which keeps a tenth of the budget in reserve for clock skew — the limit is
 * enforced on their clock, and requests we spaced correctly can still arrive
 * bunched.
 *
 * The pacing itself lives in _shared/pms/rate-limit.ts, which is per credential
 * rather than per process. This is kept as the tunable.
 */
export const CLOUDBEDS_MIN_REQUEST_INTERVAL_MS =
  Number(mwsEnv("CLOUDBEDS_MIN_REQUEST_INTERVAL_MS") ?? "220") || 220;

/**
 * Wall clock one scheduled sync may spend pulling reservation detail.
 *
 * The loop is one Cloudbeds call per reservation at 220ms apiece, so 300 seconds
 * of cron interval buys about 1,360 of them — a threshold a 30-room property
 * already passes. Left unbounded the invocation was simply killed, and because
 * the upsert ran after the loop, nothing was written: those hotels had no
 * reservation data at all and retried from scratch every five minutes.
 *
 * 210s leaves room inside a 300s tick for the upserts, the reconcile, the
 * evaluation and the room-count measurement that all follow.
 */
export const CLOUDBEDS_SYNC_BUDGET_MS =
  Number(mwsEnv("CLOUDBEDS_SYNC_BUDGET_MS") ?? "210000") || 210_000;

/**
 * How far back an incremental pull reaches beyond the watermark.
 *
 * Their clock is not ours, and a booking can be written while a sweep is
 * already running. Overlapping re-fetches a few unchanged reservations, which
 * costs a little; missing one silently loses a booking until the next full
 * sweep, which costs a wrong price.
 */
export const CLOUDBEDS_INCREMENTAL_OVERLAP_MS =
  Number(mwsEnv("CLOUDBEDS_INCREMENTAL_OVERLAP_MS") ?? "7200000") || 7_200_000;

/**
 * How often the whole check-in window is swept regardless of the watermark.
 *
 * An incremental pull can only ever see bookings someone touched, so anything a
 * dropped webhook, a clock skew or a mid-run failure lost stays lost until a
 * full pass looks again. Daily is frequent enough that no error survives a day
 * and rare enough that it costs one expensive run in 288.
 */
export const CLOUDBEDS_FULL_SYNC_INTERVAL_MS =
  Number(mwsEnv("CLOUDBEDS_FULL_SYNC_INTERVAL_MS") ?? "86400000") || 86_400_000;
