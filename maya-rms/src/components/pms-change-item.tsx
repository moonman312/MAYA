"use client";

/**
 * One change log item about a rate changed in the property system on a night
 * MAYA sent to: MAYA sending its price again over it ("MAYA's price wins"),
 * or the warning that something other than MAYA seems to be changing rates,
 * whose button opens the setting. Shaped like the support and answer items,
 * so it reads as part of the same story.
 */

import { OPEN_PMS_SETTING, pmsChangeLead } from "@/lib/changelog-pms-changes";
import type { ChangelogPmsChange } from "@/types/domain";

export function PmsChangeItem({
  item,
  formatWhen,
  formatAge,
  formatExact,
  onOpenSetting,
}: {
  item: ChangelogPmsChange;
  formatWhen: (iso: string) => string;
  formatAge: (iso: string) => string | null;
  formatExact: (iso: string) => string;
  /** Opens Settings at the property system's section. */
  onOpenSetting: () => void;
}) {
  const age = formatAge(item.timestamp);
  const warning = item.change === "other_tool";
  return (
    <div
      className={`rounded border p-3 ${warning ? "border-amber-500/40 bg-amber-500/5" : "border-slate-800"}`}
      data-pms-change={item.id}
    >
      <p className="text-xs text-slate-400">
        <time dateTime={item.timestamp} title={formatExact(item.timestamp)} className="not-italic">
          <span className={`font-medium ${warning ? "text-amber-200" : "text-slate-300"}`}>{pmsChangeLead(item.pms)}</span>
          <span className="text-slate-500"> · </span>
          <span>{formatWhen(item.timestamp)}</span>
          {age ? <span className="text-slate-500"> ({age})</span> : null}
        </time>
      </p>
      <p className="mt-1 text-[0.8125rem] leading-relaxed text-slate-300">{item.title}</p>
      {warning && !item.setting_on ? (
        <button
          type="button"
          onClick={onOpenSetting}
          className="mt-2 cursor-pointer rounded bg-slate-800 px-3 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700"
        >
          {OPEN_PMS_SETTING}
        </button>
      ) : null}
    </div>
  );
}
