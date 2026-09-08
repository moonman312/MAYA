import {
  MEWS_CLIENT_NAME,
  MEWS_MAX_FETCH_WINDOW_MS,
  MEWS_RESERVATION_STATES,
} from "./constants.ts";
import type { ResolvedMewsCredentials } from "./types.ts";
import { acquire, record } from "../pms/rate-limit.ts";

type JsonRecord = Record<string, unknown>;

/** Thrown when Mews returns a non-2xx HTTP status (caller may map 4xx vs 5xx). */
export class MewsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    /** Present when Mews returned 429 and a Retry-After header (ms until retry). */
    readonly retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = "MewsHttpError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses Retry-After: seconds (integer) or HTTP-date. */
export function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After")?.trim();
  if (!raw) return null;
  const sec = Number.parseInt(raw, 10);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

const MEWS_POST_MAX_ATTEMPTS = 6;

function mergeListChunks(
  merged: JsonRecord,
  chunk: JsonRecord,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const part = chunk[key];
    if (Array.isArray(part)) {
      const acc = merged[key];
      if (Array.isArray(acc)) {
        (acc as unknown[]).push(...part);
      } else {
        merged[key] = [...part];
      }
    }
  }
}

/**
 * The AccessToken is what Mews meters, so it is what the limiter paces. Falls
 * back to the base URL when a caller has none — a shared lane is slower than
 * ideal but never over budget, which is the right way round.
 */
function laneKeyFor(payload: JsonRecord, baseUrl: string): string {
  const token = payload["AccessToken"];
  return typeof token === "string" && token ? token : baseUrl;
}

export async function mewsPost(
  baseUrl: string,
  path: string,
  payload: JsonRecord,
  timeoutMs = 60_000,
): Promise<JsonRecord> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  const lane = laneKeyFor(payload, baseUrl);
  let last429RetryAfterMs: number | null = null;
  let backoffMs = 2000;

  for (let attempt = 0; attempt < MEWS_POST_MAX_ATTEMPTS; attempt++) {
    // Proactive, not just reactive. Backing off after a 429 still means the 429
    // happened, and Mews count refusals against an integration — their own
    // guidance is that clients bring rate limiting rather than relying on being
    // told off. 200 requests per token per rolling 30s is the budget.
    await acquire("mews", lane);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Mews response was not JSON (${res.status}): ${text.slice(0, 200)}`);
      }

      if (res.ok) {
        record("mews", lane, "ok");
        return data as JsonRecord;
      }

      if (res.status === 429) record("mews", lane, "throttled");

      if (res.status === 429 && attempt < MEWS_POST_MAX_ATTEMPTS - 1) {
        const fromHeader = parseRetryAfterMs(res);
        last429RetryAfterMs = fromHeader;
        // Retry-After is honoured but capped: a broken or hostile header must
        // not park the whole invocation for as long as it likes.
        const waitMs = Math.min(fromHeader ?? backoffMs, 120_000);
        backoffMs = Math.min(backoffMs * 2, 120_000);
        await sleep(waitMs);
        continue;
      }

      const msg =
        typeof data === "object" && data && "Message" in data
          ? String((data as JsonRecord).Message)
          : text.slice(0, 300);
      throw new MewsHttpError(
        `Mews ${path} failed (${res.status}): ${msg}`,
        res.status,
        path,
        res.status === 429 ? (parseRetryAfterMs(res) ?? last429RetryAfterMs) : null,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Mews ${path}: POST retry loop fell through`);
}

function basePayload(creds: ResolvedMewsCredentials): JsonRecord {
  const body: JsonRecord = {
    ClientToken: creds.clientToken,
    AccessToken: creds.accessToken,
    Client: MEWS_CLIENT_NAME,
  };
  if (creds.enterpriseId) {
    body.EnterpriseIds = [creds.enterpriseId];
  }
  return body;
}

export async function mewsConfigurationGet(creds: ResolvedMewsCredentials): Promise<JsonRecord> {
  return mewsPost(creds.baseUrl, "configuration/get", basePayload(creds), 30_000);
}

