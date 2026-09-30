import "server-only";
import { unstable_cache } from "next/cache";
import { after } from "next/server";
import { cache } from "react";
import { createAdminClient } from "@/utils/supabase/admin";
import { loadAnalyticsNow, loadAnalyticsRange, snapshotHotelMetrics, type AnalyticsNow, type AnalyticsRange } from "./analytics";
import { loadProductAnalytics, type ProductAnalytics } from "./product-analytics";
import { loadPushProblemAnalytics, type PushProblemAnalytics } from "./push-problems";

/**
 * The analytics page's sections, each kept for five minutes (Next's data
 * cache, unstable_cache: this app does not use Cache Components) so a second
 * look or a date change back to a range already seen answers at once.
 *
 * What is kept is the same for every platform admin: it is read with the
 * service role, keyed only by the window and the test toggle, and holds no
 * one's session. The page checks the caller is a platform admin before it
 * reads any of it (getAdminSession), and the Refresh button (a Server Action
 * that checks again) throws it all away.
 *
 * "Right now" does not depend on the window, so it is kept per toggle only
 * and a date change never recomputes it. A failed read is not kept: it throws,
 * the section says so in place, and the next load tries again.
 */

export const ANALYTICS_CACHE_TAG = "admin-analytics";
/** How long a section is kept, in seconds. */
export const ANALYTICS_CACHE_SECONDS = 300;

export type Stamped<T> = { value: T; computedAt: string };

async function stamped<T>(work: Promise<T>): Promise<Stamped<T>> {
  const value = await work;
  return { value, computedAt: new Date().toISOString() };
}

const keep = { revalidate: ANALYTICS_CACHE_SECONDS, tags: [ANALYTICS_CACHE_TAG] };

const nowKept = unstable_cache(
  async (includeTest: boolean) => stamped(loadAnalyticsNow(createAdminClient(), { includeTest })),
  ["admin-analytics-now-v1"],
  keep,
);

const rangeKept = unstable_cache(
  async (from: string, to: string, includeTest: boolean) => stamped(loadAnalyticsRange(createAdminClient(), from, to, { includeTest })),
  ["admin-analytics-range-v1"],
  keep,
);

const productKept = unstable_cache(
  async (from: string, to: string, includeTest: boolean) => stamped(loadProductAnalytics(createAdminClient(), from, to, includeTest)),
  ["admin-analytics-product-v1"],
  keep,
);

const pushKept = unstable_cache(
  async (from: string, to: string, includeTest: boolean) => stamped(loadPushProblemAnalytics(createAdminClient(), from, to, includeTest)),
  ["admin-analytics-push-v1"],
  keep,
);

// Several sections read the same answer (the tiles, the chart and the lists
// all use the window's); React's cache makes that one read per request.
export const analyticsNow: (includeTest: boolean) => Promise<Stamped<AnalyticsNow>> = cache((includeTest: boolean) => nowKept(includeTest));
export const analyticsRange: (from: string, to: string, includeTest: boolean) => Promise<Stamped<AnalyticsRange>> = cache(
  (from: string, to: string, includeTest: boolean) => rangeKept(from, to, includeTest),
);
export const productAnalytics: (from: string, to: string, includeTest: boolean) => Promise<Stamped<ProductAnalytics>> = cache(
  (from: string, to: string, includeTest: boolean) => productKept(from, to, includeTest),
);
export const pushProblemAnalytics: (from: string, to: string, includeTest: boolean) => Promise<Stamped<PushProblemAnalytics>> = cache(
  (from: string, to: string, includeTest: boolean) => pushKept(from, to, includeTest),
);

let todayWrittenAt = 0;

/**
 * Keep today's snapshot row fresh without the page ever waiting for it.
 *
 * The nightly cron writes how each day ended. Today's point on the chart
 * comes from a row written during the day, so a window that ends today asks
 * for one here: written after the response has gone (Next's after()), at most
 * once every five minutes per server, and a failure only costs today's point.
 * The next time the window's section is worked out, it has the row.
 */
export function refreshTodaySnapshotLater(today: string, nowMs: number = Date.now()): boolean {
  if (nowMs - todayWrittenAt < ANALYTICS_CACHE_SECONDS * 1000) return false;
  todayWrittenAt = nowMs;
  after(async () => {
    try {
      await snapshotHotelMetrics(createAdminClient(), today);
    } catch (e) {
      todayWrittenAt = 0;
      console.error(JSON.stringify({ fn: "analyticsTodaySnapshot", error: e instanceof Error ? e.message : String(e) }));
    }
  });
  return true;
}
