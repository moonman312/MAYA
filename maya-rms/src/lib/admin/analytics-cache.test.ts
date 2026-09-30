/**
 * What the analytics page keeps and for how long. unstable_cache is stood in
 * for by a small copy of how Next treats an entry: fresh until its revalidate
 * time, then handed back once more, however old, while a new one is worked out
 * in the background. Against that: nothing older than the current five-minute
 * slot is ever shown, today's snapshot row is written before the sections that
 * read it are worked out, the kept product numbers hold no one's email, and
 * the keys name the Supabase project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefgh.supabase.co";
  return {
    kept: [] as { keyParts: string[]; options: { revalidate: number; tags?: string[] } }[],
    store: new Map<string, { value: unknown; at: number }>(),
    order: [] as string[],
    version: 1,
    snapshotFails: false,
    walkedAway: [] as Record<string, unknown>[],
    emails: [] as { user_id: string; email: string }[],
    rpc: [] as [string, unknown][],
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[], options: { revalidate: number; tags?: string[] }) => {
    seen.kept.push({ keyParts, options });
    return async (...args: unknown[]) => {
      const key = JSON.stringify([keyParts, args]);
      const hit = seen.store.get(key);
      if (hit) {
        if (Date.now() - hit.at <= options.revalidate * 1000) return hit.value;
        void fn(...args).then((value) => seen.store.set(key, { value, at: Date.now() }));
        return hit.value;
      }
      const value = await fn(...args);
      seen.store.set(key, { value, at: Date.now() });
      return value;
    };
  },
}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    service: true,
    rpc: async (name: string, args: unknown) => (seen.rpc.push([name, args]), { data: seen.emails, error: null }),
  }),
}));
vi.mock("./analytics", () => ({
  loadAnalyticsNow: async (_c: unknown, scope: unknown) => (seen.order.push(`now ${JSON.stringify(scope)}`), { version: seen.version }),
  loadAnalyticsRange: async (_c: unknown, from: string, to: string) => (seen.order.push(`range ${from} ${to}`), { version: seen.version }),
  snapshotHotelMetrics: async (_c: unknown, day: string) => {
    await Promise.resolve();
    seen.order.push(`snapshot ${day}`);
    if (seen.snapshotFails) throw new Error("boom");
    return 3;
  },
}));
vi.mock("./product-analytics", async (orig) => ({
  ...(await orig<typeof import("./product-analytics")>()),
  loadProductAnalytics: async (_c: unknown, from: string, to: string) => {
    seen.order.push(`product ${from} ${to}`);
    return { available: true, walkedAway: seen.walkedAway.map((r) => ({ ...r })), version: seen.version };
  },
}));
vi.mock("./push-problems", () => ({ loadPushProblemAnalytics: async () => ({ available: true }) }));

const cache = await import("./analytics-cache");

/** 14:00:30 UTC on a day: the slot runs 14:00 to 14:05. */
const at = (day: string, hhmmss = "14:00:30") => Date.parse(`${day}T${hhmmss}Z`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  seen.store.clear();
  seen.order = [];
  seen.version = 1;
  seen.snapshotFails = false;
  seen.walkedAway = [];
  seen.emails = [];
  seen.rpc = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the kept sections", () => {
  it("are kept under the tag Refresh expires, each under its own key that names the Supabase project", () => {
    expect(seen.kept.map((k) => k.keyParts[0]).sort()).toEqual([
      "admin-analytics-now-v2",
      "admin-analytics-product-v2",
      "admin-analytics-push-v2",
      "admin-analytics-range-v2",
    ]);
    for (const k of seen.kept) {
      expect(k.keyParts).toContain("abcdefgh.supabase.co");
      expect(k.options).toEqual({ revalidate: 300, tags: [cache.ANALYTICS_CACHE_TAG] });
    }
  });

  it("answer from the kept copy within the same five minutes", async () => {
    vi.setSystemTime(at("2026-09-30", "14:00:30"));
    expect((await cache.analyticsNow(false)).value).toEqual({ version: 1 });
    seen.version = 2;
    vi.setSystemTime(at("2026-09-30", "14:04:50"));
    expect((await cache.analyticsNow(false)).value).toEqual({ version: 1 });
    expect(seen.order).toEqual(['now {"includeTest":false}']);
  });

  it("never show numbers from an earlier five minutes, even a moment into the next", async () => {
    vi.setSystemTime(at("2026-09-30", "14:04:59"));
    await cache.analyticsNow(false);
    await cache.analyticsRange("2026-09-01", "2026-09-29", false);
    seen.version = 2;
    vi.setSystemTime(at("2026-09-30", "14:05:01"));
    expect((await cache.analyticsNow(false)).value).toEqual({ version: 2 });
    expect((await cache.analyticsRange("2026-09-01", "2026-09-29", false)).value).toEqual({ version: 2 });
  });

  it("never show last night's numbers the next morning", async () => {
    vi.setSystemTime(at("2026-09-29", "23:58:00"));
    await cache.analyticsNow(true);
    seen.version = 2;
    vi.setSystemTime(at("2026-09-30", "08:00:00"));
    const now = await cache.analyticsNow(true);
    expect(now.value).toEqual({ version: 2 });
    expect(now.computedAt).toBe("2026-09-30T08:00:00.000Z");
  });

  it("give the page the slot's own day as today", () => {
    vi.setSystemTime(at("2026-09-30", "23:59:59"));
    expect(cache.analyticsClock().today).toBe("2026-09-30");
    vi.setSystemTime(at("2026-10-01", "00:00:00"));
    expect(cache.analyticsClock().today).toBe("2026-10-01");
  });
});

