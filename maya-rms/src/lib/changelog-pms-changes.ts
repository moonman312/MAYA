import type { ChangelogItem, ChangelogPmsChange } from "@/types/domain";
import { pmsName } from "../../supabase/functions/_shared/pms/push-failure";

/**
 * Rates changed in the property system on nights MAYA sent to, as the change
 * log shows them (pms_change_notices, written by the base rate refresh in
 * supabase/functions/_shared/pms/pms-change-watch.ts):
 *
 *   - under "MAYA's price wins", one item per night and room type MAYA sent
 *     its price to again, naming the night, the room type, the rate the
 *     property system had (or that it was removed) and MAYA's price;
 *   - under "Keep the change as your price", the warning that something other
 *     than MAYA seems to be changing rates, with a button to the setting.
 *
 * The log lists the newest MAX_PMS_CHANGES of them in the history it covers;
 * more than that are counted on one line where the oldest listed one sits.
 */

export function isPmsChange(item: ChangelogItem): item is ChangelogPmsChange {
  return "kind" in item && item.kind === "pms_change";
}

/** Items the log lists at most. */
export const MAX_PMS_CHANGES = 50;

export const PMS_CHANGE_COLUMNS = "id, pms_type, kind, found_at, stay_date, room_type_id, pms_rate, maya_price, rates";

export type PmsChangeRow = {
  id: string | number;
  pms_type: string;
  kind: string;
  found_at: string;
  stay_date: string | null;
  room_type_id: string | null;
  pms_rate: number | string | null;
  maya_price: number | string | null;
  rates: number | null;
};

/** What the item's small heading says. */
export const pmsChangeLead = (pms: string) => `Changed in ${pms}`;

/** The button on the warning, which opens the setting. */
export const OPEN_PMS_SETTING = "Open the setting";

/** "Fri, Nov 13". */
export function nightWords(ymd: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).formatToParts(
    new Date(`${ymd.slice(0, 10)}T12:00:00Z`),
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("month")} ${get("day")}`;
}

const money = (v: number, sym: string) => `${sym}${v.toFixed(2)}`;

export function overwriteTitle(p: { pms: string; night: string; roomType: string; pmsRate: number | null; mayaPrice: number; currencySymbol: string }): string {
  const what = p.pmsRate == null ? `the rate was removed in ${p.pms}` : `changed in ${p.pms} to ${money(p.pmsRate, p.currencySymbol)}`;
  return `${nightWords(p.night)}, ${p.roomType}: ${what}. MAYA sent its price, ${money(p.mayaPrice, p.currencySymbol)}, again.`;
}

export function otherToolTitle(pms: string, rates: number): string {
  return (
    `Something other than MAYA seems to be changing rates in ${pms}: ${rates} ${rates === 1 ? "rate" : "rates"} changed in the last 7 days ` +
    `on nights MAYA had sent a price to. Each change is kept as your price, so MAYA isn't pricing those nights. ` +
    `If you use another pricing tool, turn on "MAYA's price wins".`
  );
}

export function moreTitle(pms: string, n: number): string {
  return `And ${n} more ${n === 1 ? "night" : "nights"} where MAYA sent its price again over a rate changed in ${pms}.`;
}

/**
 * The items, newest first. `total` is how many rows there were in the log's
 * history when the read stopped at its cap; the rest are counted on one line.
 */
export function buildPmsChanges(
  rows: PmsChangeRow[],
  opts: { roomTypeNames: Map<string, string>; currencySymbol: string; settingOn: boolean; total?: number },
): ChangelogPmsChange[] {
  const sorted = [...rows].sort((a, b) => Date.parse(b.found_at) - Date.parse(a.found_at));
  const items: ChangelogPmsChange[] = [];
  for (const r of sorted.slice(0, MAX_PMS_CHANGES)) {
    const pms = pmsName(r.pms_type);
    if (r.kind === "other_tool") {
      const rates = Math.max(1, Number(r.rates) || 1);
      items.push({
        kind: "pms_change",
        id: String(r.id),
        timestamp: r.found_at,
        change: "other_tool",
        pms,
        title: otherToolTitle(pms, rates),
        count: rates,
        ...(opts.settingOn ? { setting_on: true } : {}),
      });
      continue;
    }
    if (r.kind !== "overwrite" || !r.stay_date || !r.room_type_id || r.maya_price == null) continue;
    const pmsRate = r.pms_rate == null ? null : Number(r.pms_rate);
    const mayaPrice = Number(r.maya_price);
    const roomType = opts.roomTypeNames.get(String(r.room_type_id)) ?? "A room type";
    items.push({
      kind: "pms_change",
      id: String(r.id),
      timestamp: r.found_at,
      change: "overwrite",
      pms,
      title: overwriteTitle({ pms, night: r.stay_date, roomType, pmsRate, mayaPrice, currencySymbol: opts.currencySymbol }),
      stay_date: r.stay_date.slice(0, 10),
      room_type: roomType,
      pms_rate: pmsRate,
      maya_price: mayaPrice,
    });
  }
  const listed = Math.min(sorted.length, MAX_PMS_CHANGES);
  const more = Math.max(0, (opts.total ?? sorted.length) - listed);
  if (more > 0 && items.length > 0) {
    const oldest = items[items.length - 1];
    items.push({
      kind: "pms_change",
      id: `more-${oldest.id}`,
      timestamp: oldest.timestamp,
      change: "more",
      pms: oldest.pms,
      title: moreTitle(oldest.pms, more),
      count: more,
    });
  }
  return items;
}
