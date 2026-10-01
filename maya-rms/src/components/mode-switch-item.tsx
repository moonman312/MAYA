"use client";

/**
 * One change log line for someone switching the property between simulation
 * and live (src/lib/changelog-mode-switches.ts): a green "Went live" or an
 * amber "Back to simulation" lead, when, and the one line saying what that
 * means for sending. Shaped like the owner's answers and support's changes.
 */

import type { ChangelogModeSwitch } from "@/types/domain";

export function ModeSwitchItem({
  item,
  formatWhen,
  formatAge,
  formatExact,
}: {
  item: ChangelogModeSwitch;
  formatWhen: (iso: string) => string;
  formatAge: (iso: string) => string | null;
  formatExact: (iso: string) => string;
}) {
  const age = formatAge(item.timestamp);
  const live = item.to === "live";
  return (
    <div className="rounded border border-slate-800 p-3" data-mode-switch={item.id}>
      <p className="text-xs text-slate-400">
        <time dateTime={item.timestamp} title={formatExact(item.timestamp)} className="not-italic">
          <span className={`font-medium ${live ? "text-emerald-300" : "text-amber-300"}`}>
            {live ? "Went live" : "Back to simulation"}
          </span>
          <span className="text-slate-500"> · </span>
          <span>{formatWhen(item.timestamp)}</span>
          {age ? <span className="text-slate-500"> ({age})</span> : null}
        </time>
      </p>
      <p className="mt-1 text-[0.8125rem] leading-relaxed text-slate-300">{item.title}</p>
    </div>
  );
}
