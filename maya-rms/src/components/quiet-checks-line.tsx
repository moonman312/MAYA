"use client";

/**
 * One change log line for pricing runs in a row that changed nothing: how
 * many, when the first and last of them ran, and how long ago the last one
 * was, all in one sentence. Quieter than a run that changed something (small
 * type, no card), so the changes stand out, but its times read as clearly as
 * a run's date does.
 */

import { clockTime, sameDay, shortTime } from "@/components/push-problem-item";
import type { ChangelogQuietChecks } from "@/types/domain";

/** "from Sep 24, 10:05 AM to 1:55 PM", or "at Sep 24, 1:55 PM" when the stretch is a single check. */
export function quietChecksSpan(item: Pick<ChangelogQuietChecks, "first_at" | "timestamp">): string {
  if (item.first_at === item.timestamp) return `at ${shortTime(item.timestamp)}`;
  const end = sameDay(item.first_at, item.timestamp) ? clockTime(item.timestamp) : shortTime(item.timestamp);
  return `from ${shortTime(item.first_at)} to ${end}`;
}

/**
 * The sentence around the span: "Prices checked 47 times" before it and
 * ", nothing needed to change." after, or the "Just before that" wording
 * for the stretch under the oldest change shown.
 */
export function quietChecksWords(item: Pick<ChangelogQuietChecks, "checks" | "just_before">): {
  lead: string;
  tail: string;
} {
  const times = item.checks === 1 ? "once" : `${item.checks.toLocaleString()} times`;
  return item.just_before
    ? { lead: `Just before that, prices were checked ${times}`, tail: " and nothing needed to change." }
    : { lead: `Prices checked ${times}`, tail: ", nothing needed to change." };
}

/** "Prices checked 47 times from Sep 24, 10:05 AM to 1:55 PM, nothing needed to change." */
export function quietChecksText(item: Pick<ChangelogQuietChecks, "checks" | "just_before" | "first_at" | "timestamp">): string {
  const { lead, tail } = quietChecksWords(item);
  return `${lead} ${quietChecksSpan(item)}${tail}`;
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
  const { lead, tail } = quietChecksWords(item);
  return (
    <p className="px-3 py-1 text-xs text-slate-400">
      {lead}{" "}
      <time dateTime={item.timestamp} title={exact} className="not-italic">
        {quietChecksSpan(item)}
        {age ? ` (${age})` : ""}
      </time>
      {tail}
    </p>
  );
}
