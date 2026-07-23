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
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `${creds.tokenType || "Bearer"} ${creds.accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
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

      return rec;
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
      const res = await cloudbedsGet(creds, "getReservations", {
        propertyID: creds.propertyId,
        status,
        checkInFrom,
        checkInTo,
        pageNumber,
        pageSize: CLOUDBEDS_PAGE_SIZE,
      });
      pages += 1;
      const data = res.data;
      const chunk = Array.isArray(data) ? (data as CloudbedsReservation[]) : [];
      all.push(...chunk);

      // Stop when the page is short. If the API returns `total`, prefer that.
      const total = typeof res.total === "number" ? res.total : null;
      if (chunk.length < CLOUDBEDS_PAGE_SIZE) break;
      if (total != null && pageNumber * CLOUDBEDS_PAGE_SIZE >= total) break;
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
