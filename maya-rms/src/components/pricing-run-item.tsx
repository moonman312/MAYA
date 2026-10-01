"use client";

/**
 * One pricing run in the change log: when it ran, then each night it changed,
 * biggest move first. Each change has its bold line, a short line saying where
 * the price went, and the sentences saying why.
 *
 * The words come from the server, worded for the mode the property was in at
 * the run's time (src/lib/price-mode.ts): a simulated run is tagged
 * "Simulation", its bold line says what would have happened, and its line
 * under it says nothing was sent. A live change says it was sent only when
 * the send ledger shows it. A change without those words (the demo log, or a
 * property whose history can't be told) reads as the log always did.
 */

import { ExplainDrilldown } from "@/components/explain-drilldown";
import { moreChangesLine } from "@/lib/changelog-route-helpers";
import type { ChangelogCycle, ChangelogEntry } from "@/types/domain";

/** The bold line for a change that came without one: the log's own, from the two prices. */
export function legacyHeadline(ch: Pick<ChangelogEntry, "room_type" | "stay_date" | "original_rate" | "new_rate" | "change_pct">): string {
  const stay = ch.stay_date ? ` · stay ${ch.stay_date}` : "";
  const way = ch.new_rate >= ch.original_rate ? "up" : "down";
  return `${ch.room_type}${stay}: $${ch.original_rate.toFixed(2)} ${way} to $${ch.new_rate.toFixed(2)} (${ch.change_pct >= 0 ? "+" : ""}${ch.change_pct}%)`;
}

/** The colour of each "where the price went" line; a rule's fire log uses the same. */
export const SEND_TONE: Record<NonNullable<ChangelogEntry["send_state"]>, string> = {
  simulated: "text-amber-300/90",
  sent: "text-emerald-300/90",
  waiting: "text-slate-400",
  failed: "text-rose-300",
  held: "text-amber-200/90",
  not_sent: "text-slate-400",
};

export function PricingRunItem({
  cycle,
  formatWhen,
  formatAge,
  formatExact,
  drilldownOpen = () => false,
}: {
  cycle: ChangelogCycle;
  formatWhen: (iso: string) => string;
  formatAge: (iso: string) => string | null;
  formatExact: (iso: string) => string;
  /** Whether a link asked for this change's "Show the numbers" to open. */
  drilldownOpen?: (runId: string, stayDate: string, roomTypeId: string) => boolean;
}) {
  const age = formatAge(cycle.timestamp);
  const more = moreChangesLine(cycle);
  return (
    <div
      className="rounded border border-slate-800 p-3"
      data-deeplink={cycle.changes[0]?.evaluation_run_id ? `changelog.run:${cycle.changes[0].evaluation_run_id}` : undefined}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
        <time dateTime={cycle.timestamp} title={formatExact(cycle.timestamp)} className="not-italic">
          <span className="font-medium text-slate-300">Pricing run</span>
          <span className="text-slate-500"> · </span>
          <span>{formatWhen(cycle.timestamp)}</span>
          {age ? <span className="text-slate-500"> ({age})</span> : null}
        </time>
        {cycle.mode === "simulation" ? (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-px text-[0.6875rem] font-medium text-amber-300">
            Simulation
          </span>
        ) : null}
      </p>
      <ul className="mt-2 space-y-3">
        {cycle.changes.map((ch, idx) => (
          <li
            key={`${cycle.cycle}-${idx}`}
            data-deeplink={
              ch.evaluation_run_id ? `changelog.entry:${ch.evaluation_run_id}:${ch.stay_date ?? ""}:${ch.room_type_id ?? ""}` : undefined
            }
          >
            <div className="text-sm font-medium text-slate-200">{ch.headline ?? legacyHeadline(ch)}</div>
            {ch.send_line ? (
              <p className={`mt-0.5 text-xs ${SEND_TONE[ch.send_state ?? "waiting"]}`}>{ch.send_line}</p>
            ) : null}
            {(ch.narrative && ch.narrative.length > 0 ? ch.narrative : [ch.description]).map((sentence, si) => (
              <p key={si} className="mt-0.5 text-[0.8125rem] leading-relaxed text-slate-400">
                {sentence}
              </p>
            ))}
            {ch.has_booking_speed_details && ch.evaluation_run_id && ch.stay_date && ch.room_type_id ? (
              <ExplainDrilldown
                runId={ch.evaluation_run_id}
                stayDate={ch.stay_date}
                roomTypeId={ch.room_type_id}
                initialOpen={drilldownOpen(ch.evaluation_run_id, ch.stay_date, ch.room_type_id)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {more ? <p className="mt-3 text-xs text-slate-400">{more}</p> : null}
    </div>
  );
}
