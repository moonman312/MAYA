/**
 * ThinkReservations API client (fetch-based, Bearer auth, paced + paginated).
 * Mirrors the shape of _shared/mews/client.ts.
 *
 * Ground truth is Think's published OpenAPI document plus what they confirmed
 * directly: api.thinkreservations.com, Auth0 access tokens that live a day,
 * and 2 req/s being a safe rate (the "think" lane in ../pms/rate-limit.ts
 * spends less than that). Where live behaviour could diverge from the
 * document — object-parameter serialization, the page-size ceiling, the sort
 * grammar — the assumption lives in one exported symbol marked ⚠ VERIFY
 * live, so a probe against a real property changes exactly one place.
 */

import type { ThinkCredentials, ThinkPage, ThinkReservation } from "./types.ts";
import { acquire, record } from "../pms/rate-limit.ts";

type JsonRecord = Record<string, unknown>;

/** Thrown when Think returns a non-2xx HTTP status (caller may map 4xx vs 5xx). */
export class ThinkHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    /** Present when Think returned 429 and a Retry-After header (ms until retry). */
    readonly retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = "ThinkHttpError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parses Retry-After: seconds (integer) or HTTP-date. */
function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After")?.trim();
  if (!raw) return null;
  const sec = Number.parseInt(raw, 10);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

const MAX_ATTEMPTS = 6;

/** GET a Think endpoint with Bearer auth, pacing, and 429 backoff. */
export async function thinkGet(
  creds: ThinkCredentials,
  path: string,
  params: Record<string, string>,
  timeoutMs = 45_000,
): Promise<unknown> {
  const url = new URL(`${creds.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== "") url.searchParams.set(k, v);
  }

  // The token is the lane: MAYA holds one Think credential per property, so
  // pacing the token paces the property, and adding hotels adds budget
  // instead of dividing one lane among them.
  const lane = creds.accessToken;
  let backoffMs = 2000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Proactive, not just reactive. Think publishes no limit — only a person
    // saying 2 req/s is safe — which makes staying visibly polite the whole
    // contract. Backing off after a 429 still means the 429 happened.
    await acquire("think", lane);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new ThinkHttpError(
          `Think ${path} non-JSON (${res.status}): ${text.slice(0, 200)}`,
          res.status,
          path,
        );
      }

      if (res.status === 429) record("think", lane, "throttled");
      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        // Retry-After is honoured but capped: a broken or hostile header must
        // not park the whole invocation for as long as it likes.
        const waitMs = Math.min(parseRetryAfterMs(res) ?? backoffMs, 120_000);
        backoffMs = Math.min(backoffMs * 2, 120_000);
        await sleep(waitMs);
        continue;
      }

      if (res.ok) {
        record("think", lane, "ok");
        return data;
      }

      // Spring's default error body carries `message`; fall back to raw text
      // so an HTML error page still leaves something readable in the log.
      const rec = (data && typeof data === "object" ? data : {}) as JsonRecord;
      const msg =
        typeof rec.message === "string" && rec.message ? rec.message : text.slice(0, 300);
      throw new ThinkHttpError(
        `Think ${path} failed (${res.status}): ${msg}`,
        res.status,
        path,
        res.status === 429 ? parseRetryAfterMs(res) : null,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Think ${path}: retry loop fell through`);
}

/**
 * Flattens a reservation filter to the wire's own property names.
 *
 * ⚠ VERIFY live: the spec declares stayOnDateRange / updatedAtDateTimeRange /
 * createdAtDateTimeRange as REQUIRED object query parameters and never says
 * how an object serializes onto a query string. OpenAPI's default for query
 * objects (style=form, explode=true) and Spring's binder both flatten the
 * object's properties into bare parameters — stay_on_start_date=2026-08-01 —
 * which is what this emits, with absent bounds omitted so a filter can stay
 * open-ended. If a probe shows the server wants deepObject syntax
 * (stayOnDateRange[stay_on_start_date]=...) or rejects a missing range, this
 * function is the only place that changes.
 */
