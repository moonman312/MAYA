/**
 * The Think rate-push adapter's wire behavior. The part worth pinning is the
 * gzip: Think refuses plain JSON outright, so a regression here isn't a
 * degraded push, it is every push failing with a media-type error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createThinkRateAdapter } from "./rate-push";

vi.mock("../pms/rate-limit", () => ({
  acquire: vi.fn(async () => {}),
  record: vi.fn(),
}));

const CREDS = { accessToken: "tok-1", baseUrl: "https://api.test" };

function res(status: number, body: unknown = ""): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("createThinkRateAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves each room type to the Best Available STANDARD rate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        res(200, [
          { id: "44186", name: "Best Available Rate", type: "STANDARD", roomTypeIds: ["rt1", "rt2"] },
          { id: "44910", name: "Non-Refundable", type: "STANDARD", roomTypeIds: ["rt1", "rt2", "rt3"] },
          { id: "44999", name: "Winter Special", type: "DERIVED", roomTypeIds: ["rt1"] },
        ]),
      ),
    );

    const adapter = createThinkRateAdapter(CREDS, "hotel-ext");
    const targets = await adapter.resolveRateTargets();

    // BAR wins where it covers the room; the broadest STANDARD covers the rest.
    // DERIVED types reprice off their parent and are never written directly.
    expect(targets).toEqual({ rt1: "44186", rt2: "44186", rt3: "44910" });
  });

  it("PUTs gzipped JSON rows grouped by rate type and maps 202 to sent", async () => {
    const fetchMock = vi.fn(async () => res(202));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createThinkRateAdapter(CREDS, "hotel-ext");
    const results = await adapter.pushCells([
      { stayDate: "2026-12-01", roomTypeId: "u1", externalRoomTypeId: "rt1", price: 222, externalRateId: "44186" },
      { stayDate: "2026-12-02", roomTypeId: "u1", externalRoomTypeId: "rt1", price: 233, externalRateId: "44186" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.test/v1/hotels/hotel-ext/rate_types/44186/daily");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/gzip");
    const rows = JSON.parse(gunzipSync(Buffer.from(init.body as Uint8Array)).toString());
    expect(rows).toEqual([
      { roomTypeId: "rt1", rateTypeId: "44186", date: "2026-12-01", price: 222 },
      { roomTypeId: "rt1", rateTypeId: "44186", date: "2026-12-02", price: 233 },
    ]);
    expect(results.every((r) => r.ok && r.jobReference === "accepted:202")).toBe(true);
  });

  it("marks the whole chunk failed when the PUT is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(500, { statusCode: 500, name: "Illegal Argument", message: null })),
    );

    const adapter = createThinkRateAdapter(CREDS, "hotel-ext");
    const results = await adapter.pushCells([
      { stayDate: "2026-12-01", roomTypeId: "u1", externalRoomTypeId: "rt1", price: 222, externalRateId: "44186" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("500");
  });
});
