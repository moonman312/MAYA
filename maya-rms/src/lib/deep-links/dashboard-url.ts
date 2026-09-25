/**
 * The dashboard's address: which tab, and which place inside it, as plain
 * query keys, so back and forward work and a link can open any of them.
 *
 *   tab     calendar | rules | simulator | changelog | pms   (omitted: calendar)
 *   panel   builder (rules) | test-rule (simulator) | corrections (changelog)
 *   month   YYYY-MM on the calendar                        (omitted: this UTC month)
 *   date    YYYY-MM-DD, that night's card open; implies its month
 *   filter  enabled | disabled on the rules list          (omitted: all)
 *   view    all on the change log                         (omitted: changes only)
 *
 * Each tab writes only its own keys. Everything is checked with the same
 * registry values a link is, and anything else is ignored.
 */

import { links } from "./index";
import { realDate } from "./core.mjs";

export type Tab = "calendar" | "rules" | "simulator" | "changelog" | "pms";
export type Panel = "builder" | "test-rule" | "corrections";
export type RuleFilter = "all" | "enabled" | "disabled";
export type LogView = "changes" | "all";

export type Place = {
  tab: Tab;
  panel: Panel | null;
  year: number;
  month: number;
  day: number | null;
  filter: RuleFilter;
  view: LogView;
};

const PANEL_TAB: Record<Panel, Tab> = { builder: "rules", "test-rule": "simulator", corrections: "changelog" };

function thisMonth(now: Date) {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

export function readPlace(search: string, now: Date = new Date()): Place {
  const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const get = (k: string) => {
    const v = sp.get(k);
    return v === null ? null : links.checkValue(k, v);
  };
  const tab = (get("tab") as Tab | null) ?? "calendar";
  const panelRaw = get("panel") as Panel | null;
  const panel = panelRaw && PANEL_TAB[panelRaw] === tab ? panelRaw : null;

  let { year, month } = thisMonth(now);
  let day: number | null = null;
  if (tab === "calendar") {
    const date = get("date");
    const monthKey = get("month");
    if (date && realDate(date) !== null) {
      year = Number(date.slice(0, 4));
      month = Number(date.slice(5, 7));
      day = Number(date.slice(8, 10));
    } else if (monthKey) {
      year = Number(monthKey.slice(0, 4));
      month = Number(monthKey.slice(5, 7));
    }
  }
  const filter = tab === "rules" ? ((get("filter") as RuleFilter | null) ?? "all") : "all";
  const view = tab === "changelog" ? ((get("view") as LogView | null) ?? "changes") : "changes";
  return { tab, panel, year, month, day, filter, view };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The query for a place, without "?"; defaults are left out. */
export function writePlace(place: Place, now: Date = new Date()): string {
  const sp = new URLSearchParams();
  if (place.tab !== "calendar") sp.set("tab", place.tab);
  if (place.panel && PANEL_TAB[place.panel] === place.tab) sp.set("panel", place.panel);
  if (place.tab === "calendar") {
    const current = thisMonth(now);
    if (place.day !== null) sp.set("date", `${place.year}-${pad(place.month)}-${pad(place.day)}`);
    else if (place.year !== current.year || place.month !== current.month) sp.set("month", `${place.year}-${pad(place.month)}`);
  }
  if (place.tab === "rules" && place.filter !== "all") sp.set("filter", place.filter);
  if (place.tab === "changelog" && place.view !== "changes") sp.set("view", place.view);
  return sp.toString();
}
