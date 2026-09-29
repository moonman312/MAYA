import type { ChangelogItem, ChangelogSupportChange } from "@/types/domain";

/**
 * Changes MAYA support made to a property in God Mode, as the change log
 * shows them: one line per row changed, read from support_changes (which
 * the database's trigger and the app's service-role paths both write).
 */

export function isSupportChange(item: ChangelogItem): item is ChangelogSupportChange {
  return "kind" in item && item.kind === "support_change";
}

/** What the line says before the change itself. */
export const SUPPORT_CHANGE_LEAD = "Changed by MAYA support";

/** Support changes shown at most, newest first. */
export const MAX_SUPPORT_CHANGES = 20;

export type SupportChangeRow = {
  id: string | number;
  at: string;
  summary: string | null;
  table_name: string;
  op: string | null;
};

/**
 * One item per row, newest first. A row with no summary (an older or
 * hand-written record) still gets a line naming what kind of thing changed.
 */
export function buildSupportChanges(rows: SupportChangeRow[]): ChangelogSupportChange[] {
  return rows
    .map((r) => ({
      kind: "support_change" as const,
      id: String(r.id),
      timestamp: String(r.at),
      summary: r.summary?.trim() || fallbackSummary(r),
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .slice(0, MAX_SUPPORT_CHANGES);
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
