"use client";

/**
 * One change log item for a change MAYA support made to the property in God
 * Mode: the "Changed by MAYA support" lead, when, and what changed in one
 * line. Shaped like the owner's own answers so it reads as part of the same
 * story.
 */

import { SUPPORT_CHANGE_LEAD } from "@/lib/changelog-support";
import type { ChangelogSupportChange } from "@/types/domain";

export function SupportChangeItem({
  item,
  formatWhen,
  formatAge,
  formatExact,
}: {
  item: ChangelogSupportChange;
  formatWhen: (iso: string) => string;
  formatAge: (iso: string) => string | null;
  formatExact: (iso: string) => string;
}) {
  const age = formatAge(item.timestamp);
  return (
    <div className="rounded border border-slate-800 p-3" data-support-change={item.id}>
      <p className="text-xs text-slate-400">
        <time dateTime={item.timestamp} title={formatExact(item.timestamp)} className="not-italic">
          <span className="font-medium text-slate-300">{SUPPORT_CHANGE_LEAD}</span>
          <span className="text-slate-500"> · </span>
          <span>{formatWhen(item.timestamp)}</span>
          {age ? <span className="text-slate-500"> ({age})</span> : null}
        </time>
      </p>
      <p className="mt-1 text-[0.8125rem] leading-relaxed text-slate-300">
        {SUPPORT_CHANGE_LEAD}: {item.summary}
      </p>
    </div>
  );
}
