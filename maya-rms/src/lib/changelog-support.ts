import type { ChangelogItem, ChangelogSupportChange } from "@/types/domain";

/**
 * Changes MAYA support made to a property in God Mode, as the change log
 * shows them: one line per save, read from support_changes (which the
 * database's trigger and the app's service-role paths both write).
 *
 * The trigger writes one row per table row a save touched, so one rule save
 * can leave dozens: the rule, its conditions and room types, and a held day
 * or ladder step for each night and room type. Rows written together share
 * `at` (the transaction's start time) and the person, and become one line:
 * the rule's own line where there is one, with ", N days" when the save
 * covered nights. That keeps the rule's line from being pushed off the list
 * by its own nights.
 */

export function isSupportChange(item: ChangelogItem): item is ChangelogSupportChange {
  return "kind" in item && item.kind === "support_change";
}

/** What the line says before the change itself. */
export const SUPPORT_CHANGE_LEAD = "Changed by MAYA support";

/** Support changes (saves) shown at most, newest first. */
export const MAX_SUPPORT_CHANGES = 20;

/**
 * Rows read at most. PostgREST answers 1,000 rows at most, so this is also
 * the most a read can see; when a read comes back full, the oldest save in
 * it may be missing rows and is left out.
 */
export const MAX_SUPPORT_CHANGE_ROWS = 1000;

/** What loadSupportChanges reads: the row, and the night it is about, if any. */
export const SUPPORT_CHANGE_COLUMNS =
  "id, at, summary, table_name, op, user_id, after_day:after->>stay_date, before_day:before->>stay_date";

export type SupportChangeRow = {
  id: string | number;
  at: string;
  summary: string | null;
  table_name: string;
  op: string | null;
  user_id?: string | null;
  /** stay_date of a per-night row (held days, ladder steps, base rates), after the change. */
  after_day?: string | null;
  /** The same, before the change (a removed row has only this). */
  before_day?: string | null;
};

/**
 * One item per save, newest first. A save of one row reads exactly as its
 * summary; a row with no summary (an older or hand-written record) still
 * gets a line naming what kind of thing changed.
 */
export function buildSupportChanges(
  rows: SupportChangeRow[],
  opts: { truncated?: boolean } = {},
): ChangelogSupportChange[] {
  const saves = new Map<string, SupportChangeRow[]>();
  for (const r of rows) {
    const key = `${String(r.at)}|${r.user_id ?? ""}`;
    const save = saves.get(key);
    if (save) save.push(r);
    else saves.set(key, [r]);
  }

  const items = [...saves.values()]
    .map((save) => {
      const sorted = [...save].sort(byId);
      const head = headline(sorted);
      return {
        kind: "support_change" as const,
        id: String(head.id),
        timestamp: String(head.at),
        summary: saveLine(sorted, head),
      };
    })
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  // A full read may have cut the oldest save short; better left out than
  // shown with the wrong line or too few days.
  if (opts.truncated && items.length > 1) items.pop();
  return items.slice(0, MAX_SUPPORT_CHANGES);
}

function byId(a: SupportChangeRow, b: SupportChangeRow): number {
  const x = Number(a.id);
  const y = Number(b.id);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

function dayOf(r: SupportChangeRow): string | null {
  return r.after_day || r.before_day || null;
}

/**
 * The row that names the save: the rule's own, else the first one that is
 * not about a single night, else the first.
 */
function headline(sorted: SupportChangeRow[]): SupportChangeRow {
  return sorted.find((r) => r.table_name === "pricing_rules") ?? sorted.find((r) => !dayOf(r)) ?? sorted[0];
}

function saveLine(sorted: SupportChangeRow[], head: SupportChangeRow): string {
  if (sorted.length === 1) return summaryOf(head);
  const days = new Set(sorted.map(dayOf).filter((d): d is string => d != null)).size;

  let what = summaryOf(head);
  if (dayOf(head)) {
    // Nothing but nights: their shared line when they all say the same,
    // otherwise what kind of thing changed, without one night's values.
    const lines = new Set(sorted.map(summaryOf));
    if (lines.size > 1) what = leadOf(what);
  }
  if (days === 0) return what;
  return `${withoutPeriod(what)}, ${days} ${days === 1 ? "day" : "days"}.`;
}

function summaryOf(r: SupportChangeRow): string {
  return r.summary?.trim() || fallbackSummary(r);
}

function withoutPeriod(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

/** "Changed a base rate: rate from 150 to 180." → "Changed a base rate". A quoted name keeps its colons. */
function leadOf(s: string): string {
  let quoted = false;
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === '"') quoted = !quoted;
    else if (!quoted && s[i] === ":" && s[i + 1] === " ") return s.slice(0, i);
  }
  return withoutPeriod(s);
}

function fallbackSummary(r: SupportChangeRow): string {
  const what = r.table_name.replace(/_/g, " ");
  switch (r.op) {
    case "insert":
      return `Added a ${what} row.`;
    case "delete":
      return `Removed a ${what} row.`;
    default:
      return `Changed a ${what} row.`;
  }
}
