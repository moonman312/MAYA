/**
 * Several screenshots of the same PIE page, as one list: rules in the order
 * they first appear, each rule once (the same name, description, dates, mode
 * and type is the same rule), a row a screenshot cut off replaced by a whole
 * read of it from another, a row cut in two by one screenshot ending and the
 * next starting put back together, and the price limits read anywhere.
 */

import { parseDescription, type DescriptionRead } from "./description";
import type { LimitRowRead, LimitsRead } from "./layout";
import { rowKey, type PieRowRead, type ScreenshotRead } from "./read";
import { nameKey, parsePieDate } from "./text";

export type PieRule = PieRowRead & {
  /** Stable and unique within the import: the row's text, squashed. */
  key: string;
  /** Which screenshot it came from (0 is the first). */
  shot: number;
  parsed: DescriptionRead;
  /** Put together from the bottom of one screenshot and the top of the next. */
  joined?: boolean;
};

export type MergedRead = {
  rules: PieRule[];
  master: LimitsRead["master"];
  limits: LimitRowRead[];
  /** Screenshots with neither a rules table nor price limits in them. */
  unread: number[];
  /** Screenshots that show rules, none of which could be read. */
  rulesUnread: number[];
  /** How many rules PIE says it has ("Showing 1 to 9 of 9 entries"), when a screenshot showed it. */
  listed: number | null;
  /** How many of those weren't read. */
  missing: number;
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, "");
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9%.]+/).filter(Boolean);

/** Whether a cut-off read and a whole one are the same row: the same name, and nothing read differs. */
function sameRow(cut: PieRule, whole: PieRule): boolean {
  if (!cut.name || squash(cut.name) !== squash(whole.name)) return false;
  if (!cut.parsed.ok || !whole.parsed.ok) return true;
  const a = cut.parsed.rule;
  const b = whole.parsed.rule;
  return a.direction === b.direction && a.kind === b.kind && a.amount === b.amount && a.occupancyOp === b.occupancyOp && a.threshold === b.threshold;
}

/**
 * Whether a whole read holds what a cut piece shows: the same row by name,
 * or all of the piece's text, numbers and all, found in its description
 * (PIE's template words alone match every rule).
 */
function covers(whole: PieRule, piece: PieRule): boolean {
  if (sameRow(piece, whole)) return true;
  const t = tokens(piece.description);
  if (t.length < 3 || !t.some((x) => /\d/.test(x))) return false;
  const w = tokens(whole.description);
  for (let i = 0; i + t.length <= w.length; i++) if (t.every((x, k) => w[i + k] === x)) return true;
  return false;
}

/** Of two reads of a cell, one that reads as a date or "N/A" over one that doesn't. */
function readable(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return parsePieDate(a).kind === "unreadable" && parsePieDate(b).kind !== "unreadable" ? b : a;
}

/** The two halves of a row, one screenshot ending and the next starting through it, as one. */
function join(bottom: PieRule, top: PieRule): PieRule {
  const description = `${bottom.description} ${top.description}`.trim();
  const row: PieRowRead = {
    // A name on two lines can be cut between them.
    name: `${bottom.name} ${top.name}`.trim(),
    mode: bottom.mode ?? top.mode,
    type: bottom.type ?? top.type,
    typeText: bottom.typeText || top.typeText,
    description,
    active: bottom.active ?? top.active,
    startDate: readable(bottom.startDate, top.startDate),
    endDate: readable(bottom.endDate, top.endDate),
    cutOff: true,
    cutEdge: "bottom",
    numbersUnsure: bottom.numbersUnsure || top.numbersUnsure,
    y: bottom.y,
  };
  return { ...row, key: rowKey(row), shot: bottom.shot, parsed: parseDescription(description), joined: true };
}

function middle(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

/**
 * How far one screenshot is scrolled from the one before, when the two
 * overlap: a row read whole in both, at y in the first and y - offset in
 * the second. null when they share no whole row (or differ in width).
 */
function overlapOffset(a: ScreenshotRead | undefined, aRules: readonly PieRule[], b: ScreenshotRead, bRules: readonly PieRule[]): number | null {
  if (!a || a.width !== b.width) return null;
  const diffs = bRules.filter((r) => !r.cutOff).flatMap((r) => aRules.filter((x) => !x.cutOff && x.key === r.key).map((x) => x.y - r.y));
  return diffs.length > 0 ? middle(diffs) : null;
}

/** A row's spacing in a screenshot, for matching rows across two of them. */
function spacingOf(rules: readonly PieRule[]): number {
  const ys = rules.map((r) => r.y).sort((a, b) => a - b);
  const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 0);
  return gaps.length > 0 ? middle(gaps) : 80;
}

