/**
 * Cloudbeds collapses a multi-day getRatePlans window into ONE aggregated
 * roomRate per plan unless detailedRates is set — verified live, a 3-day window
 * returned roomRate 338 with no dates on the rows. detailedRates returns
 * roomRateDetailed[], a per-night breakdown, and Cloudbeds also requires that
 * parameter for RMS certification. So the calendar read must always send it.
 */
import { describe, expect, it, vi } from "vitest";

const getRatePlans = vi.hoisted(() => vi.fn());
vi.mock("../../../supabase/functions/_shared/cloudbeds/client", () => ({
  cloudbedsGetRatePlans: getRatePlans,
  cloudbedsPatchRate: vi.fn(),
}));

const { createCloudbedsRateAdapter } = await import(
  "../../../supabase/functions/_shared/cloudbeds/rate-push"
);

const CREDS = { accessToken: "t", tokenType: "Bearer", baseUrl: "https://api.test", propertyId: "P1" } as never;
const nights = (dates: [string, number | null][]) =>
  dates.map(([date, rate]) => ({ date, rate, minLos: 1, closedToArrival: false }));

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
      { roomTypeID: "RT1", isDerived: false, roomRateDetailed: nights([["2026-10-01", 159], ["2026-10-02", 189]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-02", { RT1: "rate-1" })).toEqual([
      { stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 159 },
      { stayDate: "2026-10-02", externalRoomTypeId: "RT1", price: 189 },
    ]);
  });

  it("keeps only tracked room types and skips derived plans", async () => {
    getRatePlans.mockResolvedValue([
      { roomTypeID: "RT1", isDerived: false, roomRateDetailed: nights([["2026-10-01", 200]]) },
      { roomTypeID: "RT1", isDerived: true, roomRateDetailed: nights([["2026-10-01", 260]]) },
      { roomTypeID: "RT_OTHER", isDerived: false, roomRateDetailed: nights([["2026-10-01", 999]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-01", { RT1: "rate-1" }))
      .toEqual([{ stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 200 }]);
  });

  it("drops a MISSING rate instead of writing it as a $0 base, but keeps a real zero", async () => {
    // Number(null) is 0, so a null rate would otherwise price the night at the floor.
    getRatePlans.mockResolvedValue([
      { roomTypeID: "RT1", isDerived: false, roomRateDetailed: nights([["2026-10-01", null], ["2026-10-02", 0]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-02", { RT1: "rate-1" }))
      .toEqual([{ stayDate: "2026-10-02", externalRoomTypeId: "RT1", price: 0 }]);
  });

  it("ignores nights the API returns outside the window asked for", async () => {
    getRatePlans.mockResolvedValue([
      { roomTypeID: "RT1", isDerived: false, roomRateDetailed: nights([["2026-09-30", 100], ["2026-10-01", 200], ["2026-10-02", 300]]) },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-01", { RT1: "rate-1" }))
      .toEqual([{ stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 200 }]);
  });
});
