/**
 * The Think rate-push adapter's wire behavior. The part worth pinning is the
 * gzip: Think refuses plain JSON outright, so a regression here isn't a
 * degraded push, it is every push failing with a media-type error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createThinkRateAdapter } from "./rate-push";
import { chooseThinkBaseRates } from "../../../supabase/functions/_shared/think/rate-push";

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
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
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

    // BAR wins where it covers the room. rt3 has only the Non-Refundable rate,
    // which is not its base, so it is left out rather than written there.
    // DERIVED types reprice off their parent and are never written directly.
    expect(targets).toEqual({ rt1: "44186", rt2: "44186" });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      fn: "thinkRateTargets",
      thinkHotelId: "hotel-ext",
      targets: { rt1: "44186", rt2: "44186" },
      withoutBaseRate: { rt3: 1 },
    });
    log.mockRestore();
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

describe("chooseThinkBaseRates", () => {
  it("with no rate named Best Available, takes the one STANDARD type covering the most room types", () => {
    expect(
      chooseThinkBaseRates([
        { id: "rack", name: "Rack Rate", type: "STANDARD", roomTypeIds: ["rt1", "rt2", "rt3"] },
        { id: "bb", name: "Bed and Breakfast", type: "STANDARD", roomTypeIds: ["rt1", "rt4"] },
      ]),
    ).toEqual({ targets: { rt1: "rack", rt2: "rack", rt3: "rack" }, withoutBaseRate: { rt4: 1 } });
  });

  it("targets nothing when two STANDARD types tie for broadest, rather than guess", () => {
    expect(
      chooseThinkBaseRates([
        { id: "rack", name: "Rack Rate", type: "STANDARD", roomTypeIds: ["rt1", "rt2"] },
        { id: "bb", name: "Bed and Breakfast", type: "STANDARD", roomTypeIds: ["rt1", "rt2"] },
      ]),
    ).toEqual({ targets: {}, withoutBaseRate: { rt1: 2, rt2: 2 } });
  });

  it("never falls back per room type to a non-base STANDARD type", () => {
    // The old resolver handed rt2 the package because BAR didn't cover it.
    const { targets } = chooseThinkBaseRates([
      { id: "bar", name: "Best Available", type: "STANDARD", roomTypeIds: ["rt1"] },
      { id: "pkg", name: "Suite Package", type: "STANDARD", roomTypeIds: ["rt2"] },
    ]);
    expect(targets).toEqual({ rt1: "bar" });
  });

  it("only counts an affirmative STANDARD, so a type with no type field is never a target", () => {
    const { targets } = chooseThinkBaseRates([
      { id: "bar", name: "Best Available Rate", roomTypeIds: ["rt1"] },
      { id: "bar2", name: "Best Available Rate", type: null, roomTypeIds: ["rt2"] },
      { id: "bar3", name: "Best Available Rate", type: "standard", roomTypeIds: ["rt3"] },
    ]);
    expect(targets).toEqual({ rt3: "bar3" });
  });

  it("prefers the broader of two Best Available types covering the same room", () => {
    const { targets } = chooseThinkBaseRates([
      { id: "bar-suites", name: "Best Available - Suites", type: "STANDARD", roomTypeIds: ["rt3"] },
      { id: "bar", name: "Best Available Rate", type: "STANDARD", roomTypeIds: ["rt1", "rt2", "rt3"] },
    ]);
    expect(targets).toEqual({ rt1: "bar", rt2: "bar", rt3: "bar" });
  });
});
