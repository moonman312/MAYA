"use client";

/**
 * One change log line for pricing runs in a row that changed nothing: how
 * many, when the first and last of them ran, and how long ago the last one
 * was. Quieter than a run that changed something, so the changes stand out.
 */

import { clockTime, sameDay, shortTime } from "@/components/push-problem-item";
import type { ChangelogQuietChecks } from "@/types/domain";

/** "Prices checked 47 times, nothing needed to change." */
export function quietChecksText(item: Pick<ChangelogQuietChecks, "checks" | "just_before">): string {
  const times = item.checks === 1 ? "once" : `${item.checks.toLocaleString()} times`;
  return item.just_before
    ? `Just before that, prices were checked ${times} and nothing needed to change.`
    : `Prices checked ${times}, nothing needed to change.`;
}

/** "from Sep 24, 10:05 AM to 1:55 PM", or the one time when the stretch is a single check. */
export function quietChecksSpan(item: Pick<ChangelogQuietChecks, "first_at" | "timestamp">): string {
  if (item.first_at === item.timestamp) return shortTime(item.timestamp);
  const end = sameDay(item.first_at, item.timestamp) ? clockTime(item.timestamp) : shortTime(item.timestamp);
  return `from ${shortTime(item.first_at)} to ${end}`;
}

export function QuietChecksLine({
  item,
  formatAge,
  formatExact,
}: {
  item: ChangelogQuietChecks;
  formatAge: (iso: string) => string | null;
  formatExact: (iso: string) => string;
}) {
  const age = formatAge(item.timestamp);
  const exact =
    item.first_at === item.timestamp
      ? formatExact(item.timestamp)
      : `${formatExact(item.first_at)} to ${formatExact(item.timestamp)}`;
  return (
    <p className="px-3 py-1 text-xs text-slate-500">
      <span className="text-slate-400">{quietChecksText(item)}</span>{" "}
      <time dateTime={item.timestamp} title={exact} className="not-italic">
        {quietChecksSpan(item)}
        {age ? ` (${age})` : ""}
      </time>
    </p>
  );
}
