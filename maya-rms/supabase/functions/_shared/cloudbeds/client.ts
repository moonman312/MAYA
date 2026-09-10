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
import { acquire, record } from "../pms/rate-limit.ts";
import {
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

/**
 * Which lane a request paces in.
 *
 * The property id, because that is what Cloudbeds meters: their limit is 5
 * requests a second for a property or group account, and MAYA holds one OAuth
 * credential per property. The old pacer was a single module-level timestamp
 * shared by every hotel in the isolate, which made the fleet slower as it grew
 * — twenty hotels queued behind one 220ms gap — while doing nothing extra to
 * protect any individual property's budget, which is the one Cloudbeds actually
 * suspends.
 */
function laneKeyFor(creds: CloudbedsResolvedCredentials): string {
  return creds.propertyId || creds.baseUrl;
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

  const lane = laneKeyFor(creds);
  let backoffMs = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await acquire("cloudbeds", lane);
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

      if (res.status === 429) record("cloudbeds", lane, "throttled");
      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        // Retry-After is honoured but capped: a broken or hostile header must
        // not park the whole invocation for as long as it likes.
        const retry = Math.min(parseRetryAfterMs(res) ?? backoffMs, 60_000);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        await sleep(retry);
        continue;
      }
      if (res.ok) record("cloudbeds", lane, "ok");

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
 * at connect time).
 *
 * getHotels is the only way in. This used to try getUserInfo first, but that
 * method is gone: it answers 404 with Cloudbeds' website HTML on every host and
 * every version (api. and hotels., v1.1/v1.2/v1.3 — checked live 2026-09-09).
 * The 404 was swallowed, so nothing broke; it just meant every new connection
 * spent a guaranteed-failing round trip that landed in pms_request_log and
 * dragged the property's success rate below the healthy threshold.
 */
export async function cloudbedsDiscoverPropertyId(
  creds: Omit<CloudbedsResolvedCredentials, "propertyId">,
): Promise<string | null> {
  const withCreds: CloudbedsResolvedCredentials = { ...creds, propertyId: "" };
  try {
    const hotels = await cloudbedsGet(withCreds, "getHotels", {});
    const arr = hotels.data;
    if (!Array.isArray(arr) || arr.length === 0) return null;

    // Exactly one, or nothing. This used to take arr[0], which is right for a
    // property account and silently wrong for a group: Cloudbeds' own words are
    // that a group user's grant "will provide data for the entire group", and
    // the order it lists them in means nothing. Guessing bound a MAYA hotel to
    // an arbitrary sibling and then PUSHED RATES to it — a wrong-property write
    // is far worse than a connection that says it needs help. Callers that can
    // handle a group use cloudbedsListProperties and decide deliberately.
    if (arr.length > 1) {
      console.error(
        JSON.stringify({
          fn: "cloudbedsDiscoverPropertyId",
          error: "ambiguous_group_grant",
          count: arr.length,
        }),
      );
      return null;
    }

    const only = arr[0] as JsonRecord;
    const pid = only.propertyID ?? only.property_id ?? only.id;
    if (pid != null) return String(pid);
  } catch {
    // no-op
  }
  return null;
}

/** Every property this grant can see. One entry = a property account; more = a group. */
export type CloudbedsPropertySummary = { propertyId: string; name: string | null };

/**
 * List the properties a grant covers.
 *
 * A group-account grant returns the whole group — Cloudbeds' own words: "when
 * the group user authorizes the connection, the access token or API keys will
 * provide data for the entire group". cloudbedsDiscoverPropertyId takes the
 * FIRST of these, which is right for a property account and silently wrong for
 * a group, so callers that care use this and decide deliberately.
 */