export function buildReservationRangeParams(filter: {
  updatedFrom?: Date;
  updatedTo?: Date;
  stayFrom?: string;
  stayTo?: string;
}): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.stayFrom) params.stay_on_start_date = filter.stayFrom;
  if (filter.stayTo) params.stay_on_end_date = filter.stayTo;
  if (filter.updatedFrom) params.updated_at_start_date_time = filter.updatedFrom.toISOString();
  if (filter.updatedTo) params.updated_at_end_date_time = filter.updatedTo.toISOString();
  return params;
}

/**
 * GET /v1/hotels → the hotels this token may read.
 *
 * `externalId`, not `id`, is what goes into `{hotelId}` path segments — every
 * hotelId parameter description says so for OAuth consumers — so an entry
 * without one cannot be addressed and is dropped here rather than passed
 * along to fail on every subsequent call.
 */
export type ThinkHotel = {
  id: string;
  externalId: string;
  name: string;
  timeZone: string | null;
  currencyCode: string | null;
};

export async function thinkGetHotels(creds: ThinkCredentials): Promise<ThinkHotel[]> {
  const data = await thinkGet(creds, "/v1/hotels", {});
  if (!Array.isArray(data)) return [];
  const hotels: ThinkHotel[] = [];
  for (const entry of data) {
    const rec = (entry && typeof entry === "object" ? entry : {}) as JsonRecord;
    const externalId = typeof rec.externalId === "string" ? rec.externalId : "";
    if (!externalId) continue;
    hotels.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : externalId,
      externalId,
      name: typeof rec.name === "string" ? rec.name : "",
      timeZone: typeof rec.timeZone === "string" && rec.timeZone ? rec.timeZone : null,
      currencyCode:
        typeof rec.currencyCode === "string" && rec.currencyCode ? rec.currencyCode : null,
    });
  }
  return hotels;
}

/** GET /v1/hotels/{hotelId}/room_types → raw array (id + name per the spec). */
export async function thinkGetRoomTypes(
  creds: ThinkCredentials,
  hotelId: string,
): Promise<JsonRecord[]> {
  const data = await thinkGet(
    creds,
    `/v1/hotels/${encodeURIComponent(hotelId)}/room_types`,
    {},
  );
  return Array.isArray(data) ? (data as JsonRecord[]) : [];
}

/**
 * ⚠ VERIFY live: the spec types `sort` as a bare string with an empty default
 * and never gives the grammar. The server pages Spring-style, where the
 * convention is `property` or `property,direction`; sorting by `id` keeps
 * rows from shuffling between pages while a walk is in flight. If a probe
 * shows the value is ignored the walk still terminates — it just loses its
 * ordering guarantee under concurrent writes.
 */
export const THINK_RESERVATIONS_SORT = "id";

/**
 * One page of GET /v1/hotels/{hotelId}/reservations.
 *
 * Narrows the Spring envelope to the fields a pager steers by. A payload
 * missing `last` reads as the final page on purpose: a truncated walk is
 * caught by the daily full sweep, a pager spinning on one page is caught by
 * nothing.
 */
export async function thinkGetReservationsPage(
  creds: ThinkCredentials,
  hotelId: string,
  rangeParams: Record<string, string>,
  page: number,
  size: number,
): Promise<ThinkPage<ThinkReservation>> {
  const data = await thinkGet(
    creds,
    `/v1/hotels/${encodeURIComponent(hotelId)}/reservations`,
    {
      ...rangeParams,
      page: String(page),
      size: String(size),
      sort: THINK_RESERVATIONS_SORT,
    },
  );
  const rec = (data && typeof data === "object" ? data : {}) as JsonRecord;
  return {
    content: Array.isArray(rec.content) ? (rec.content as ThinkReservation[]) : [],
    totalPages: typeof rec.totalPages === "number" ? rec.totalPages : 0,
    last: typeof rec.last === "boolean" ? rec.last : true,
    number: typeof rec.number === "number" ? rec.number : page,
  };
}
