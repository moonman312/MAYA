"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { readPlace, writePlace, type LogView, type Panel, type Place, type RuleFilter, type Tab } from "@/lib/deep-links/dashboard-url";

// The dashboard's tab and the place inside it live in the address (see
// dashboard-url.ts). A new screen (a tab, a night's card) is a new history
// entry, so back returns to it; a change within the screen (the month, a
// filter, opening the builder) replaces the entry. Next folds pushState and
// replaceState into its router, so nothing reloads.

const EVENT = "maya:dashboard-url";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** Rewrites the address. `query` has no "?". */
export function setDashboardQuery(query: string, mode: "push" | "replace") {
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(EVENT));
}

const current = () => readPlace(window.location.search);

function go(next: Place, mode: "push" | "replace") {
  const query = writePlace(next);
  if (query === writePlace(current())) return;
  setDashboardQuery(query, mode);
}

type Updater<T> = T | ((prev: T) => T);
const apply = <T,>(u: Updater<T>, prev: T): T => (typeof u === "function" ? (u as (p: T) => T)(prev) : u);

/**
 * The same names and shapes the dashboard's own state had, backed by the
 * address. `initialSearch` is the query the server rendered with, so the
 * first paint already shows the linked tab.
 */
export function useDashboardUrl(initialSearch: string) {
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => initialSearch,
  );
  const place = useMemo(() => readPlace(search), [search]);

  // How each tab was left in this visit, so coming back to it restores it.
  const memory = useRef({ year: place.year, month: place.month, filter: place.filter, view: place.view });
  useEffect(() => {
    if (place.tab === "calendar") memory.current = { ...memory.current, year: place.year, month: place.month };
    if (place.tab === "rules") memory.current = { ...memory.current, filter: place.filter };
    if (place.tab === "changelog") memory.current = { ...memory.current, view: place.view };
  }, [place]);

  const setTab = useCallback((tab: Tab) => {
    const cur = current();
    if (cur.tab === tab) return;
    const m = memory.current;
    go({ tab, panel: null, year: m.year, month: m.month, day: null, filter: m.filter, view: m.view }, "push");
  }, []);

  const setYear = useCallback((u: Updater<number>) => {
    const cur = current();
    go({ ...cur, year: apply(u, cur.year), day: null }, "replace");
  }, []);

  const setMonth = useCallback((u: Updater<number>) => {
    const cur = current();
    go({ ...cur, month: apply(u, cur.month), day: null }, "replace");
  }, []);

  const setSelectedDay = useCallback((u: Updater<number | null>) => {
    const cur = current();
    const day = apply(u, cur.day);
    go({ ...cur, day }, day === null ? "replace" : "push");
  }, []);

  const setRuleFilter = useCallback((filter: RuleFilter) => {
    go({ ...current(), filter }, "replace");
  }, []);

  const setPanel = useCallback((panel: Panel | null) => {
    go({ ...current(), panel }, "replace");
  }, []);

  const setRuleFormOpen = useCallback((u: Updater<boolean>) => {
    const cur = current();
    go({ ...cur, panel: apply(u, cur.panel === "builder") ? "builder" : null }, "replace");
  }, []);

  const setChangesOnly = useCallback((u: Updater<boolean>) => {
    const cur = current();
    const view: LogView = apply(u, cur.view === "changes") ? "changes" : "all";
    go({ ...cur, view }, "replace");
  }, []);

  return {
    tab: place.tab,
    year: place.year,
    month: place.month,
    selectedDay: place.day,
    ruleFilter: place.filter,
    ruleFormOpen: place.panel === "builder",
    changesOnly: place.view === "changes",
    panel: place.panel,
    setTab,
    setYear,
    setMonth,
    setSelectedDay,
    setRuleFilter,
    setRuleFormOpen,
    setChangesOnly,
    setPanel,
  };
}