export async function cloudbedsListProperties(
  creds: Omit<CloudbedsResolvedCredentials, "propertyId">,
): Promise<CloudbedsPropertySummary[]> {
  const withCreds: CloudbedsResolvedCredentials = { ...creds, propertyId: "" };
  try {
    const res = await cloudbedsGet(withCreds, "getHotels", {});
    const arr = res.data;
    if (!Array.isArray(arr)) return [];
    return (arr as JsonRecord[])
      .map((h) => ({
        propertyId: String(h.propertyID ?? h.property_id ?? h.id ?? ""),
        name: h.propertyName != null ? String(h.propertyName) : null,
      }))
      .filter((p) => p.propertyId !== "");
  } catch {
    return [];
  }
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
  modifiedFrom?: string,
): Promise<{ reservations: CloudbedsReservation[]; hasMore: boolean }> {
  const res = await cloudbedsGet(creds, "getReservations", {
    propertyID: creds.propertyId,
    status,
    checkInFrom,
    checkInTo,
    // cloudbedsGet drops undefined and "", so omitting it is a full sweep.
    modifiedFrom,
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

/**
 * `modifiedFrom` is real but undocumented, and the way Cloudbeds handles unknown
 * parameters makes that easy to get wrong: they are silently ignored and the
 * full set comes back, so `modifiedSince`, `updatedFrom` and `lastModified` all
 * LOOK like they work. Verified against the live API — a future `modifiedFrom`
 * returns zero rows where those return everything.
 *
 * Format is `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`. ISO-8601 with T and Z is
 * rejected outright, so this formats rather than calling toISOString().
 */
export function cloudbedsTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function cloudbedsGetReservationsRange(
  creds: CloudbedsResolvedCredentials,
  checkInFrom: string,
  checkInTo: string,
  statuses: readonly string[],
  /** Only reservations touched since this. Omit for a full sweep. */
  modifiedFrom?: string,
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
        modifiedFrom,
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
  const lane = laneKeyFor(creds);
  let backoffMs = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await acquire("cloudbeds", lane);
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
      if (res.status === 429) record("cloudbeds", lane, "throttled");
      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        // Retry-After is honoured but capped: a broken or hostile header must
        // not park the whole invocation for as long as it likes.
        const retry = Math.min(parseRetryAfterMs(res) ?? backoffMs, 60_000);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        await sleep(retry);
        continue;
      }
      if (res.ok) record("cloudbeds", lane, "ok");
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
  opts: { detailedRates?: boolean } = {},
): Promise<JsonRecord[]> {
  // detailedRates adds roomRateDetailed[]: one entry per night with rate,
  // roomsAvailable, minLos/maxLos and the CTA/CTD flags. Cloudbeds requires
  // this parameter for RMS certification, and it is also the only way to read
  // a per-night rate — without it a multi-day window collapses to one
  // aggregated roomRate per plan.
  const res = await cloudbedsGet(creds, "getRatePlans", {
    propertyID: creds.propertyId,
    startDate,
    endDate,
    ...(opts.detailedRates ? { detailedRates: "true" } : {}),
  });
  const data = res.data;
  return Array.isArray(data) ? (data as JsonRecord[]) : [];
}

/**
 * getTaxesAndFees → the property's configured taxes and fees.
 *
 * Cloudbeds names this a mandatory call for RMS integrations: it is how a
 * partner establishes whether the rates it reads and writes are tax-inclusive
 * or tax-exclusive. MAYA reads and writes the same `rate` field, so it already
 * round-trips consistently — this records WHICH basis the property is on so
 * that is a stated fact rather than an accident.
 *
 * Requires a tax scope the property must grant. Verified 2026-09-08 against the
 * sandbox: without it Cloudbeds answers HTTP 200 with success:false and
 * "Scope required for this call was not granted by property." Callers treat
 * that as "unknown", never as an error worth failing a sync over.
 */
export async function cloudbedsGetTaxesAndFees(
  creds: CloudbedsResolvedCredentials,
): Promise<{ ok: true; taxes: JsonRecord[] } | { ok: false; reason: string }> {
  try {
    const res = await cloudbedsGet(creds, "getTaxesAndFees", { propertyID: creds.propertyId });
    const data = res.data;
    if (Array.isArray(data)) return { ok: true, taxes: data as JsonRecord[] };
    if (data && typeof data === "object") return { ok: true, taxes: [data as JsonRecord] };
    return { ok: false, reason: "unexpected_shape" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "request_failed" };
  }
}

/** One entry from getRateJobs: the outcome of a patchRate we already sent. */
export type CloudbedsRateJob = {
  jobReferenceID: string;
  status: string;
  dateCreated: string | null;
  updates: { rateID?: string; startDate?: string; endDate?: string; rate?: number; message?: string }[];
};

/**
 * getRateJobs → what actually happened to the rate updates we posted.
 *
 * patchRate is asynchronous: a 200 means the job was QUEUED, not that the rate
 * landed. Cloudbeds names validating those jobs a mandatory part of an RMS
 * integration, and without it an accepted-but-failed job looks live forever —
 * worse, our own idempotency ledger then suppresses the retry, because it
 * already recorded a successful push at that price.
 *
 * Verified live 2026-09-08: a job posted through cloudbedsPatchRate came back
 * within four seconds as { jobReferenceID, dateCreated, status: "completed",
 * updates: [{ rateID, action, startDate, endDate, rate, message }] }.
 */
export async function cloudbedsGetRateJobs(
  creds: CloudbedsResolvedCredentials,
): Promise<CloudbedsRateJob[]> {
  const res = await cloudbedsGet(creds, "getRateJobs", { propertyID: creds.propertyId });
  const data = res.data;
  if (!Array.isArray(data)) return [];
  return (data as JsonRecord[]).map((j) => ({
    jobReferenceID: String(j.jobReferenceID ?? ""),
    status: String(j.status ?? "unknown"),
    dateCreated: j.dateCreated != null ? String(j.dateCreated) : null,
    updates: Array.isArray(j.updates) ? (j.updates as CloudbedsRateJob["updates"]) : [],
  }));
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

/**
 * POST a Cloudbeds method with a form-encoded body.
 *
 * Their API is not consistent about this: patchRate accepts JSON, while
 * postWebhook and deleteWebhook answer "Parameter endpointUrl is required" to a
 * JSON body and only read application/x-www-form-urlencoded (verified against
 * the live sandbox 2026-09-10). Their own cURL examples for webhooks use form
 * encoding, so this follows the docs rather than the sibling endpoint.
 */
async function cloudbedsPostForm(
  creds: CloudbedsResolvedCredentials,
  method: string,
  fields: Record<string, string>,
  timeoutMs = 30_000,
): Promise<JsonRecord> {
  const url = `${creds.baseUrl.replace(/\/$/, "")}/${method.replace(/^\//, "")}`;
  const lane = laneKeyFor(creds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let statusCode: number | null = null;
  await acquire("cloudbeds", lane);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `${creds.tokenType || "Bearer"} ${creds.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(fields).toString(),
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
    const rec = (data ?? {}) as JsonRecord;
    if (!res.ok || rec.success === false) {
      const msg = typeof rec.message === "string" ? rec.message : text.slice(0, 300);
      throw new CloudbedsHttpError(
        `Cloudbeds ${method} failed (${res.status}): ${msg}`,
        res.ok ? 400 : res.status,
        method,
      );
    }
    emitRequestLog({ method: "POST", endpoint: method, statusCode, ok: true, durationMs: Date.now() - startedAt });
    return rec;
  } catch (error) {
    emitRequestLog({
      method: "POST", endpoint: method, statusCode, ok: false,
      durationMs: Date.now() - startedAt, message: errorText(error),
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Webhook subscriptions ─────────────────────────────────────────────────
 *
 * Cloudbeds require an app that cannot be disconnected from its own UI to
 * subscribe to `integration/appstate_changed`, so it learns immediately when a
 * property uninstalls it rather than on the next 401. Verified against the live
 * sandbox 2026-09-10: getWebhooks answers on both hosts and on v1.2 and v1.3
 * alike, so these ride the same baseUrl as everything else.
 * @see https://developers.cloudbeds.com/docs/connecting-disconnecting-apps
 */

export type CloudbedsWebhook = {
  id: string;
  entity: string | null;
  action: string | null;
  url: string | null;
};

/** Every webhook subscription this grant can see. */
export async function cloudbedsGetWebhooks(
  creds: CloudbedsResolvedCredentials,
): Promise<CloudbedsWebhook[]> {
  const res = await cloudbedsGet(creds, "getWebhooks", {});
  const rows = Array.isArray(res.data) ? res.data : [];
  return rows.map((r) => {
    const row = r as JsonRecord;
    const event = (row.event ?? {}) as JsonRecord;
    const sub = (row.subscriptionData ?? {}) as JsonRecord;
    return {
      id: String(row.id ?? ""),
      entity: typeof event.entity === "string" ? event.entity : null,
      action: typeof event.action === "string" ? event.action : null,
      url: typeof sub.url === "string" ? sub.url : null,
    };
  });
}

/** Subscribe to one object/action pair. Cloudbeds reject "all actions". */
export async function cloudbedsPostWebhook(
  creds: CloudbedsResolvedCredentials,
  object: string,
  action: string,
  endpointUrl: string,
): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  try {
    const res = await cloudbedsPostForm(creds, "postWebhook", {
      // Optional per Cloudbeds, and only needed to disambiguate a group grant.
      // Flow B has no property id yet at connect time — it is discovered on the
      // first sync — so send it when known and let them infer it when not.
      ...(creds.propertyId ? { propertyID: creds.propertyId } : {}),
      object,
      action,
      endpointUrl,
    });
    const data = (res.data ?? {}) as JsonRecord;
    const id =
      (typeof data.subscriptionID === "string" && data.subscriptionID) ||
      (typeof data.id === "string" && data.id) ||
      null;
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof CloudbedsHttpError ? e.message : String(e) };
  }
}

/**
 * Remove a subscription.
 *
 * Cloudbeds' docs say to pass `subscriptionID`. The live API disagrees: it
 * answers "Parameter endpointUrl is required" to that, then "Parameter object is
 * required" once the URL is supplied. What it actually wants is the same triple
 * used to create the subscription — object, action and endpointUrl. Verified
 * against the sandbox 2026-09-10.
 *
 * ⚠ It also answers { success: true } WITHOUT deleting: the subscription is
 * still listed by getWebhooks minutes later. Treat a success here as "asked",
 * not "gone", and never rely on it to retire an endpoint — retire the endpoint
 * itself so stale deliveries 404 instead.
 */
export async function cloudbedsDeleteWebhook(
  creds: CloudbedsResolvedCredentials,
  object: string,
  action: string,
  endpointUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await cloudbedsPostForm(creds, "deleteWebhook", { object, action, endpointUrl });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof CloudbedsHttpError ? e.message : String(e) };
  }
}
