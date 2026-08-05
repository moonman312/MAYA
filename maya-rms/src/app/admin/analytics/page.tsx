import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AnalyticsCharts, FunnelBars } from "@/components/admin/analytics-charts";
import { AnalyticsRangePicker } from "@/components/admin/analytics-range-picker";
import {
  loadAnalyticsNow,
  loadAnalyticsRange,
  snapshotHotelMetrics,
  type HotelRef,
  type SubscriptionEvent,
} from "@/lib/admin/analytics";
import { requirePlatformAdmin } from "@/lib/admin/require-platform-admin";
import { formatUsd } from "@/lib/billing/tiers";

export const dynamic = "force-dynamic";

/**
 * The business on one screen: how much, growing or not, where the funnel
 * leaks, and which specific customers need a human today. High level on top,
 * names at the bottom — every aggregate up top has a drill-down table below
 * it, because "churn is 3" is a chart and "churn is these three hotels" is a
 * to-do list.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; test?: string }>;
}) {
  const ctx = await requirePlatformAdmin(await cookies());
  if (!ctx.ok) redirect("/login");

  const today = new Date().toISOString().slice(0, 10);
  const params = await searchParams;
  const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;
  // Shape alone accepts 2026-02-30, which Postgres then rejects mid-query and
  // 500s the page — round-tripping through Date is what makes a hand-edited
  // URL fall back instead of crash.
  const validDay = (v: string | undefined, fallback: string) =>
    v && DAY_RX.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : fallback;
  const to = validDay(params.to, today);
  const defaultFrom = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const from = validDay(params.from, defaultFrom);
  // Sandbox properties, e2e fixtures and walkthrough signups are flagged
  // is_test and excluded — a Stripe test-mode checkout is a real subscription
  // row and would otherwise read as a customer. The toggle is for verifying
  // the panel itself on a deployment whose only data is test data.
  const scope = { includeTest: params.test === "1" };

  // Lazily write today's snapshot so history accumulates even without the
  // cron. Idempotent upsert; a failure only costs today's point on the chart.
  try {
    await snapshotHotelMetrics(ctx.admin, today);
  } catch (e) {
    console.error(JSON.stringify({ fn: "analyticsLazySnapshot", error: e instanceof Error ? e.message : String(e) }));
  }

  const [now, range] = await Promise.all([
    loadAnalyticsNow(ctx.admin, scope),
    loadAnalyticsRange(ctx.admin, from, to, scope),
  ]);

  const attentionCount =
    now.attention.cardTrouble.length +
    now.attention.roomShortfall.length +
    now.attention.syncBroken.length +
    now.attention.engineSilent.length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold text-slate-100">Analytics</h1>
          <Link
            href={`/admin/analytics?from=${from}&to=${to}${scope.includeTest ? "" : "&test=1"}`}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            {scope.includeTest ? "excluding test properties" : "including test properties"}
          </Link>
        </div>
        <AnalyticsRangePicker from={from} to={to} includeTest={scope.includeTest} />
      </div>

      {scope.includeTest && (
        <p className="rounded border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-xs text-amber-200">
          Counting test properties and walkthrough signups. These are not customers.
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Net MRR" value={formatUsd(now.netMrrCents)} hint={`${formatUsd(now.listMrrCents)} list`} />
        <Tile label="Paying properties" value={String(now.payingCount)} hint={`${now.liveCount} live · ${now.simulationCount} simulating`} />
        <Tile
          label="Trials in flight"
          value={String(now.trialingCount)}
          hint={`${formatUsd(now.trialPotentialCents)}/mo if they convert`}
        />
        <Tile
          label="Range: +/− properties"
          value={`+${range.newPaying.length + range.wonBack.length} / −${range.churned.length}`}
          hint={
            range.medianHoursToLive != null
              ? `${Math.round(range.medianHoursToLive)}h median to first price`
              : "no first-prices in range"
          }
        />
      </section>

      <AnalyticsCharts series={range.series} />

      <div className="grid gap-4 lg:grid-cols-2">
        <FunnelBars funnel={range.funnel} />
        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Revenue by property size</h3>
          <div className="space-y-2">
            {now.byBracket.map((b) => (
              <div key={b.label} className="flex items-center justify-between text-xs">
                <span className="text-slate-400">{b.label} rooms</span>
                <span className="text-slate-300">
                  {b.count} propert{b.count === 1 ? "y" : "ies"} ·{" "}
                  <span className="font-semibold text-slate-100">{formatUsd(b.netMrrCents)}/mo</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-slate-800 bg-slate-900">
        <h2 className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-slate-200">
          Needs attention {attentionCount > 0 ? `(${attentionCount})` : ""}
        </h2>
        {attentionCount === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">Nothing. A good day.</p>
        ) : (
          <div className="divide-y divide-slate-800">
            <AttentionRows label="Card failing re-verification" refs={now.attention.cardTrouble} />
            <AttentionRows label="Billing fewer rooms than they run" refs={now.attention.roomShortfall} />
            <AttentionRows
              label="PMS connection broken"
              refs={now.attention.syncBroken.map((r) => ({ ...r, name: `${r.name} — ${r.pmsType} ${r.status}` }))}
            />
            <AttentionRows label="No engine run in 24h (paying)" refs={now.attention.engineSilent} />
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <EventTable title={`New paying (${range.newPaying.length})`} events={range.newPaying} />
        <EventTable title={`Won back (${range.wonBack.length})`} events={range.wonBack} />
        <EventTable title={`Churned (${range.churned.length})`} events={range.churned} />
      </div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function AttentionRows({ label, refs }: { label: string; refs: HotelRef[] }) {
  if (refs.length === 0) return null;
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 text-xs font-medium text-amber-300">{label}</div>
      <div className="flex flex-wrap gap-2">
        {refs.map((r) => (
          <Link
            key={r.hotelId + r.name}
            href={`/admin/hotels/${r.hotelId}`}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-slate-500"
          >
            {r.name}
          </Link>
        ))}
      </div>
    </div>
  );
}

function EventTable({ title, events }: { title: string; events: SubscriptionEvent[] }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">{title}</h3>
      {events.length === 0 ? (
        <p className="text-xs text-slate-500">None in this range.</p>
      ) : (
        <ul className="space-y-1.5">
          {events.map((e) => (
            <li key={e.hotelId + e.day} className="flex items-center justify-between text-xs">
              <Link href={`/admin/hotels/${e.hotelId}`} className="text-slate-200 hover:text-sky-300">
                {e.name}
              </Link>
              <span className="text-slate-500">{e.day}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
