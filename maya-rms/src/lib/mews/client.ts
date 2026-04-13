import { MEWS_CLIENT_NAME, MEWS_MAX_FETCH_WINDOW_MS } from "@/lib/mews/constants";
import type { ResolvedMewsCredentials } from "@/lib/mews/types";

type JsonRecord = Record<string, unknown>;

/** Thrown when Mews returns a non-2xx HTTP status (caller may map 4xx vs 5xx). */
export class MewsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "MewsHttpError";
  }
}

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

export async function mewsPost(
  baseUrl: string,
  path: string,
  payload: JsonRecord,
  timeoutMs = 60_000,
): Promise<JsonRecord> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
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
    if (!res.ok) {
      const msg =
        typeof data === "object" && data && "Message" in data
          ? String((data as JsonRecord).Message)
          : text.slice(0, 300);
      throw new MewsHttpError(`Mews ${path} failed (${res.status}): ${msg}`, res.status, path);
    }
    return data as JsonRecord;
  } finally {
    clearTimeout(timer);
  }
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
): Promise<JsonRecord> {
  const listKeys = ["Reservations", "ReservationItems", "Items"] as const;
  const basePayloadBody: JsonRecord = {
    ...basePayload(creds),
    StartUtc: startUtc,
    EndUtc: endUtc,
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

/**
 * Fetches reservations for [startUtc, endUtc), splitting into ≤96h windows
 * (same strategy as `shared/legacy-python/api_client.py`).
 */
export async function mewsFetchReservationsRange(
  creds: ResolvedMewsCredentials,
  startUtc: string,
  endUtc: string,
  pageSize = 1000,
): Promise<{ data: JsonRecord; windows: number }> {
  const t0 = parseUtcMs(startUtc);
  const t1 = parseUtcMs(endUtc);
  if (!(t1 > t0)) {
    return { data: {}, windows: 0 };
  }

  const listKeys = ["Reservations", "ReservationItems", "Items"] as const;
  let merged: JsonRecord = {};
  let windowStart = t0;
  let windows = 0;

  while (windowStart < t1) {
    const windowEnd = Math.min(windowStart + MEWS_MAX_FETCH_WINDOW_MS, t1);
    const ws = formatUtcChunkBoundary(windowStart);
    const we = formatUtcChunkBoundary(windowEnd);
    const chunk = await fetchReservationsOneWindow(creds, ws, we, pageSize);
    windows += 1;

    if (!Object.keys(merged).length) {
      merged = { ...chunk };
    } else {
      mergeListChunks(merged, chunk, listKeys);
    }
    windowStart = windowEnd;
  }

  return { data: merged, windows };
}
