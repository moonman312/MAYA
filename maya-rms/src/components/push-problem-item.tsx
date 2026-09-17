"use client";

/**
 * One change log item for rates that are not reaching the PMS.
 *
 * Collapsed, it says the root cause, how much it touches, whether it is still
 * happening and what the owner can do. Opened, it lists the tries behind it,
 * already condensed by the route so a run of identical refusals is one line
 * with a count. The PMS's own wording sits behind a hover on that line.
 */

import { useState } from "react";
import type { ChangelogItem, ChangelogPushProblem, PushProblemRetries } from "@/types/domain";

export function isPushProblem(item: ChangelogItem): item is ChangelogPushProblem {
  return "kind" in item && item.kind === "push_problem";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function clockTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "12 tries, Sep 17, 10:05 AM to 10:50 AM, 6 nights: Cloudbeds refused them" */
export function retriesLine(r: PushProblemRetries): string {
  const when =
    r.first_at === r.last_at
      ? shortTime(r.first_at)
      : `${shortTime(r.first_at)} to ${sameDay(r.first_at, r.last_at) ? clockTime(r.last_at) : shortTime(r.last_at)}`;
  return `${plural(r.count, "try", "tries")}, ${when}, ${plural(r.nights, "night", "nights")}: ${r.label}`;
}

export function PushProblemItem({
  item,
  formatWhen,
  formatAge,
  formatExact,
}: {
  item: ChangelogPushProblem;
  /** The change log's own date line. */
  formatWhen: (iso: string) => string;
  formatAge: (iso: string) => string | null;
  formatExact: (iso: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ongoing = item.status === "ongoing";
  const age = formatAge(item.timestamp);
  const ended = item.resolved_at
    ? `${item.resolution === "landed" ? "Resolved" : "Ended"} ${formatWhen(item.resolved_at)}`
    : "Still happening";

  return (
    <div className={`rounded border p-3 ${ongoing ? "border-amber-500/40" : "border-slate-800"}`}>
      <p className="text-xs text-slate-400">
        <time dateTime={item.timestamp} title={formatExact(item.timestamp)} className="not-italic">
          <span className={`font-medium ${ongoing ? "text-amber-300" : "text-slate-300"}`}>
            Rates not reaching {item.pms}
          </span>
          <span className="text-slate-500"> · </span>
          <span>{formatWhen(item.timestamp)}</span>
          {age ? <span className="text-slate-500"> ({age})</span> : null}
        </time>
      </p>
      <p className="mt-2 text-sm font-medium text-slate-200">{item.title}.</p>
      <p className="mt-0.5 text-[13px] leading-relaxed text-slate-400">
        {plural(item.nights, "night", "nights")}
        {item.room_types.length > 0 ? `, ${plural(item.room_types.length, "room type", "room types")}` : ""}
        <span className="text-slate-500"> · </span>
        <span className={ongoing ? "text-amber-200" : undefined}>{ended}</span>
      </p>
      {item.action ? <p className="mt-0.5 text-[13px] leading-relaxed text-slate-300">{item.action}</p> : null}
      {item.retries.length > 0 ? (
        <button
          className="mt-1 cursor-pointer text-xs text-sky-400 hover:text-sky-300"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide tries" : `Show ${plural(item.attempts, "try", "tries")}`}
        </button>
      ) : null}
      {open ? (
        <ul className="mt-2 space-y-1 rounded border border-slate-800 bg-slate-950/60 p-3">
          {item.retries.map((r, i) => (
            <li key={i} className="text-xs text-slate-400" title={r.detail ?? undefined}>
              {retriesLine(r)}
            </li>
          ))}
          {item.retries_not_kept > 0 ? (
            <li className="text-xs text-slate-500">{plural(item.retries_not_kept, "later try", "later tries")} not kept</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
