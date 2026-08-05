import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limiter = vi.hoisted(() => ({
  acquire: vi.fn(async () => {}),
  record: vi.fn(),
}));
vi.mock("../../../supabase/functions/_shared/pms/rate-limit.ts", () => limiter);

import {
  buildReservationRangeParams,
  thinkGet,
  thinkGetHotels,
  thinkGetReservationsPage,
  ThinkHttpError,
} from "@/lib/think/client";

const CREDS = { accessToken: "tok-1", baseUrl: "https://api.test" };

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

describe("think client", () => {
  it("sends Bearer auth and paces the think lane before the request goes out", async () => {
    const fetchMock = vi.fn(async () =>
      json(200, [{ id: "h1", externalId: "ext1", name: "Seaside Resort" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hotels = await thinkGetHotels(CREDS);

    expect(limiter.acquire).toHaveBeenCalledWith("think", "tok-1");
    expect(limiter.acquire.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.test/v1/hotels");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(limiter.record).toHaveBeenCalledWith("think", "tok-1", "ok");
    expect(hotels).toEqual([{ id: "h1", externalId: "ext1", name: "Seaside Resort" }]);
  });

  it("flattens range filters to the wire's snake_case property names", () => {
    expect(
      buildReservationRangeParams({
        updatedFrom: new Date("2026-08-01T00:00:00.000Z"),
        updatedTo: new Date("2026-08-02T12:30:00.000Z"),
        stayFrom: "2026-08-01",
        stayTo: "2027-08-01",
      }),
    ).toEqual({
      updated_at_start_date_time: "2026-08-01T00:00:00.000Z",
      updated_at_end_date_time: "2026-08-02T12:30:00.000Z",
      stay_on_start_date: "2026-08-01",
      stay_on_end_date: "2027-08-01",
    });
    expect(buildReservationRangeParams({})).toEqual({});
  });

  it("requests a reservations page with range, page, size and a stable sort", async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { content: [{ id: "r1" }], totalPages: 3, last: false, number: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const range = buildReservationRangeParams({
      updatedFrom: new Date("2026-08-01T00:00:00.000Z"),
      stayFrom: "2026-08-01",
      stayTo: "2027-08-01",
    });
    const pageRes = await thinkGetReservationsPage(CREDS, "ext1", range, 1, 200);

    const url = new URL(String((fetchMock.mock.calls[0] as unknown as [string])[0]));
    expect(url.pathname).toBe("/v1/hotels/ext1/reservations");
    expect(url.searchParams.get("updated_at_start_date_time")).toBe("2026-08-01T00:00:00.000Z");
    expect(url.searchParams.get("stay_on_start_date")).toBe("2026-08-01");
    expect(url.searchParams.get("stay_on_end_date")).toBe("2027-08-01");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("size")).toBe("200");
    expect(url.searchParams.get("sort")).toBe("id");
    expect(pageRes).toEqual({ content: [{ id: "r1" }], totalPages: 3, last: false, number: 1 });
  });

  it("caps a runaway Retry-After at the backoff ceiling", async () => {
    // Honouring the header verbatim hands the PMS control of our wall clock: a
    // single Retry-After: 3600 would park the whole invocation for an hour.
    const responses = [json(429, {}, { "Retry-After": "3600" }), json(200, [])];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    let settled = false;
    const p = thinkGet(CREDS, "/v1/hotels", {}).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(119_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual([]);
    expect(limiter.acquire).toHaveBeenCalledTimes(2);
    expect(limiter.record).toHaveBeenCalledWith("think", "tok-1", "throttled");
    expect(limiter.record).toHaveBeenCalledWith("think", "tok-1", "ok");
  });

  it("throws ThinkHttpError carrying status and path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { message: "Hotel not found" })));

    const err = await thinkGet(CREDS, "/v1/hotels/nope/room_types", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ThinkHttpError);
    const httpErr = err as ThinkHttpError;
    expect(httpErr.name).toBe("ThinkHttpError");
    expect(httpErr.status).toBe(404);
    expect(httpErr.path).toBe("/v1/hotels/nope/room_types");
    expect(httpErr.retryAfterMs).toBeNull();
    expect(httpErr.message).toContain("Hotel not found");
  });
});
