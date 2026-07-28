/**
 * Cloudbeds classic PMS API client (fetch-based, Bearer auth, paced + paginated).
 * Mirrors the shape of _shared/mews/client.ts.
 *
 * ⚠ VERIFY endpoint paths, query params, and response shapes against the live
 * Cloudbeds docs for the host/version your app is provisioned for. The methods
 * and the { success, data, count, total } envelope below match the classic
 * v1.x PMS API; confirm before hardening.
 */

import type { CloudbedsResolvedCredentials } from "./types.ts";
import {
  CLOUDBEDS_MIN_REQUEST_INTERVAL_MS,
  CLOUDBEDS_PAGE_SIZE,
} from "./constants.ts";

type JsonRecord = Record<string, unknown>;

export class CloudbedsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = "CloudbedsHttpError";
  }
}

/* ── Request logging (pluggable, fire-and-forget) ─────────────────────────── */

export type CloudbedsRequestLogEntry = {
  method: "GET" | "POST";
  endpoint: string;
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  message?: string;
};

let requestLogger: ((e: CloudbedsRequestLogEntry) => void) | null = null;

/**
 * Install a logger invoked once per cloudbedsGet/cloudbedsPost call with its
 * final outcome (429 retries are internal; only the attempt that resolves or
 * fails the call is reported). Never awaited and never allowed to throw, so
 * the callback must handle its own async errors (e.g. a void'ed insert).
 */
export function setCloudbedsRequestLogger(
  fn: ((e: CloudbedsRequestLogEntry) => void) | null,
): void {
  requestLogger = fn;
}

