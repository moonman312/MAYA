import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AnalyticsRangePicker } from "@/components/admin/analytics-range-picker";
import { AnalyticsRefresh } from "@/components/admin/analytics-refresh";
import { getAdminSession } from "@/lib/admin/admin-session";
import { refreshTodaySnapshotLater } from "@/lib/admin/analytics-cache";
import { analyticsHref, analyticsWindow, rangeInWords } from "@/lib/admin/analytics-window";
import {
  AsOf,
  Charts,
  ChartsSkeleton,
  EventTables,
  EventTablesSkeleton,
  GainedLostTile,
  NeedsAttention,
  NowTiles,
  PanelSkeleton,
  Product,
  ProductSkeleton,
  PushProblems,
  RevenueBySize,
  Signups,
  TileSkeleton,
} from "./sections";

export const dynamic = "force-dynamic";

/**
 * The business on one screen: how much, growing or not, where the funnel
 * leaks, and which specific customers need a human today. High level on top,
 * names at the bottom — every aggregate up top has a drill-down table below
 * it, because "churn is 3" is a chart and "churn is these three hotels" is a
 * to-do list.
 *
 * The heading and the date picker show at once; every section below sits in
 * its own Suspense boundary and fills in when its numbers are ready, from the
 * five-minute cache when they are there (lib/admin/analytics-cache.ts). The
 * sections that depend on the window are keyed by it, so a new window shows
 * their placeholders straight away; "right now" is keyed by the test toggle
 * only and stays put while the dates change.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; test?: string }>;
}) {
  // Before anything is read: the kept numbers are the same for every admin.
  const session = await getAdminSession();
  if (!session.ok) redirect("/login");

  const today = new Date().toISOString().slice(0, 10);
  // Sandbox properties, e2e fixtures and walkthrough signups are flagged
  // is_test and excluded — a Stripe test-mode checkout is a real subscription
  // row and would otherwise read as a customer. The toggle is for verifying
  // the panel itself on a deployment whose only data is test data.
  const { from, to, includeTest } = analyticsWindow(await searchParams, today);
  const words = rangeInWords(from, to, today);
  const shown = { from, to, includeTest, words };
  const rangeKey = `${from}:${to}:${includeTest ? 1 : 0}`;
  const nowKey = includeTest ? "with-test" : "without-test";

  // Today's point on the chart: written after this response has gone.
  if (to >= today) refreshTodaySnapshotLater(today);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold text-slate-100">Analytics</h1>
          <Link href={analyticsHref(from, to, !includeTest)} className="text-xs text-slate-500 hover:text-slate-300">
            {includeTest ? "Hide test properties" : "Show test properties"}
          </Link>
        </div>
        <div className="flex flex-col items-end gap-2">
          <AnalyticsRangePicker from={from} to={to} includeTest={includeTest} today={today} />
          <div className="flex items-center gap-3">
            <Suspense key={`as-of:${rangeKey}`} fallback={null}>
              <AsOf from={from} to={to} includeTest={includeTest} />
            </Suspense>
            <AnalyticsRefresh />
          </div>
        </div>
      </div>

      {includeTest && (
        <p className="rounded border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-xs text-amber-200">
          Counting test properties and walkthrough signups. These are not customers.
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Suspense key={`now-tiles:${nowKey}`} fallback={<TileSkeleton count={3} />}>
          <NowTiles includeTest={includeTest} />
        </Suspense>
        <Suspense key={`gained-lost:${rangeKey}`} fallback={<TileSkeleton />}>
          <GainedLostTile {...shown} />
        </Suspense>
      </section>

      <Suspense key={`charts:${rangeKey}`} fallback={<ChartsSkeleton />}>
        <Charts {...shown} />
      </Suspense>

      <Suspense key={`product:${rangeKey}`} fallback={<ProductSkeleton />}>
        <Product {...shown} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense key={`signups:${rangeKey}`} fallback={<PanelSkeleton />}>
          <Signups {...shown} />
        </Suspense>
        <Suspense key={`by-size:${nowKey}`} fallback={<PanelSkeleton />}>
          <RevenueBySize includeTest={includeTest} />
        </Suspense>
      </div>

      <Suspense key={`push:${rangeKey}`} fallback={<PanelSkeleton className="h-40" />}>
        <PushProblems {...shown} />
      </Suspense>

      <Suspense key={`attention:${nowKey}`} fallback={<PanelSkeleton className="h-32" />}>
        <NeedsAttention includeTest={includeTest} />
      </Suspense>

      <Suspense key={`events:${rangeKey}`} fallback={<EventTablesSkeleton />}>
        <EventTables {...shown} />
      </Suspense>
    </div>
  );
}
