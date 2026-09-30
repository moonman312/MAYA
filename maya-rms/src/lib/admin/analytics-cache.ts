import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { createAdminClient } from "@/utils/supabase/admin";
import { loadAnalyticsNow, loadAnalyticsRange, snapshotHotelMetrics, type AnalyticsNow, type AnalyticsRange } from "./analytics";
import { loadProductAnalytics, withOwnerEmails, withoutOwnerEmails, type ProductAnalytics } from "./product-analytics";
import { loadPushProblemAnalytics, type PushProblemAnalytics } from "./push-problems";

/**
 * The analytics page's sections, kept in Next's data cache so a second look,
 * or a date change back to a window already seen, answers at once.
 *
 * Kept per five-minute slot of the clock (00:00 to 00:05 UTC, 00:05 to
 * 00:10, ...): the slot is part of every key, so a new slot is a new key and
 * its first load works the numbers out while it waits. Nothing is ever shown
 * from an earlier slot, so the numbers on screen are at most five minutes old.
 * (A plain revalidate time would not do that: once an entry is older than it,
 * Next hands back the old entry, however old, and works out a new one in the
 * background for the load after.)
 *
 * What is kept is the same for every platform admin: it is read with the
 * service role, keyed only by the slot, the window and the test toggle, and
 * holds no one's session and no one's email (the follow-up list's emails are
 * read fresh on each load). Keys also name the Supabase project, so two
 * deployments that share a data cache never hand each other their numbers.
 * The page checks the caller is a platform admin before it reads any of it
 * (getAdminSession), and the Refresh button (a Server Action that checks
 * again) throws it all away.
 *
 * "Right now" does not depend on the window, so it is kept per toggle only
 * and a date change never recomputes it. A failed read is not kept: it throws,
 * the section says so in place, and the next load tries again.
 *
 * unstable_cache is what Next 16 offers without Cache Components, which this
 * app does not turn on; its replacement ("use cache") needs them app-wide.
 */

export const ANALYTICS_CACHE_TAG = "admin-analytics";
/** How long a section is kept, in seconds: one slot. */
export const ANALYTICS_CACHE_SECONDS = 300;
const SLOT_MS = ANALYTICS_CACHE_SECONDS * 1000;

export type Stamped<T> = { value: T; computedAt: string };

/** The Supabase project, as far as the keys need to tell two apart. */
function projectKey(url = process.env.NEXT_PUBLIC_SUPABASE_URL): string {
  try {
    return url ? new URL(url).host : "no-project";
  } catch {
    return url ?? "no-project";
  }
}

/**
 * The five-minute slot a request belongs to and that slot's UTC day, read
 * once per request so every section of one page is kept under the same slot.
 * A slot never straddles midnight (a day is 288 of them).
 */
export const analyticsClock: () => { slot: number; today: string } = cache(() => {
  const slot = Math.floor(Date.now() / SLOT_MS);
  return { slot, today: new Date(slot * SLOT_MS).toISOString().slice(0, 10) };
});

const dayOfSlot = (slot: number) => new Date(slot * SLOT_MS).toISOString().slice(0, 10);

async function stamped<T>(work: Promise<T>): Promise<Stamped<T>> {
  const value = await work;
  return { value, computedAt: new Date().toISOString() };
}

let todayWritten: { slot: number; done: Promise<void> } | null = null;

/**
 * Today's snapshot row, written before a section that reads it is worked out.
 *
 * The nightly cron writes how each day ended. Today's point on the chart,
 * today's new, won back and churned, and "MRR at last count" come from a row
 * written during the day, so the first section in a slot that needs it writes
 * it first and the others on this server wait for that same write: once per
 * slot per server, and only when a section is being worked out, never on a
 * kept load. A failure only costs today's point: it is logged, the section
 * goes on without it, and the next section worked out tries again.
 */
export function todaySnapshotFor(slot: number): Promise<void> {
  if (todayWritten?.slot === slot) return todayWritten.done;
  const done = snapshotHotelMetrics(createAdminClient(), dayOfSlot(slot)).then(
    () => undefined,
    (e: unknown) => {
      if (todayWritten?.done === done) todayWritten = null;
      console.error(JSON.stringify({ fn: "analyticsTodaySnapshot", error: e instanceof Error ? e.message : String(e) }));
    },
  );
  todayWritten = { slot, done };
  return done;
}

const keep = { revalidate: ANALYTICS_CACHE_SECONDS, tags: [ANALYTICS_CACHE_TAG] };
const PROJECT = projectKey();

const nowKept = unstable_cache(
  async (_slot: number, includeTest: boolean) => stamped(loadAnalyticsNow(createAdminClient(), { includeTest })),
  ["admin-analytics-now-v2", PROJECT],
  keep,
);

const rangeKept = unstable_cache(
  async (slot: number, from: string, to: string, includeTest: boolean) => {
    const today = dayOfSlot(slot);
    if (from <= today && today <= to) await todaySnapshotFor(slot);
    return stamped(loadAnalyticsRange(createAdminClient(), from, to, { includeTest }));
  },
  ["admin-analytics-range-v2", PROJECT],
  keep,
);

const productKept = unstable_cache(
  async (slot: number, from: string, to: string, includeTest: boolean) => {
    // "MRR at last count" reads the newest snapshot row, whatever the window.
    await todaySnapshotFor(slot);
    const product = await loadProductAnalytics(createAdminClient(), from, to, includeTest);
    return { value: withoutOwnerEmails(product), computedAt: new Date().toISOString() };
  },
  ["admin-analytics-product-v2", PROJECT],
  keep,
);

const pushKept = unstable_cache(
  async (_slot: number, from: string, to: string, includeTest: boolean) =>
    stamped(loadPushProblemAnalytics(createAdminClient(), from, to, includeTest)),
  ["admin-analytics-push-v2", PROJECT],
  keep,
);

// Several sections read the same answer (the tiles, the chart and the lists
// all use the window's); React's cache makes that one read per request.
export const analyticsNow: (includeTest: boolean) => Promise<Stamped<AnalyticsNow>> = cache((includeTest: boolean) =>
  nowKept(analyticsClock().slot, includeTest),
);
export const analyticsRange: (from: string, to: string, includeTest: boolean) => Promise<Stamped<AnalyticsRange>> = cache(
  (from: string, to: string, includeTest: boolean) => rangeKept(analyticsClock().slot, from, to, includeTest),
);
export const productAnalytics: (from: string, to: string, includeTest: boolean) => Promise<Stamped<ProductAnalytics>> = cache(
  async (from: string, to: string, includeTest: boolean) => {
    const kept = await productKept(analyticsClock().slot, from, to, includeTest);
    return { ...kept, value: await withOwnerEmails(createAdminClient(), kept.value) };
  },
);
export const pushProblemAnalytics: (from: string, to: string, includeTest: boolean) => Promise<Stamped<PushProblemAnalytics>> = cache(
  (from: string, to: string, includeTest: boolean) => pushKept(analyticsClock().slot, from, to, includeTest),
);
