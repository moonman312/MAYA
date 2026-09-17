/**
 * Cloudbeds collapses a multi-day getRatePlans window into ONE aggregated
 * roomRate per plan unless detailedRates is set — verified live, a 3-day window
 * returned roomRate 338 with no dates on the rows. detailedRates returns
 * roomRateDetailed[], a per-night breakdown, and Cloudbeds also requires that
 * parameter for RMS certification. So the calendar read must always send it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRatePlans = vi.hoisted(() => vi.fn());
const patchRate = vi.hoisted(() => vi.fn());
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsGetRatePlans: getRatePlans,
  cloudbedsPatchRate: patchRate,
}));

const { createCloudbedsRateAdapter } = await import(
  "../../../supabase/functions/_shared/cloudbeds/rate-push"
);

const CREDS = { accessToken: "t", tokenType: "Bearer", baseUrl: "https://api.test", propertyId: "P1" } as never;
const nights = (dates: [string, number | null][]) =>
  dates.map(([date, rate]) => ({ date, rate, minLos: 1, closedToArrival: false }));

// The resolver logs its map on every call; tests that care read the spy.
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getRatePlans.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});

describe("cloudbeds fetchRateCalendar", () => {
  it("makes ONE ranged call and always asks for detailedRates", async () => {
    getRatePlans.mockResolvedValue([]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    await adapter.fetchRateCalendar!("2026-10-01", "2026-10-03", { RT1: "rate-1" });

    expect(getRatePlans).toHaveBeenCalledTimes(1);
    const [, start, end, opts] = getRatePlans.mock.calls[0];
    expect(start).toBe("2026-10-01");
    expect(end).toBe("2026-10-04"); // endDate is exclusive, so +1 to include the 3rd
    expect(opts).toEqual({ detailedRates: true });
  });

  it("expands roomRateDetailed into one entry per night", async () => {
    getRatePlans.mockResolvedValue([
      { roomTypeID: "RT1", rateID: "rate-1", isDerived: false, roomRateDetailed: nights([["2026-10-01", 159], ["2026-10-02", 189]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-02", { RT1: "rate-1" })).toEqual([
      { stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 159 },
      { stayDate: "2026-10-02", externalRoomTypeId: "RT1", price: 189 },
    ]);
  });

  it("keeps only tracked room types and skips derived plans", async () => {
    getRatePlans.mockResolvedValue([
      { roomTypeID: "RT1", rateID: "rate-1", isDerived: false, roomRateDetailed: nights([["2026-10-01", 200]]) },
      { roomTypeID: "RT1", rateID: "rate-1", isDerived: true, roomRateDetailed: nights([["2026-10-01", 260]]) },
      { roomTypeID: "RT_OTHER", rateID: "rate-9", isDerived: false, roomRateDetailed: nights([["2026-10-01", 999]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-01", { RT1: "rate-1" }))
      .toEqual([{ stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 200 }]);
  });

  it("drops a MISSING rate instead of writing it as a $0 base, but keeps a real zero", async () => {
    // Number(null) is 0, so a null rate would otherwise price the night at the floor.
    getRatePlans.mockResolvedValue([
      { roomTypeID: "RT1", rateID: "rate-1", isDerived: false, roomRateDetailed: nights([["2026-10-01", null], ["2026-10-02", 0]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-02", { RT1: "rate-1" }))
      .toEqual([{ stayDate: "2026-10-02", externalRoomTypeId: "RT1", price: 0 }]);
  });

  it("ignores nights the API returns outside the window asked for", async () => {
    getRatePlans.mockResolvedValue([
      { roomTypeID: "RT1", rateID: "rate-1", isDerived: false, roomRateDetailed: nights([["2026-09-30", 100], ["2026-10-01", 200], ["2026-10-02", 300]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-01", { RT1: "rate-1" }))
      .toEqual([{ stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 200 }]);
  });
});

/**
 * A room type can carry more than one non-derived plan: its base rate and an
 * independent package priced on its own. Only the base is MAYA's to read or
 * write. Reading both gave one cell two base rates, and targeting the package
 * when the base was missing put MAYA's price on the breakfast deal.
 */
