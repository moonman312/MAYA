import Link from "next/link";
import type { ReactNode } from "react";
import { AnalyticsCharts, FunnelBars } from "@/components/admin/analytics-charts";
import { LocalTime } from "@/components/admin/local-time";
import {
  AcquisitionPanel,
  BookTiles,
  CancellationsPanel,
  EngagementPanel,
  GroupsPanel,
  HealthPanel,
  ProductFunnels,
  PushProblemsPanel,
  RetentionPanel,
  TimeToValuePanel,
  TrialsPanel,
  WalkedAwayCard,
} from "@/components/admin/product-analytics-panels";
import { AnalyticsMigrationMissing, type HotelRef, type SubscriptionEvent } from "@/lib/admin/analytics";
import { analyticsNow, analyticsRange, productAnalytics, pushProblemAnalytics } from "@/lib/admin/analytics-cache";
import { formatUsd } from "@/lib/billing/tiers";

/**
 * The analytics page, one section at a time. Each is its own async component
 * so the page can wrap it in its own Suspense boundary: the shell shows at
 * once and each section fills in when its numbers arrive, kept for the
 * current five minutes when they are there (analytics-cache.ts). A section that fails
 * says so in place and never takes the others down.
 */

type Window = { from: string; to: string; includeTest: boolean; words: string };

/** Awaits one section's numbers, or says in place why there are none. */
async function settle<T>(work: Promise<T>, fn: string): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await work };
  } catch (e) {
    if (e instanceof AnalyticsMigrationMissing) return { ok: false, message: e.message };
    console.error(JSON.stringify({ fn, error: e instanceof Error ? e.message : String(e) }));
    return { ok: false, message: "Could not load these numbers. The server log has the error." };
  }
}

function Unavailable({ message, className = "" }: { message: string; className?: string }) {
  return <p className={`rounded border border-slate-800 bg-slate-900 px-4 py-3 text-xs text-slate-400 ${className}`}>{message}</p>;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{value}</div>
      {hint && <div className="mt-1 text-[0.6875rem] text-slate-500">{hint}</div>}
    </div>
  );
}

// ── Placeholders ────────────────────────────────────────────────────────────
// Roughly the size of what replaces them, so the page doesn't jump.

