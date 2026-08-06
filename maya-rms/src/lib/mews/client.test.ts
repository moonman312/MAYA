import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../supabase/functions/_shared/pms/rate-limit.ts", () => ({
  acquire: vi.fn(async () => {}),
  record: vi.fn(),
}));

import { mewsPost, parseRetryAfterMs } from "@/lib/mews/client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mews client", () => {
  it("parseRetryAfterMs reads delay-seconds", () => {
    const res = new Response(null, { headers: { "Retry-After": "12" } });
    expect(parseRetryAfterMs(res)).toBe(12_000);
  });

  it("parseRetryAfterMs returns null when header missing", () => {
    expect(parseRetryAfterMs(new Response())).toBeNull();
  });

  it("caps a runaway Retry-After at the backoff ceiling", async () => {
    // Honouring the header verbatim hands Mews control of our wall clock: a
    // single Retry-After: 3600 would park the whole invocation for an hour.
    vi.useFakeTimers();
    const responses = [
      new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }),
      new Response("{}", { status: 200 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    let settled = false;
    const p = mewsPost("https://api.mews-demo.com", "reservations/getAll", {
      AccessToken: "at",
    }).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(119_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual({});
  });
});
