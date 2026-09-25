/**
 * The /go route itself, in demo mode (no Supabase): a same-origin relative
 * redirect into the app, never cached, never indexed.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }) }));

import { GET } from "./route";

describe("GET /go/<destination>", () => {
  it("answers 303 with a relative address in the app, no-store and noindex", async () => {
    const res = await GET(new NextRequest("https://maya-rms.com/go/rules.new?percent=10&direction=increase&x=1"), {
      params: Promise.resolve({ destination: "rules.new" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?tab=rules&panel=builder&dl=rules.new&direction=increase&percent=10");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("sends an unknown place home, whatever the host says", async () => {
    const req = new NextRequest("https://maya-rms.com/go/%2F%2Fevil.example", { headers: { host: "evil.example" } });
    const res = await GET(req, { params: Promise.resolve({ destination: "//evil.example" }) });
    expect(res.headers.get("location")).toBe("/?dl=home");
  });
});
