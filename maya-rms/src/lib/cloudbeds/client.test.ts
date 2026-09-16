import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({
  acquire: vi.fn(async () => {}),
  record: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/pms/rate-limit.ts", () => limiter);

import {
  cloudbedsGet,
  cloudbedsGetReservationsWithRateDetailsPage,
  cloudbedsPost,
} from "../../../supabase/functions/_shared/cloudbeds/client";

const CREDS = {
  accessToken: "cbat_test",
  tokenType: "Bearer",
  baseUrl: "https://api.test",
  propertyId: "prop-1",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

beforeEach(() => {
  vi.useFakeTimers();
  limiter.acquire.mockClear();
  limiter.record.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cloudbeds 429 handling", () => {
  it("caps a runaway Retry-After at the backoff ceiling", async () => {
    // Honouring the header verbatim hands the PMS control of our wall clock: a
    // single Retry-After: 3600 would park the whole invocation for an hour.
    const responses = [
      json(429, {}, { "Retry-After": "3600" }),
      json(200, { success: true, data: [] }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    let settled = false;
    const p = cloudbedsGet(CREDS, "getRoomTypes", {}).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toMatchObject({ success: true });
  });

  it("feeds the breaker from the write path too", async () => {
    // Rate pushes throttle the same credential the reads do; a 429 the breaker
    // never hears about can't park it.
    const responses = [json(429, {}, { "Retry-After": "1" }), json(200, { success: true })];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    const p = cloudbedsPost(CREDS, "patchRate", {});
    await vi.advanceTimersByTimeAsync(2_000);
    await p;

    expect(limiter.record).toHaveBeenCalledWith("cloudbeds", "prop-1", "throttled");
    expect(limiter.record).toHaveBeenCalledWith("cloudbeds", "prop-1", "ok");
  });
});

describe("getReservationsWithRateDetails paging", () => {
  function captureUrls(pages: Array<{ data: unknown[]; total: number }>) {
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(new URL(url));
        const page = pages.shift()!;
        return json(200, { success: true, ...page });
      }),
    );
    return urls;
  }

  it("filters by check-out and modifiedFrom only, pages at 100, and never asks for guest details", async () => {
    const urls = captureUrls([{ data: Array.from({ length: 100 }, (_, i) => ({ reservationID: String(i) })), total: 130 }]);

    const page = await cloudbedsGetReservationsWithRateDetailsPage(
      CREDS,
      { checkOutFrom: "2026-08-17", modifiedFrom: "2026-09-16 10:00:00" },
      1,
    );

    expect(page).toMatchObject({ hasMore: true, total: 130 });
    const params = Object.fromEntries(urls[0].searchParams);
    expect(urls[0].pathname).toBe("/getReservationsWithRateDetails");
    expect(params).toEqual({
      propertyID: "prop-1",
      reservationCheckOutFrom: "2026-08-17",
      modifiedFrom: "2026-09-16 10:00:00",
      pageNumber: "1",
      pageSize: "100",
    });
    // Both are silently ignored by this endpoint; sending them only looks like filtering.
    expect(params).not.toHaveProperty("status");
    expect(params).not.toHaveProperty("checkInFrom");
    // Adds emails, phones and identity documents. Never.
    expect(params).not.toHaveProperty("includeGuestsDetails");
  });

  it("stops on the page that reaches the total, even when it is full", async () => {
    captureUrls([{ data: Array.from({ length: 100 }, (_, i) => ({ reservationID: String(i) })), total: 200 }]);

    const page = await cloudbedsGetReservationsWithRateDetailsPage(
      CREDS,
      { checkOutFrom: "2026-08-17", checkOutTo: "2026-11-01" },
      2,
    );

    expect(page.hasMore).toBe(false);
  });
});
