/**
 * What the analytics page keeps and for how long: every section for five
 * minutes under one tag (so Refresh throws them all away), "right now" kept
 * per toggle only, and today's snapshot row written after the response, at
 * most every five minutes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  kept: [] as { keyParts: string[]; options: { revalidate?: number; tags?: string[] } }[],
  after: [] as (() => Promise<void>)[],
  loads: [] as unknown[][],
  snapshot: vi.fn(async () => 3),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown, keyParts: string[], options: { revalidate?: number; tags?: string[] }) => {
    seen.kept.push({ keyParts, options });
    return fn;
  },
}));
vi.mock("next/server", () => ({ after: (cb: () => Promise<void>) => seen.after.push(cb) }));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({ service: true }) }));
vi.mock("./analytics", () => ({
  loadAnalyticsNow: async (...a: unknown[]) => (seen.loads.push(["now", ...a.slice(1)]), { now: true }),
  loadAnalyticsRange: async (...a: unknown[]) => (seen.loads.push(["range", ...a.slice(1)]), { range: true }),
  snapshotHotelMetrics: seen.snapshot,
}));
vi.mock("./product-analytics", () => ({ loadProductAnalytics: async () => ({ available: true }) }));
vi.mock("./push-problems", () => ({ loadPushProblemAnalytics: async () => ({ available: true }) }));

const cache = await import("./analytics-cache");

beforeEach(() => {
  seen.after = [];
  seen.loads = [];
  seen.snapshot.mockReset();
  seen.snapshot.mockResolvedValue(3);
});

describe("the kept sections", () => {
  it("are kept five minutes under the tag Refresh expires, each under its own key", () => {
    expect(seen.kept.map((k) => k.keyParts[0]).sort()).toEqual([
      "admin-analytics-now-v1",
      "admin-analytics-product-v1",
      "admin-analytics-push-v1",
      "admin-analytics-range-v1",
    ]);
    for (const k of seen.kept) expect(k.options).toEqual({ revalidate: 300, tags: [cache.ANALYTICS_CACHE_TAG] });
  });

  it("read with the service role, stamped with when they were worked out", async () => {
    const before = Date.now();
    const now = await cache.analyticsNow(true);
    expect(now.value).toEqual({ now: true });
    expect(Date.parse(now.computedAt)).toBeGreaterThanOrEqual(before);
    await cache.analyticsRange("2026-09-01", "2026-09-30", false);
    expect(seen.loads).toEqual([
      ["now", { includeTest: true }],
      ["range", "2026-09-01", "2026-09-30", { includeTest: false }],
    ]);
  });
});

describe("today's snapshot row", () => {
  it("is written after the response, at most every five minutes, and again soon after a failure", async () => {
    const t0 = 1_000_000_000_000;
    expect(cache.refreshTodaySnapshotLater("2026-09-30", t0)).toBe(true);
    expect(seen.snapshot).not.toHaveBeenCalled();
    await seen.after[0]();
    expect(seen.snapshot).toHaveBeenCalledWith({ service: true }, "2026-09-30");

    expect(cache.refreshTodaySnapshotLater("2026-09-30", t0 + 60_000)).toBe(false);
    expect(cache.refreshTodaySnapshotLater("2026-09-30", t0 + 301_000)).toBe(true);

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    seen.snapshot.mockRejectedValueOnce(new Error("boom"));
    await seen.after[1]();
    log.mockRestore();
    expect(cache.refreshTodaySnapshotLater("2026-09-30", t0 + 302_000)).toBe(true);
  });
});
