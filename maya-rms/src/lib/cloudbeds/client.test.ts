import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({
  acquire: vi.fn(async () => {}),
  record: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/pms/rate-limit.ts", () => limiter);

import {
  cloudbedsGet,
  cloudbedsGetReservationsWithRateDetailsPage,
  CloudbedsHttpError,
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
  it("does not wait out a 429 whose wait ends past the caller's deadline", async () => {
    const fetchMock = vi.fn(async () => json(429, { message: "Too many requests" }, { "Retry-After": "30" }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await cloudbedsGet(CREDS, "getRatePlans", {}, undefined, { deadlineAt: Date.now() + 5_000 }).catch((e) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(err)).toContain("(429)");
  });

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

  it("sends a booking-created bound as resultsTo, and no status filter", async () => {
    const urls = captureUrls([{ data: [], total: 0 }]);

    await cloudbedsGetReservationsWithRateDetailsPage(
      CREDS,
      { checkOutFrom: "2024-06-25", checkOutTo: "2025-06-26", createdTo: "2026-09-16 10:00:00" },
      3,
    );

    const params = Object.fromEntries(urls[0].searchParams);
    expect(params).toEqual({
      propertyID: "prop-1",
      reservationCheckOutFrom: "2024-06-25",
      reservationCheckOutTo: "2025-06-26",
      resultsTo: "2026-09-16 10:00:00",
      pageNumber: "3",
      pageSize: "100",
    });
    expect(params).not.toHaveProperty("status");
    expect(params).not.toHaveProperty("excludeStatuses");
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

describe("a read refused with 401 or 403", () => {
  const refused = (status = 401) => json(status, { success: false, message: "Access token is invalid or has expired." });
  const credsThatCanRefresh = (mint: () => Promise<{ accessToken: string; tokenType?: string } | null>) => ({
    ...CREDS,
    refresh: { mint: vi.fn(mint) },
  });

  it("is thrown as it is when the credentials cannot mint a token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refused()));

    const err = await cloudbedsGet({ ...CREDS }, "getRoomTypes", {}).catch((e) => e);

    expect(err).toBeInstanceOf(CloudbedsHttpError);
    expect(err).toMatchObject({ status: 401, foreignBody: false, freshTokenRefused: false });
  });

  it("is asked again once on the new token, which stays on the credentials", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        seen.push(init.headers.Authorization);
        return init.headers.Authorization === "Bearer cbat_new" ? json(200, { success: true, data: [1] }) : refused();
      }),
    );
    const creds = credsThatCanRefresh(async () => ({ accessToken: "cbat_new" }));

    await expect(cloudbedsGet(creds, "getRoomTypes", {})).resolves.toMatchObject({ data: [1] });
    await expect(cloudbedsGet(creds, "getRatePlans", {})).resolves.toMatchObject({ data: [1] });

    expect(seen).toEqual(["Bearer cbat_test", "Bearer cbat_new", "Bearer cbat_new"]);
    expect(creds.refresh.mint).toHaveBeenCalledTimes(1);
    expect(creds.refresh.mint).toHaveBeenCalledWith("cbat_test");
  });

  it("says so when the new token is refused too, and never asks for a third", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refused(403)));
    const creds = credsThatCanRefresh(async () => ({ accessToken: "cbat_new" }));

    const first = await cloudbedsGet(creds, "getRoomTypes", {}).catch((e) => e);
    const second = await cloudbedsGet(creds, "getRoomTypes", {}).catch((e) => e);

    expect(first).toMatchObject({ status: 403, freshTokenRefused: true });
    expect(second).toMatchObject({ status: 403, freshTokenRefused: true });
    expect(creds.refresh.mint).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("is not called a refusal of a new token when none was to be had", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refused()));
    for (const mint of [async () => null, async () => ({ accessToken: "cbat_test" }), async () => Promise.reject(new Error("vault down"))]) {
      const creds = credsThatCanRefresh(mint);
      const err = await cloudbedsGet(creds, "getRoomTypes", {}).catch((e) => e);
      expect(err).toMatchObject({ status: 401, freshTokenRefused: false });
      expect(creds.accessToken).toBe("cbat_test");
    }
  });

  it("asks for no token over a page that is not Cloudbeds' own, and marks it as one", async () => {
    const pages = [
      new Response("<html><body>Access denied</body></html>", { status: 403 }),
      new Response("", { status: 403 }),
      json(403, { code: 1020 }),
      json(401, ["unexpected"]),
    ];
    for (const page of pages) {
      vi.stubGlobal("fetch", vi.fn(async () => page));
      const creds = credsThatCanRefresh(async () => ({ accessToken: "cbat_new" }));
      const err = await cloudbedsGet(creds, "getRoomTypes", {}).catch((e) => e);
      expect(err).toBeInstanceOf(CloudbedsHttpError);
      expect(err.foreignBody).toBe(true);
      expect(creds.refresh.mint).not.toHaveBeenCalled();
    }
  });

  it("asks for no token when Cloudbeds says the app is not connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { success: false, message: "Application is not available to be connected." })),
    );
    const creds = credsThatCanRefresh(async () => ({ accessToken: "cbat_new" }));

    const err = await cloudbedsGet(creds, "getRoomTypes", {}).catch((e) => e);

    expect(err).toMatchObject({ status: 401, foreignBody: false, freshTokenRefused: false });
    expect(creds.refresh.mint).not.toHaveBeenCalled();
  });

  it("leaves Cloudbeds' own refusals of anything else alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { success: false, message: "Parameter status is not valid" })));
    const creds = credsThatCanRefresh(async () => ({ accessToken: "cbat_new" }));

    const err = await cloudbedsGet(creds, "getReservations", {}).catch((e) => e);

    expect(err).toMatchObject({ status: 400, foreignBody: false });
    expect(creds.refresh.mint).not.toHaveBeenCalled();
  });
});
