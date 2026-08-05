"use client";

import { useMemo, useRef, useState } from "react";
import type { DayPoint } from "@/lib/admin/analytics";

/**
 * The panel's two time charts, as plain SVG.
 *
 * Palette per the dataviz method, validated for MAYA's dark surface (#0f172a):
 * net MRR is the story so it wears slot-1 blue (#3987e5) with list MRR as
 * de-emphasis gray context; the properties chart tells two series apart, so
 * trialing takes slot-2 orange (#d95926) — worst pair ΔE 26.8 CVD / 31.8
 * normal, ≥3:1 on surface, all gates passing. Text wears text tokens, never
 * series color; every value is also in the drill-down tables below the charts,
 * so the hover layer enhances rather than gates.
 */

const BLUE = "#3987e5";
const ORANGE = "#d95926";
const GRAY = "#64748b";

const W = 640;
const H = 180;
const PAD = { l: 46, r: 12, t: 10, b: 22 };

function usd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.5; v += step) ticks.push(v);
  return ticks;
}

type Series = { label: string; color: string; values: number[]; fmt: (v: number) => string };

function LineChart({ title, days, series }: { title: string; days: string[]; series: Series[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const maxV = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(maxV);
  const top = ticks[ticks.length - 1];
  const x = (i: number) => PAD.l + (days.length < 2 ? 0 : (i * (W - PAD.l - PAD.r)) / (days.length - 1));
  const y = (v: number) => H - PAD.b - (v / top) * (H - PAD.t - PAD.b);

  const path = (values: number[]) => values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || days.length === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        {series.length > 1 && (
          <div className="flex gap-4 text-xs text-slate-400">
            {series.map((s) => (
              <span key={s.label} className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {days.length < 2 ? (
        <p className="py-8 text-center text-xs text-slate-500">
          Not enough history yet — the nightly snapshot has {days.length} day{days.length === 1 ? "" : "s"} so far.
        </p>
      ) : (
        <div className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="#1e293b" strokeWidth="1" />
                <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#64748b">
                  {series[0].fmt(t)}
                </text>
              </g>
            ))}
            {series.map((s) => (
              <path key={s.label} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {hover != null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="#475569" strokeWidth="1" />
                {series.map((s) => (
                  <circle key={s.label} cx={x(hover)} cy={y(s.values[hover])} r="4" fill={s.color} stroke="#0f172a" strokeWidth="2" />
                ))}
              </g>
            )}
            <text x={PAD.l} y={H - 6} fontSize="10" fill="#64748b">{days[0]}</text>
            <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="10" fill="#64748b">{days[days.length - 1]}</text>
          </svg>
          {hover != null && (
            <div className="pointer-events-none absolute top-2 rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs" style={{ left: `${(x(hover) / W) * 100}%` }}>
              <div className="mb-0.5 text-slate-400">{days[hover]}</div>
              {series.map((s) => (
                <div key={s.label} className="flex items-center gap-1.5">
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                  <span className="font-semibold text-slate-100">{s.fmt(s.values[hover])}</span>
                  <span className="text-slate-500">{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AnalyticsCharts({ series }: { series: DayPoint[] }) {
  const days = useMemo(() => series.map((p) => p.day.slice(5)), [series]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <LineChart
        title="Monthly recurring revenue"
        days={days}
        series={[
          { label: "net", color: BLUE, values: series.map((p) => p.netMrrCents), fmt: usd },
          { label: "list", color: GRAY, values: series.map((p) => p.listMrrCents), fmt: usd },
        ]}
      />
      <LineChart
        title="Properties"
        days={days}
        series={[
          { label: "paying", color: BLUE, values: series.map((p) => p.entitled), fmt: String },
          { label: "trialing", color: ORANGE, values: series.map((p) => p.trialing), fmt: String },
        ]}
      />
    </div>
  );
}

/** Horizontal funnel — single hue, magnitude is the job. */
export function FunnelBars({ funnel }: { funnel: { stage: string; count: number }[] }) {
  const max = Math.max(1, ...funnel.map((f) => f.count));
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Signup funnel (range)</h3>
      <div className="space-y-2">
        {funnel.map((f) => (
          <div key={f.stage} className="flex items-center gap-3 text-xs">
            <span className="w-40 shrink-0 text-slate-400">{f.stage}</span>
            <div className="h-4 flex-1">
              <div
                className="h-4 rounded-r"
                style={{ width: `${Math.max(1.5, (f.count / max) * 100)}%`, background: BLUE }}
                title={String(f.count)}
              />
            </div>
            <span className="w-10 text-right font-semibold tabular-nums text-slate-100">{f.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