describe("cloudbeds base rate targeting with an independent package plan", () => {
  const BASE = { roomTypeID: "RT1", rateID: "base-1", isDerived: false };
  const PACKAGE = {
    roomTypeID: "RT1",
    rateID: "pkg-1",
    isDerived: false,
    ratePlanID: "777",
    ratePlanNamePublic: "Bed & Breakfast",
  };

  it("targets the base rate, not the package, whichever comes first", async () => {
    getRatePlans.mockResolvedValue([
      { ...PACKAGE, roomRateDetailed: nights([["2026-10-01", 260]]) },
      { ...BASE, roomRateDetailed: nights([["2026-10-01", 200]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.resolveRateTargets()).toEqual({ RT1: "base-1" });
  });

  it("reads the night's rate from the targeted base plan only", async () => {
    getRatePlans.mockResolvedValue([
      { ...BASE, roomRateDetailed: nights([["2026-10-01", 200], ["2026-10-02", 210]]) },
      { ...PACKAGE, roomRateDetailed: nights([["2026-10-01", 260], ["2026-10-02", 270]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-02", { RT1: "base-1" })).toEqual([
      { stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 200 },
      { stayDate: "2026-10-02", externalRoomTypeId: "RT1", price: 210 },
    ]);
  });

  it("reads nothing for a room type whose target is some other rate", async () => {
    getRatePlans.mockResolvedValue([{ ...BASE, roomRateDetailed: nights([["2026-10-01", 200]]) }]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-01", { RT1: "pkg-1" })).toEqual([]);
  });

  it("leaves out a room type that only has a package plan, and says how many it had", async () => {
    getRatePlans.mockResolvedValue([
      { ...BASE, roomRateDetailed: nights([["2026-10-01", 200]]) },
      { ...PACKAGE, roomTypeID: "RT2", rateID: "pkg-2", roomRateDetailed: nights([["2026-10-01", 300]]) },
      { ...PACKAGE, roomTypeID: "RT2", rateID: "pkg-3", ratePlanID: "778", roomRateDetailed: nights([["2026-10-01", 320]]) },
      { roomTypeID: "RT2", rateID: "der-1", isDerived: true, ratePlanID: "779", roomRateDetailed: nights([["2026-10-01", 280]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);

    expect(await adapter.resolveRateTargets()).toEqual({ RT1: "base-1" });
    const line = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(line).toEqual({
      fn: "cloudbedsRateTargets",
      propertyId: "P1",
      targets: { RT1: "base-1" },
      withoutBaseRate: { RT2: 2 },
    });
    // Nothing else is logged: ids and counts, never a rate or a name.
    expect(Object.keys(line).sort()).toEqual(["fn", "propertyId", "targets", "withoutBaseRate"]);

    const cal = await adapter.readBaseRateCalendar!("2026-10-01", "2026-10-01");
    expect(cal.targets).toEqual({ RT1: "base-1" });
    expect(cal.entries).toEqual([{ stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 200 }]);
  });

  it("refreshes a whole window with one getRatePlans call", async () => {
    getRatePlans.mockResolvedValue([
      { ...BASE, roomRateDetailed: nights([["2026-10-01", 200], ["2026-11-29", 240]]) },
      { ...PACKAGE, roomRateDetailed: nights([["2026-10-01", 260]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const cal = await adapter.readBaseRateCalendar!("2026-10-01", "2026-11-29");

    expect(getRatePlans).toHaveBeenCalledTimes(1);
    const [, start, end, opts] = getRatePlans.mock.calls[0];
    expect([start, end, opts]).toEqual(["2026-10-01", "2026-11-30", { detailedRates: true }]);
    expect(cal).toEqual({
      targets: { RT1: "base-1" },
      entries: [
        { stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 200 },
        { stayDate: "2026-11-29", externalRoomTypeId: "RT1", price: 240 },
      ],
    });
  });

  it("asks for the catalog on the hotel's date when the push passes one", async () => {
    getRatePlans.mockResolvedValue([]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    await adapter.resolveRateTargets({ today: "2026-12-31" });
    const [, start, end] = getRatePlans.mock.calls[0];
    expect([start, end]).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("cloudbeds adapter after a catalog read, and on a refused grant", () => {
  it("knows nothing about any room type after an empty read, and says why one was left out after a real one", async () => {
    const adapter = createCloudbedsRateAdapter(CREDS);
    getRatePlans.mockResolvedValueOnce([]);
    expect(await adapter.resolveRateTargets({ today: "2026-10-01" })).toEqual({});
    expect(adapter.missingTargetReason!("RT1")).toBeNull();

    getRatePlans.mockResolvedValueOnce([
      { roomTypeID: "RT1", rateID: "pkg-1", isDerived: false, ratePlanID: "p1", ratePlanNamePublic: "Breakfast" },
      { roomTypeID: "RT2", rateID: "der-1", isDerived: true },
    ]);
    expect(await adapter.resolveRateTargets({ today: "2026-10-01" })).toEqual({});
    expect(adapter.missingTargetReason!("RT1")).toBe("no_base_rate");
    expect(adapter.missingTargetReason!("RT2")).toBe("derived_only");
    expect(adapter.missingTargetReason!("RT9")).toBe("not_in_catalog");
  });

  it("passes the caller's deadline to the catalog read", async () => {
    getRatePlans.mockResolvedValue([]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    await adapter.readBaseRateCalendar!("2026-10-01", "2026-10-02", { deadlineAt: 12345 });
    expect(getRatePlans.mock.calls[0][3]).toEqual({ detailedRates: true, deadlineAt: 12345 });
  });

  it("refreshes its credentials once when patchRate answers 401, and sends the rest with them", async () => {
    patchRate.mockReset();
    patchRate.mockImplementation(async (creds: { accessToken: string }) =>
      creds.accessToken === "t" ? { ok: false, status: 401, error: "Cloudbeds patchRate failed (401): Unauthorized" } : { ok: true, jobReferenceID: "job-2" },
    );
    const refreshCredentials = vi.fn(async () => ({ ...(CREDS as object), accessToken: "t2" }) as never);
    const adapter = createCloudbedsRateAdapter(CREDS, false, { refreshCredentials });

    const results = await adapter.pushCells([
      { stayDate: "2026-10-01", roomTypeId: "u1", externalRoomTypeId: "RT1", price: 200, externalRateId: "rate-1" },
      { stayDate: "2026-10-01", roomTypeId: "u2", externalRoomTypeId: "RT2", price: 220, externalRateId: "rate-2" },
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(patchRate.mock.calls.map((c) => (c[0] as { accessToken: string }).accessToken)).toEqual(["t", "t2", "t2"]);
  });
});
