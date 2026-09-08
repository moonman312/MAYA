"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Presets first — nobody fights a calendar for "last 30 days". */
const PRESETS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function AnalyticsRangePicker({
  from,
  to,
  includeTest = false,
}: {
  from: string;
  to: string;
  includeTest?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (f: string, t: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("from", f);
    q.set("to", t);
    if (includeTest) q.set("test", "1");
    else q.delete("test");
    router.push(`${pathname}?${q.toString()}`);
  };

  const preset = (days: number) => {
    const now = new Date();
    go(dayStr(new Date(now.getTime() - (days - 1) * 86_400_000)), dayStr(now));
  };

  const activeDays = (() => {
    const span = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1;
    return to === dayStr(new Date()) ? span : null;
  })();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => preset(p.days)}
          className={`cursor-pointer rounded border px-3 py-1.5 text-xs transition ${
            activeDays === p.days
              ? "border-sky-400 bg-sky-500/10 text-sky-200"
              : "border-slate-700 text-slate-300 hover:border-slate-500"
          }`}
        >
          {p.label}
        </button>
      ))}
      <span className="mx-1 text-slate-700">|</span>
      <input
        type="date"
        value={from}
        max={to}
        onChange={(e) => e.target.value && go(e.target.value, to)}
        className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
      />
      <span className="text-xs text-slate-500">to</span>
      <input
        type="date"
        value={to}
        min={from}
        onChange={(e) => e.target.value && go(from, e.target.value)}
        className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
      />
    </div>
  );
}