function Block({ className }: { className: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg border border-slate-800 bg-slate-900/60 ${className}`} />;
}

export function TileSkeleton({ count = 1 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Block key={i} className="h-[5.75rem]" />
      ))}
    </>
  );
}

export function PanelSkeleton({ className = "h-48" }: { className?: string }) {
  return <Block className={className} />;
}

export function ChartsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Block className="h-[14.75rem]" />
      <Block className="h-[14.75rem]" />
    </div>
  );
}

export function ProductSkeleton() {
  return (
    <div className="space-y-6">
      <Block className="h-64" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TileSkeleton count={4} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Block className="h-72" />
        <Block className="h-72" />
      </div>
    </div>
  );
}

export function EventTablesSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Block className="h-28" />
      <Block className="h-28" />
      <Block className="h-28" />
    </div>
  );
}

// ── As of ───────────────────────────────────────────────────────────────────

/**
 * When the oldest of the page's numbers was worked out: kept ones are at most
 * five minutes old. The date shows too when that was not today, for a page
 * left open overnight.
 */
export async function AsOf({ from, to, includeTest, today }: Omit<Window, "words"> & { today: string }) {
  const stamps = await Promise.allSettled([
    analyticsNow(includeTest),
    analyticsRange(from, to, includeTest),
    productAnalytics(from, to, includeTest),
    pushProblemAnalytics(from, to, includeTest),
  ]);
  const times = stamps.flatMap((s) => (s.status === "fulfilled" ? [s.value.computedAt] : [])).sort();
  if (times.length === 0) return null;
  return (
    <span className="text-xs text-slate-500">
      as of <LocalTime iso={times[0]} serverToday={today} />
    </span>
  );
}

// ── Right now ───────────────────────────────────────────────────────────────

export async function NowTiles({ includeTest }: { includeTest: boolean }) {
  const r = await settle(analyticsNow(includeTest), "analyticsNowTiles");
  if (!r.ok) return <Unavailable message={r.message} className="sm:col-span-2 lg:col-span-3" />;
  const now = r.value.value;
  return (
    <>
      <Tile label="Net MRR" value={formatUsd(now.netMrrCents)} hint={`${formatUsd(now.listMrrCents)} before discounts`} />
      <Tile label="Paying properties" value={String(now.payingCount)} hint={`${now.liveCount} live · ${now.simulationCount} simulating`} />
      <Tile label="On trial" value={String(now.trialingCount)} hint={`${formatUsd(now.trialPotentialCents)}/mo if they all pay`} />
    </>
  );
}

export async function RevenueBySize({ includeTest }: { includeTest: boolean }) {
  const r = await settle(analyticsNow(includeTest), "analyticsRevenueBySize");
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Revenue by property size</h3>
      {!r.ok ? (
        <p className="text-xs text-slate-400">{r.message}</p>
      ) : (
        <div className="space-y-2">
          {r.value.value.byBracket.map((b) => (
            <div key={b.label} className="flex items-center justify-between text-xs">
              <span className="text-slate-400">{b.label} rooms</span>
              <span className="text-slate-300">
                {b.count} propert{b.count === 1 ? "y" : "ies"} ·{" "}
                <span className="font-semibold text-slate-100">{formatUsd(b.netMrrCents)}/mo</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
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

export async function NeedsAttention({ includeTest }: { includeTest: boolean }) {
  const r = await settle(analyticsNow(includeTest), "analyticsAttention");
  const shell = (count: string, body: ReactNode) => (
    <section className="rounded-lg border border-slate-800 bg-slate-900">
      <h2 className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-slate-200">Needs attention {count}</h2>
      {body}
    </section>
  );
  if (!r.ok) return shell("", <p className="px-4 py-6 text-xs text-slate-400">{r.message}</p>);
  const { attention } = r.value.value;
  const count = attention.cardTrouble.length + attention.roomShortfall.length + attention.syncBroken.length + attention.engineSilent.length;
  return shell(
    count > 0 ? `(${count})` : "",
    count === 0 ? (
      <p className="px-4 py-6 text-sm text-slate-500">Nothing. A good day.</p>
    ) : (
      <div className="divide-y divide-slate-800">
        <AttentionRows label="Card failed its re-check" refs={attention.cardTrouble} />
        <AttentionRows label="Billing fewer rooms than they run" refs={attention.roomShortfall} />
        <AttentionRows
          label="PMS connection broken"
          refs={attention.syncBroken.map((s) => ({ ...s, name: `${s.name}: ${s.pmsType} ${s.status}` }))}
        />
        <AttentionRows label="Served, but no pricing run in 24 hours" refs={attention.engineSilent} />
      </div>
    ),
  );
}

// ── The window ──────────────────────────────────────────────────────────────

export async function GainedLostTile({ from, to, includeTest, words }: Window) {
  const r = await settle(analyticsRange(from, to, includeTest), "analyticsGainedLost");
  if (!r.ok) return <Unavailable message={r.message} />;
  const range = r.value.value;
  const hours = range.medianHoursToLive;
  return (
    <Tile
      label="Gained / lost"
      value={`+${range.newPaying.length + range.wonBack.length} / −${range.churned.length}`}
      hint={`${words} · ${hours != null ? `${Math.round(hours)}h median to first price` : "no first prices"}`}
    />
  );
}

export async function Charts({ from, to, includeTest }: Window) {
  const r = await settle(analyticsRange(from, to, includeTest), "analyticsCharts");
  if (!r.ok) return <Unavailable message={r.message} />;
  return <AnalyticsCharts series={r.value.value.series} />;
}

export async function Signups({ from, to, includeTest, words }: Window) {
  const r = await settle(analyticsRange(from, to, includeTest), "analyticsSignups");
  if (!r.ok) return <Unavailable message={r.message} />;
  return <FunnelBars funnel={r.value.value.funnel} title={`Signups, ${words}`} />;
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

export async function EventTables({ from, to, includeTest }: Window) {
  const r = await settle(analyticsRange(from, to, includeTest), "analyticsEvents");
  if (!r.ok) return <Unavailable message={r.message} />;
  const range = r.value.value;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <EventTable title={`New paying (${range.newPaying.length})`} events={range.newPaying} />
      <EventTable title={`Won back (${range.wonBack.length})`} events={range.wonBack} />
      <EventTable title={`Churned (${range.churned.length})`} events={range.churned} />
    </div>
  );
}

// ── Product and rate push ───────────────────────────────────────────────────

export async function Product({ from, to, includeTest }: Window) {
  const r = await settle(productAnalytics(from, to, includeTest), "analyticsProductPanels");
  if (!r.ok) return <Unavailable message={r.message} />;
  const product = r.value.value;
  if (!product.available) return <Unavailable message={product.reason} />;
  return (
    <div className="space-y-6">
      <WalkedAwayCard summary={product.walkedAwaySummary} rows={product.walkedAway} from={from} to={to} />
      <BookTiles book={product.book} />
      <ProductFunnels funnel={product.funnel} />
      <div className="grid gap-4 lg:grid-cols-2">
        <TimeToValuePanel rows={product.timeToValue} />
        <RetentionPanel row={product.retention} />
        <TrialsPanel rows={product.trials} />
        <CancellationsPanel rows={product.cancellations} />
        <AcquisitionPanel rows={product.acquisition} />
        <HealthPanel rows={product.health} />
        <EngagementPanel events={product.events} />
        <GroupsPanel rows={product.groups} />
      </div>
    </div>
  );
}

export async function PushProblems({ from, to, includeTest }: Window) {
  const r = await settle(pushProblemAnalytics(from, to, includeTest), "analyticsPushProblems");
  if (!r.ok) return <PushProblemsPanel data={{ available: false, reason: "Could not load rate push problems. The server log has the error." }} />;
  return <PushProblemsPanel data={r.value.value} />;
}
