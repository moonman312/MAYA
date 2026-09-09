/**
 * Cloudbeds' getRatePlans rejects a zero-length window ("Parameter endDate
 * should be greater than startDate"), and it collapses any longer range into a
 * single aggregated roomRate per plan with no per-night breakdown. So the only
 * way to read a night's own rate is the half-open window [d, d+1) — which the
 * first live run of this got wrong, silently capturing nothing.
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

describe("cloudbeds fetchRateCalendar", () => {
  it("asks for one night at a time as [d, d+1), never [d, d]", async () => {
    getRatePlans.mockResolvedValue([]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    await adapter.fetchRateCalendar!("2026-10-01", "2026-10-03", { RT1: "rate-1" });

    expect(getRatePlans.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["2026-10-01", "2026-10-02"],
      ["2026-10-02", "2026-10-03"],
      ["2026-10-03", "2026-10-04"],
    ]);
  });

  it("keeps only tracked room types and skips derived plans", async () => {
    // Derived plans reprice off their parent, so the parent is the property's
    // own rate — the same choice resolveRateTargets makes.
    getRatePlans.mockResolvedValue([
      { roomTypeID: "RT1", roomRate: 200, isDerived: false },
      { roomTypeID: "RT1", roomRate: 260, isDerived: true },
      { roomTypeID: "RT_OTHER", roomRate: 999, isDerived: false },
    ]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    const out = await adapter.fetchRateCalendar!("2026-10-01", "2026-10-01", { RT1: "rate-1" });

    expect(out).toEqual([{ stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 200 }]);
  });

  it("drops a MISSING rate instead of writing it as a $0 base", async () => {
    // Number(null) is 0, so a null roomRate would otherwise become a $0 base
    // and price the night at the floor.
    getRatePlans.mockResolvedValue([{ roomTypeID: "RT1", roomRate: null, isDerived: false }]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-01", { RT1: "rate-1" })).toEqual([]);
  });

  it("keeps an explicit zero, which is a real comp rate", async () => {
    getRatePlans.mockResolvedValue([{ roomTypeID: "RT1", roomRate: 0, isDerived: false }]);
    const adapter = createCloudbedsRateAdapter(CREDS);
    expect(await adapter.fetchRateCalendar!("2026-10-01", "2026-10-01", { RT1: "rate-1" }))
      .toEqual([{ stayDate: "2026-10-01", externalRoomTypeId: "RT1", price: 0 }]);
  });
});
