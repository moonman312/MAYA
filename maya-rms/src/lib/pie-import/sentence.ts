/**
 * A MAYA rule in one plain sentence, for the import's review:
 * "Raise the price 10% when sellable occupancy is over 31%, 80 or more days
 * before arrival."
 */

import type { ImportDraft, MayaRoomType } from "./map";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(ymd: string): string {
  return `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`;
}

const num = (n: number) => String(Math.round(n * 10_000) / 10_000);

function money(n: number, symbol: string): string {
  return `${symbol}${Number.isInteger(n) ? String(n) : n.toFixed(2)}`;
}

/** "80 or more days before arrival", from a days-before-arrival condition. */
export function daysPhrase(op: "gt" | "lt", days: number): string {
  if (op === "gt") return `${days + 1} or more days before arrival`;
  if (days <= 1) return "on the day of arrival";
  return `${days - 1} or fewer days before arrival`;
}

export function draftSentence(
  d: Pick<ImportDraft, "condition" | "action" | "affected_room_type_ids" | "start_date" | "end_date">,
  opts: { symbol: string; roomTypes: readonly MayaRoomType[] },
): string {
  const percent = d.action.adjust_rate_percent;
  const value = percent ?? d.action.adjust_rate_dollars ?? 0;
  const verb = value < 0 ? "Lower" : "Raise";
  const amount = percent !== undefined ? `${num(Math.abs(value))}%` : money(Math.abs(value), opts.symbol);
  const parts: string[] = [];
  const c = d.condition;
  if (c.occupancy_operator && c.occupancy_threshold != null) {
    parts.push(`when sellable occupancy is ${c.occupancy_operator === "gt" ? "over" : "under"} ${num(Number(c.occupancy_threshold) * 100)}%`);
  }
  if (c.dta_operator && c.dta_threshold_days != null) parts.push(daysPhrase(c.dta_operator, Number(c.dta_threshold_days)));
  let sentence = `${verb} the price ${amount}${parts.length ? ` ${parts.join(", ")}` : ""}`;

  const rooms = opts.roomTypes.filter((r) => r.counts_as_room !== false).map((r) => r.id);
  const affected = d.affected_room_type_ids;
  const everyRoom = rooms.length > 0 && rooms.every((id) => affected.includes(id)) && affected.every((id) => rooms.includes(id));
  if (!everyRoom) {
    const names = opts.roomTypes.filter((r) => affected.includes(r.id)).map((r) => r.name);
    if (names.length) sentence += `, on ${names.join(", ")}`;
  }
  if (d.start_date && d.end_date) sentence += `, for nights ${shortDate(d.start_date)} to ${shortDate(d.end_date)}`;
  else if (d.start_date) sentence += `, for nights from ${shortDate(d.start_date)}`;
  else if (d.end_date) sentence += `, for nights until ${shortDate(d.end_date)}`;
  return `${sentence}.`;
}