async function fetchReservationsOneWindow(
  creds: ResolvedMewsCredentials,
  startUtc: string,
  endUtc: string,
  pageSize: number,
  timeFilter?: "Updated",
): Promise<JsonRecord> {
  const listKeys = ["Reservations", "ReservationItems", "Items"] as const;
  const basePayloadBody: JsonRecord = {
    ...basePayload(creds),
    StartUtc: startUtc,
    EndUtc: endUtc,
    // Omitted means Colliding — bookings whose stay overlaps the interval.
    // "Updated" turns the same interval into "changed within it", which is
    // what an incremental pull filters by.
    ...(timeFilter ? { TimeFilter: timeFilter } : {}),
    States: [...MEWS_RESERVATION_STATES],
    Extent: {
      Reservations: true,
      SpaceCategories: true,
      ResourceCategories: true,
      Items: true,
    },
    Limitation: { Count: pageSize },
  };

  let merged: JsonRecord = {};
  let cursor: string | null = null;
  let guard = 0;

  while (guard < 500) {
    guard += 1;
    const payload: JsonRecord = { ...basePayloadBody };
    if (cursor) {
      payload.Limitation = { Count: pageSize, Cursor: cursor };
    }

    const data = await mewsPost(creds.baseUrl, "reservations/getAll", payload);
    if (!Object.keys(merged).length) {
      merged = { ...data };
    } else {
      mergeListChunks(merged, data, listKeys);
    }

    const next = data.Cursor;
    if (!next || next === cursor) break;
    cursor = String(next);
  }

  return merged;
}

function parseUtcMs(iso: string): number {
  return new Date(iso.replace(/Z$/, "+00:00")).getTime();
}

function formatUtcChunkBoundary(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type MewsWindowVisit = {
  /** Zero-based position of this window in the whole range. */
  index: number;
  raw: JsonRecord;
  startUtc: string;
  endUtc: string;
};

/**
 * Walks [startUtc, endUtc) in chunks of at most {@link MEWS_MAX_FETCH_WINDOW_MS}
 * (default 96 h; Mews max interval 100:00:00), handing each window's payload to
 * the caller AS IT ARRIVES rather than merging the lot. A 426-day range is 107
 * windows, and holding all of them was hundreds of megabytes in one isolate —
 * the caller processes a window, drops it, and keeps only what it accumulates
 * on purpose.
 *
 * `onWindow` returning false stops the walk (a budget ran out); `fromIndex`
 * skips windows an earlier invocation already processed. Returns how far it
 * got and whether it covered the range.
 */
export async function mewsWalkReservationWindows(
  creds: ResolvedMewsCredentials,
  startUtc: string,
  endUtc: string,
  onWindow: (visit: MewsWindowVisit) => Promise<boolean>,
  opts: { pageSize?: number; timeFilter?: "Updated"; fromIndex?: number } = {},
): Promise<{ windowsFetched: number; lastIndex: number; completed: boolean }> {
  const t0 = parseUtcMs(startUtc);
  const t1 = parseUtcMs(endUtc);
  if (!(t1 > t0)) {
    return { windowsFetched: 0, lastIndex: -1, completed: true };
  }

  const pageSize = opts.pageSize ?? 1000;
  const fromIndex = opts.fromIndex ?? 0;
  let windowStart = t0;
  let index = 0;
  let windowsFetched = 0;
  let lastIndex = fromIndex - 1;

  while (windowStart < t1) {
    const windowEnd = Math.min(windowStart + MEWS_MAX_FETCH_WINDOW_MS, t1);
    if (index >= fromIndex) {
      const ws = formatUtcChunkBoundary(windowStart);
      const we = formatUtcChunkBoundary(windowEnd);
      const raw = await fetchReservationsOneWindow(creds, ws, we, pageSize, opts.timeFilter);
      windowsFetched += 1;
      lastIndex = index;
      const keepGoing = await onWindow({ index, raw, startUtc: ws, endUtc: we });
      if (!keepGoing) {
        return { windowsFetched, lastIndex, completed: windowEnd >= t1 };
      }
    }
    windowStart = windowEnd;
    index += 1;
  }

  return { windowsFetched, lastIndex, completed: true };
}