describe("today's snapshot row", () => {
  it("is written before a window that ends today is worked out, so today's point is already in it", async () => {
    vi.setSystemTime(at("2026-09-20"));
    await cache.analyticsRange("2026-08-22", "2026-09-20", false);
    expect(seen.order).toEqual(["snapshot 2026-09-20", "range 2026-08-22 2026-09-20"]);
  });

  it("is not waited for by a window in the past, and not written again for a kept one", async () => {
    vi.setSystemTime(at("2026-09-21"));
    await cache.analyticsRange("2026-08-01", "2026-08-31", false);
    expect(seen.order).toEqual(["range 2026-08-01 2026-08-31"]);
    await cache.analyticsRange("2026-08-01", "2026-08-31", false);
    expect(seen.order).toEqual(["range 2026-08-01 2026-08-31"]);
  });

  it("is written before the product numbers, whose MRR at last count reads it, whatever the window", async () => {
    vi.setSystemTime(at("2026-09-22"));
    await cache.productAnalytics("2026-08-01", "2026-08-31", false);
    expect(seen.order).toEqual(["snapshot 2026-09-22", "product 2026-08-01 2026-08-31"]);
  });

  it("is written once in five minutes however many sections need it, and again in the next five", async () => {
    vi.setSystemTime(at("2026-09-23"));
    await Promise.all([
      cache.analyticsRange("2026-08-25", "2026-09-23", false),
      cache.analyticsRange("2026-09-17", "2026-09-23", true),
      cache.productAnalytics("2026-08-25", "2026-09-23", false),
    ]);
    expect(seen.order.filter((o) => o.startsWith("snapshot"))).toEqual(["snapshot 2026-09-23"]);
    expect(seen.order[0]).toBe("snapshot 2026-09-23");
    vi.setSystemTime(at("2026-09-23", "14:05:00"));
    await cache.analyticsRange("2026-08-25", "2026-09-23", false);
    expect(seen.order.filter((o) => o.startsWith("snapshot"))).toEqual(["snapshot 2026-09-23", "snapshot 2026-09-23"]);
  });

  it("costs only today's point when it fails, and the next section worked out tries again", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(at("2026-09-24"));
    seen.snapshotFails = true;
    expect((await cache.analyticsRange("2026-08-26", "2026-09-24", false)).value).toEqual({ version: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("analyticsTodaySnapshot"));
    log.mockRestore();
    seen.snapshotFails = false;
    await cache.analyticsRange("2026-09-18", "2026-09-24", false);
    expect(seen.order).toEqual([
      "snapshot 2026-09-24",
      "range 2026-08-26 2026-09-24",
      "snapshot 2026-09-24",
      "range 2026-09-18 2026-09-24",
    ]);
  });
});

describe("the follow-up list's emails", () => {
  it("are never kept, and are read fresh for the owners on the list", async () => {
    vi.setSystemTime(at("2026-09-25"));
    seen.walkedAway = [
      { property_key: "a", owner_user_id: "u1", owner_email: "sam@harbour.example" },
      { property_key: "b", owner_user_id: null, owner_email: null },
      { property_key: "c", owner_user_id: "u2", owner_email: "gone@example.com" },
    ];
    seen.emails = [{ user_id: "u1", email: "sam@harbour.example" }];

    const shown = await cache.productAnalytics("2026-09-01", "2026-09-25", false);
    const owners = (shown.value as { walkedAway: { owner_email: string | null }[] }).walkedAway.map((r) => r.owner_email);
    expect(owners).toEqual(["sam@harbour.example", null, null]);
    expect(seen.rpc).toEqual([["analytics_owner_emails", { p_user_ids: ["u1", "u2"] }]]);

    const kept = JSON.stringify([...seen.store.values()]);
    expect(kept).not.toContain("@");
    expect(kept).toContain('"owner_user_id":"u1"');

    // A kept load still asks for the emails.
    await cache.productAnalytics("2026-09-01", "2026-09-25", false);
    expect(seen.rpc).toHaveLength(2);
  });
});