function emitRequestLog(entry: CloudbedsRequestLogEntry): void {
  if (!requestLogger) return;
  try {
    requestLogger(entry);
  } catch {
    // Logging must never break the request path.
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

/** Simple monotonic pacer so we stay under Cloudbeds' per-second limit. */
let lastRequestAt = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + CLOUDBEDS_MIN_REQUEST_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/** GET a Cloudbeds classic endpoint with Bearer auth, pacing, and 429 backoff. */
export async function cloudbedsGet(
  creds: CloudbedsResolvedCredentials,
  method: string,
  params: Record<string, string | number | undefined>,
  timeoutMs = 45_000,
): Promise<JsonRecord> {
  const url = new URL(`${creds.baseUrl.replace(/\/$/, "")}/${method.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  let backoffMs = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await pace();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let statusCode: number | null = null;
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `${creds.tokenType || "Bearer"} ${creds.accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      statusCode = res.status;
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new CloudbedsHttpError(
          `Cloudbeds ${method} non-JSON (${res.status}): ${text.slice(0, 200)}`,
          res.status,
          method,
        );
      }

      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const retry = parseRetryAfterMs(res) ?? Math.min(backoffMs, 60_000);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        await sleep(retry);
        continue;
      }

      const rec = (data ?? {}) as JsonRecord;

      if (!res.ok || rec.success === false) {
        const msg =
          typeof rec.message === "string" ? rec.message : text.slice(0, 300);
        throw new CloudbedsHttpError(
          `Cloudbeds ${method} failed (${res.status}): ${msg}`,
          res.ok ? 400 : res.status,
          method,
          res.status === 429 ? parseRetryAfterMs(res) : null,
        );
      }

      emitRequestLog({
        method: "GET",
        endpoint: method,
        statusCode,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return rec;
    } catch (error) {
      emitRequestLog({
        method: "GET",
        endpoint: method,
        statusCode,
        ok: false,
        durationMs: Date.now() - startedAt,
        message: errorText(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Cloudbeds ${method}: retry loop fell through`);
}

/**
 * Discover the property id for the connected user (used when it wasn't stored
 * at connect time). ⚠ VERIFY: classic API exposes this via getUserInfo (returns
 * property_id) or getHotels (list). Adjust the field extraction to match.
 */
export async function cloudbedsDiscoverPropertyId(
  creds: Omit<CloudbedsResolvedCredentials, "propertyId">,
): Promise<string | null> {
  const withCreds: CloudbedsResolvedCredentials = { ...creds, propertyId: "" };
  try {
    const info = await cloudbedsGet(withCreds, "getUserInfo", {});
    const data = (info.data ?? info) as JsonRecord;
    const pid = data.property_id ?? data.propertyID ?? data.propertyId;
    if (pid != null) return String(pid);
  } catch {
    // fall through to getHotels
  }
  try {
    const hotels = await cloudbedsGet(withCreds, "getHotels", {});
    const arr = hotels.data;
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as JsonRecord;
      const pid = first.propertyID ?? first.property_id ?? first.id;
      if (pid != null) return String(pid);
    }
  } catch {
    // no-op
  }
  return null;
}

export type CloudbedsPropertyDetails = {
  externalPropertyId: string;
  name: string | null;
  timezone: string | null;
  currency: string | null;
};

/**
 * getHotelDetails → property name / timezone / currency, used by onboarding to
 * create the hotel record so the user doesn't have to type anything.
 * ⚠ VERIFY field names against the live response: propertyName,
 * propertyTimezone, propertyCurrency (currency may nest as {currencyCode}).
 */
export async function cloudbedsGetHotelDetails(
  creds: CloudbedsResolvedCredentials,
): Promise<CloudbedsPropertyDetails> {
  const res = await cloudbedsGet(creds, "getHotelDetails", {
    propertyID: creds.propertyId,
  });
  const data = (res.data && typeof res.data === "object" ? res.data : res) as JsonRecord;

  const name = data.propertyName ?? data.hotelName ?? data.name;
  const timezone = data.propertyTimezone ?? data.timezone ?? data.timeZone;
  const currencyRaw = data.propertyCurrency ?? data.currency ?? data.currencyCode;
  const currency =
    currencyRaw && typeof currencyRaw === "object"
      ? (currencyRaw as JsonRecord).currencyCode ?? (currencyRaw as JsonRecord).code
      : currencyRaw;

  return {
    externalPropertyId: creds.propertyId,
    name: typeof name === "string" && name ? name : null,
    timezone: typeof timezone === "string" && timezone ? timezone : null,
    currency: typeof currency === "string" && currency ? currency.toUpperCase() : null,
  };
}

export type CloudbedsRoomType = JsonRecord;

/** getRoomTypes → data[] of room types for the property. */
export async function cloudbedsGetRoomTypes(
  creds: CloudbedsResolvedCredentials,
): Promise<CloudbedsRoomType[]> {
  const res = await cloudbedsGet(creds, "getRoomTypes", { propertyID: creds.propertyId });
  const data = res.data;
  return Array.isArray(data) ? (data as CloudbedsRoomType[]) : [];
}

export type CloudbedsReservation = JsonRecord;

/**
 * getReservations across a check-in window, following pageNumber pagination.
 * ⚠ VERIFY param names: propertyID, status, checkInFrom, checkInTo,
 * pageNumber, pageSize; and the total/count fields used to stop paging.
 */
/**
 * Fetch ONE page of getReservations for one status. The building block for
 * both the full-range loop below and the onboarding worker's checkpointed
 * historical pull (which persists its cursor between pages).
 */
export async function cloudbedsGetReservationsPage(
  creds: CloudbedsResolvedCredentials,
  checkInFrom: string,
  checkInTo: string,
  status: string,
  pageNumber: number,
): Promise<{ reservations: CloudbedsReservation[]; hasMore: boolean }> {
  const res = await cloudbedsGet(creds, "getReservations", {
    propertyID: creds.propertyId,
    status,
    checkInFrom,
    checkInTo,
    pageNumber,
    pageSize: CLOUDBEDS_PAGE_SIZE,
  });
  const data = res.data;
  const chunk = Array.isArray(data) ? (data as CloudbedsReservation[]) : [];

  // Short page = done. If the API returns `total`, prefer that.
  const total = typeof res.total === "number" ? res.total : null;
  let hasMore = chunk.length >= CLOUDBEDS_PAGE_SIZE;
  if (total != null && pageNumber * CLOUDBEDS_PAGE_SIZE >= total) hasMore = false;

  return { reservations: chunk, hasMore };
}

export async function cloudbedsGetReservationsRange(
  creds: CloudbedsResolvedCredentials,
  checkInFrom: string,
  checkInTo: string,
  statuses: readonly string[],
): Promise<{ reservations: CloudbedsReservation[]; pages: number }> {
  const all: CloudbedsReservation[] = [];
  let pages = 0;

  // Cloudbeds "status" filters one value per call on the classic API; loop them.
  for (const status of statuses) {
    let pageNumber = 1;
    let guard = 0;
    while (guard < 1000) {
      guard += 1;
      const { reservations, hasMore } = await cloudbedsGetReservationsPage(
        creds,
        checkInFrom,
        checkInTo,
        status,
        pageNumber,
      );
      pages += 1;
      all.push(...reservations);
      if (!hasMore) break;
      pageNumber += 1;
    }
  }

  return { reservations: all, pages };
}

/** getReservation detail (per-night / per-room rates). ⚠ VERIFY response shape. */
export async function cloudbedsGetReservationDetail(
  creds: CloudbedsResolvedCredentials,
  reservationId: string,
): Promise<JsonRecord | null> {
  try {
    const res = await cloudbedsGet(creds, "getReservation", {
      propertyID: creds.propertyId,
      reservationID: reservationId,
    });
    const data = res.data;
    return (data && typeof data === "object" ? (data as JsonRecord) : res) ?? null;
  } catch {
    return null;
  }
}

/* ── Rate PUSH (write) — outbound to Cloudbeds ─────────────────────────────── */

/** POST a JSON body to a Cloudbeds classic endpoint (Bearer auth, paced, 429 backoff). */
export async function cloudbedsPost(
  creds: CloudbedsResolvedCredentials,
  method: string,
  body: JsonRecord,
  timeoutMs = 45_000,
): Promise<JsonRecord> {
  const url = `${creds.baseUrl.replace(/\/$/, "")}/${method.replace(/^\//, "")}`;
  let backoffMs = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await pace();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let statusCode: number | null = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `${creds.tokenType || "Bearer"} ${creds.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      statusCode = res.status;
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new CloudbedsHttpError(
          `Cloudbeds ${method} non-JSON (${res.status}): ${text.slice(0, 200)}`,
          res.status,
          method,
        );
      }
      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const retry = parseRetryAfterMs(res) ?? Math.min(backoffMs, 60_000);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        await sleep(retry);
        continue;
      }
      const rec = (data ?? {}) as JsonRecord;
      if (!res.ok || rec.success === false) {
        const msg = typeof rec.message === "string" ? rec.message : text.slice(0, 300);
        throw new CloudbedsHttpError(
          `Cloudbeds ${method} failed (${res.status}): ${msg}`,
          res.ok ? 400 : res.status,
          method,
          res.status === 429 ? parseRetryAfterMs(res) : null,
        );
      }
      emitRequestLog({
        method: "POST",
        endpoint: method,
        statusCode,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return rec;
    } catch (error) {
      emitRequestLog({
        method: "POST",
        endpoint: method,
        statusCode,
        ok: false,
        durationMs: Date.now() - startedAt,
        message: errorText(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Cloudbeds ${method}: retry loop fell through`);
}

/**
 * getRatePlans → data[] of rate plans (used to map roomTypeID → base rateID).
 * Cloudbeds requires a startDate/endDate window even when we only want the
 * rate-plan catalog, so the caller passes a small range.
 */
export async function cloudbedsGetRatePlans(
  creds: CloudbedsResolvedCredentials,
  startDate: string,
  endDate: string,
): Promise<JsonRecord[]> {
  const res = await cloudbedsGet(creds, "getRatePlans", {
    propertyID: creds.propertyId,
    startDate,
    endDate,
  });
  const data = res.data;
  return Array.isArray(data) ? (data as JsonRecord[]) : [];
}

export type CloudbedsRateInterval = { startDate: string; endDate: string; rate: number };

/**
 * patchRate — push nightly rates. One rateID maps to an array of intervals.
 * Cloudbeds allows up to 30 intervals per call; the caller chunks accordingly.
 * The endpoint is async and returns a jobReferenceID.
 * @see https://developers.cloudbeds.com/docs/revenue-management-system-rms
 * ⚠ VERIFY the exact success/error envelope + jobReferenceID field for your app.
 */
export async function cloudbedsPatchRate(
  creds: CloudbedsResolvedCredentials,
  rateID: string,
  intervals: CloudbedsRateInterval[],
): Promise<{ ok: true; jobReferenceID: string | null } | { ok: false; error: string }> {
  try {
    const res = await cloudbedsPost(creds, "patchRate", {
      propertyID: creds.propertyId,
      rates: [{ rateID, interval: intervals }],
    });
    const job =
      (typeof res.jobReferenceID === "string" && res.jobReferenceID) ||
      (typeof (res.data as JsonRecord)?.jobReferenceID === "string" &&
        String((res.data as JsonRecord).jobReferenceID)) ||
      null;
    return { ok: true, jobReferenceID: job };
  } catch (e) {
    return { ok: false, error: e instanceof CloudbedsHttpError ? e.message : String(e) };
  }
}