export function mergeReads(reads: readonly ScreenshotRead[]): MergedRead {
  const rules: PieRule[] = [];
  const unread: number[] = [];
  const rulesUnread: number[] = [];
  let master: MergedRead["master"] = null;
  let listed: number | null = null;
  const limits = new Map<string, LimitRowRead>();

  const byShot = reads.map((read, shot) => read.rows.map((row): PieRule => ({ ...row, key: rowKey(row), shot, parsed: parseDescription(row.description) })));
  // offsets[k]: screenshot k against k - 1.
  const offsets = reads.map((read, k) => (k === 0 ? null : overlapOffset(reads[k - 1], byShot[k - 1], read, byShot[k])));

  /** Whether a whole row of screenshot `k` sits at y (in that screenshot's pixels). */
  const wholeAt = (k: number, y: number) => {
    const rows = byShot[k] ?? [];
    const tol = spacingOf(rows) * 0.6;
    return rows.some((r) => !r.cutOff && Math.abs(r.y - y) < tol);
  };

  reads.forEach((read, shot) => {
    if (read.rows.length === 0 && read.limits.byType.length === 0 && !read.limits.master) unread.push(shot);
    else if (read.rows.length === 0 && read.rulesSeen) rulesUnread.push(shot);
    if (read.entries) listed = Math.max(listed ?? 0, read.entries.total);
    if (read.limits.master) {
      const m = read.limits.master;
      master = master ? { min: master.min ?? m.min, max: master.max ?? m.max, ...(master.unsure ? { unsure: true } : {}) } : m;
    }
    for (const row of read.limits.byType) if (!limits.has(nameKey(row.name))) limits.set(nameKey(row.name), row);

    const before = reads[shot - 1];
    const offset = offsets[shot];
    const offsetNext = offsets[shot + 1] ?? null;
    for (const [i, rule] of byShot[shot].entries()) {
      if (rule.cutOff) {
        // Overlapping screenshots: the other one shows this row whole.
        if (rule.cutEdge === "top" && offset !== null && wholeAt(shot - 1, rule.y + offset)) continue;
        if (rule.cutEdge === "bottom" && offsetNext !== null && wholeAt(shot + 1, rule.y - offsetNext)) continue;
        // One screenshot ending and the next starting through the same row: its two halves.
        const prev = rules[rules.length - 1];
        if (
          i === 0 &&
          rule.cutEdge === "top" &&
          offset === null &&
          before?.width === read.width &&
          prev?.shot === shot - 1 &&
          prev.cutEdge === "bottom" &&
          !prev.joined &&
          before.rows[before.rows.length - 1]?.y === prev.y
        ) {
          rules[rules.length - 1] = join(prev, rule);
          continue;
        }
        // Already have it whole, or cut the same way: nothing new.
        if (rules.some((r) => (r.cutOff ? r.key === rule.key && (r.name || r.description) : covers(r, rule)))) continue;
        rules.push(rule);
        continue;
      }
      // The same rule read again (its switch, when one read couldn't see it, from the other).
      const twin = rules.findIndex((r) => !r.cutOff && r.key === rule.key && (r.active === rule.active || r.active === null || rule.active === null));
      if (twin >= 0) {
        if (rules[twin].active === null) rules[twin] = { ...rules[twin], active: rule.active };
        continue;
      }
      // A whole read takes the place of the cut-off pieces of it.
      const pieces = rules.flatMap((r, k) => (r.cutOff && !r.joined && covers(rule, r) ? [k] : []));
      if (pieces.length > 0) {
        rules[pieces[0]] = rule;
        for (const k of pieces.slice(1).reverse()) rules.splice(k, 1);
      } else rules.push(rule);
    }
  });

  // Keys unique, for an exact copy of a rule PIE lists twice (one on, one off).
  const seen = new Map<string, number>();
  const unique = rules.map((r) => {
    const n = (seen.get(r.key) ?? 0) + 1;
    seen.set(r.key, n);
    return n === 1 ? r : { ...r, key: `${r.key}#${n}` };
  });
  const total = listed as number | null;
  return {
    rules: unique,
    master,
    limits: [...limits.values()],
    unread,
    rulesUnread,
    listed: total,
    missing: total !== null ? Math.max(0, total - unique.length) : 0,
  };
}
