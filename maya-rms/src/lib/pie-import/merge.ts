/**
 * Several screenshots of the same PIE page, as one list: rules in the order
 * they first appear, each rule once (the same name and description is the
 * same rule), a row a screenshot cut off replaced by a whole read of it from
 * another, and the price limits read anywhere.
 */

import { parseDescription, type DescriptionRead } from "./description";
import type { LimitRowRead } from "./layout";
import { rowKey, type PieRowRead, type ScreenshotRead } from "./read";
import { nameKey } from "./text";

export type PieRule = PieRowRead & {
  /** Stable within the import: the row's text, squashed. */
  key: string;
  /** Which screenshot it came from (0 is the first). */
  shot: number;
  parsed: DescriptionRead;
};

export type MergedRead = {
  rules: PieRule[];
  master: { min: number | null; max: number | null } | null;
  limits: LimitRowRead[];
  /** Screenshots with neither a rules table nor price limits in them. */
  unread: number[];
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, "");

/** Whether a cut-off read and a whole one are the same row: the same name, and nothing read differs. */
function sameRow(cut: PieRule, whole: PieRule): boolean {
  if (squash(cut.name) !== squash(whole.name)) return false;
  if (!cut.parsed.ok || !whole.parsed.ok) return true;
  const a = cut.parsed.rule;
  const b = whole.parsed.rule;
  return a.direction === b.direction && a.kind === b.kind && a.amount === b.amount && a.occupancyOp === b.occupancyOp && a.threshold === b.threshold;
}

export function mergeReads(reads: readonly ScreenshotRead[]): MergedRead {
  const rules: PieRule[] = [];
  const unread: number[] = [];
  let master: MergedRead["master"] = null;
  const limits = new Map<string, LimitRowRead>();

  reads.forEach((read, shot) => {
    if (read.rows.length === 0 && read.limits.byType.length === 0 && !read.limits.master) unread.push(shot);
    if (read.limits.master) {
      master = {
        min: master?.min ?? read.limits.master.min,
        max: master?.max ?? read.limits.master.max,
      };
    }
    for (const row of read.limits.byType) if (!limits.has(nameKey(row.name))) limits.set(nameKey(row.name), row);

    for (const row of read.rows) {
      const rule: PieRule = { ...row, key: rowKey(row), shot, parsed: parseDescription(row.description) };
      if (rule.cutOff) {
        // Already have it whole, or cut the same way: nothing new.
        if (rules.some((r) => sameRow(rule, r))) continue;
        rules.push(rule);
        continue;
      }
      if (rules.some((r) => !r.cutOff && r.key === rule.key)) continue;
      // A whole read takes the place of a cut-off one of the same row.
      const cutAt = rules.findIndex((r) => r.cutOff && sameRow(r, rule));
      if (cutAt >= 0) rules[cutAt] = rule;
      else rules.push(rule);
    }
  });

  return { rules, master, limits: [...limits.values()], unread };
}
