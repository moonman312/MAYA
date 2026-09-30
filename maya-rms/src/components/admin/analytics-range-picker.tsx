"use client";

import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { analyticsHref, rangeChoices, type RangeChoice } from "@/lib/admin/analytics-window";

/**
 * Presets first, since nobody fights a calendar for "last 30 days".
 *
 * A click answers at once: the button lights up and pulses while the page
 * works, and the date boxes take the new day straight away. The last 7, 30
 * and 90 days are fetched ahead as soon as the picker shows, so those
 * usually need no wait at all; the two weeks are fetched when the pointer
 * reaches them.
 */
export function AnalyticsRangePicker({
  from,
  to,
  includeTest = false,
  today,
}: {
  from: string;
  to: string;
  includeTest?: boolean;
  /** The server's UTC day, so the buttons match the page around midnight. */
  today: string;
}) {
  const router = useRouter();
  const [typing, startTyping] = useTransition();
  const [shown, showDays] = useOptimistic({ from, to });
  // The button clicked, remembered against the window it was clicked from so
  // it stops counting once the page has moved on.
  const [clicked, setClicked] = useState<{ label: string; at: string } | null>(null);
  const here = `${from}:${to}`;
  const choices = rangeChoices(today);
  const pickedLabel = clicked?.at === here ? clicked.label : null;

  const typeDays = (f: string, t: string) => {
    startTyping(() => {
      showDays({ from: f, to: t });
      router.push(analyticsHref(f, t, includeTest), { scroll: false });
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={typing || undefined}>
      {choices.map((c) => (
        <RangeButton
          key={c.label}
          choice={c}
          href={analyticsHref(c.from, c.to, includeTest)}
          active={pickedLabel ? pickedLabel === c.label : from === c.from && to === c.to}
          onPick={() => setClicked({ label: c.label, at: here })}
        />
      ))}
      <span className="mx-1 text-slate-700">|</span>
      <input
        type="date"
        aria-label="First day"
        value={shown.from}
        max={shown.to}
        onChange={(e) => e.target.value && typeDays(e.target.value, shown.to)}
        className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
      />
      <span className="text-xs text-slate-500">to</span>
      <input
        type="date"
        aria-label="Last day"
        value={shown.to}
        min={shown.from}
        onChange={(e) => e.target.value && typeDays(shown.from, e.target.value)}
        className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
      />
      <span className={`h-2 w-2 rounded-full bg-sky-400 transition-opacity ${typing ? "animate-pulse opacity-100" : "opacity-0"}`} aria-hidden />
    </div>
  );
}

function RangeButton({ choice, href, active, onPick }: { choice: RangeChoice; href: string; active: boolean; onPick: () => void }) {
  const [warm, setWarm] = useState(false);
  return (
    <Link
      href={href}
      scroll={false}
      // The common windows are fetched ahead; the weeks once the pointer is on them.
      prefetch={choice.common || warm ? true : false}
      onMouseEnter={() => setWarm(true)}
      onFocus={() => setWarm(true)}
      onClick={onPick}
      aria-current={active ? "true" : undefined}
      className={`relative rounded border px-3 py-1.5 text-xs transition ${
        active ? "border-sky-400 bg-sky-500/10 text-sky-200" : "border-slate-700 text-slate-300 hover:border-slate-500"
      }`}
    >
      <PendingPulse />
      {choice.label}
    </Link>
  );
}

/** Pulses the button while its page is on the way; nothing once it is there. */
function PendingPulse() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-0 rounded bg-sky-400/15 transition-opacity ${pending ? "animate-pulse opacity-100" : "opacity-0"}`}
    />
  );
}
