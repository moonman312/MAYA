import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "@/lib/mews/client";

describe("mews client", () => {
  it("parseRetryAfterMs reads delay-seconds", () => {
    const res = new Response(null, { headers: { "Retry-After": "12" } });
    expect(parseRetryAfterMs(res)).toBe(12_000);
  });

  it("parseRetryAfterMs returns null when header missing", () => {
    expect(parseRetryAfterMs(new Response())).toBeNull();
  });
});
