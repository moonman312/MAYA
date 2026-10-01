/**
 * Where things are on a screenshot of PIE's "Rules and Alerts" page, from
 * the words OCR found and their boxes: the rules table's columns (from its
 * headers ACTIVE, NAME, MODE, TYPE, DESCRIPTION, START DATE, END DATE), its
 * rows (from each row's MODE and TYPE words and its description), PIE's own
 * count of them ("Showing 1 to 9 of 9 entries"), the "Minimum Price /
 * Maximum Price" pair and the "PRICE LIMITS BY ACCOMMODATION TYPE" table.
 *
 * Everything is in the screenshot's own pixels. Pure: no OCR, no pixels.
 */

import { fixTemplateWords, looksLikeMoney, near, parseMoney, tidy } from "./text";

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type OcrWord = Box & { text: string; confidence?: number };

/** Each header's left edge. */
export type RulesColumns = {
  active: number | null;
  name: number;
  mode: number;
  type: number;
  description: number;
  start: number | null;
  end: number | null;
  /**
   * The header row's bottom edge. null for columns carried over from an
   * earlier screenshot of the same page whose header was in view (the page
   * scrolled down, so the columns sit where they were).
   */
  headerBottom: number | null;
  /** The screenshot's width, so columns are only carried to one the same size. */
  imageWidth: number;
};

export type RowBand = {
  /** The row's middle: from its MODE and TYPE words, or its text when they weren't read. */
  center: number;
  top: number;
  bottom: number;
  /** The row runs past the screenshot's bottom (or top) edge. */
  cutBottom: boolean;
  cutTop: boolean;
  /** Found from its MODE or TYPE words; false for a row found from its description or name alone. */
  anchored: boolean;
};

const yMid = (b: Box) => (b.y0 + b.y1) / 2;
const xMid = (b: Box) => (b.x0 + b.x1) / 2;
const height = (b: Box) => Math.max(1, b.y1 - b.y0);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Letters only, upper case: how a header word is compared. */
const letters = (s: string) => s.replace(/[^A-Za-z]/g, "").toUpperCase();

/**
 * Words grouped into lines (by their vertical middles), each line left to
 * right, lines top to bottom.
 */
export function wordLines(words: readonly OcrWord[]): OcrWord[][] {
  const sorted = [...words].filter((w) => w.text.trim() !== "").sort((a, b) => yMid(a) - yMid(b));
  const tol = Math.max(3, median(sorted.map(height)) * 0.55);
  const out: { y: number; words: OcrWord[] }[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(yMid(w) - last.y) <= tol) {
      last.words.push(w);
      last.y = last.words.reduce((n, x) => n + yMid(x), 0) / last.words.length;
    } else {
      out.push({ y: yMid(w), words: [w] });
    }
  }
  return out.map((l) => l.words.sort((a, b) => a.x0 - b.x0));
}

/** The words of a line or cell as text. */
export function textOf(words: readonly OcrWord[]): string {
  return tidy(wordLines(words).map((l) => l.map((w) => w.text).join(" ")).join(" "));
}

/**
 * The rules table's columns, from its header row, or null when no header
 * row is in view. DESCRIPTION anchors the row (it appears once on the page,
 * in capitals); NAME, MODE, TYPE and DESCRIPTION must all be found.
 */
export function findRulesColumns(words: readonly OcrWord[], imageWidth: number): RulesColumns | null {
  const desc = words.find((w) => near(letters(w.text), "DESCRIPTION") && w.text.replace(/[^A-Za-z]/g, "") === letters(w.text));
  if (!desc) return null;
  const tol = height(desc) * 0.7;
  const line = words.filter((w) => Math.abs(yMid(w) - yMid(desc)) <= tol);
  const find = (label: string, after = -Infinity) =>
    line.filter((w) => w.x0 > after && near(letters(w.text), label)).sort((a, b) => a.x0 - b.x0)[0] ?? null;
  const name = find("NAME");
  const mode = find("MODE");
  const type = find("TYPE");
  if (!name || !mode || !type || !(name.x0 < mode.x0 && mode.x0 < type.x0 && type.x0 < desc.x0)) return null;
  const active = find("ACTIVE");
  const start = find("START", desc.x0);
  const end = find("END", start ? start.x0 : desc.x0);
  return {
    active: active && active.x0 < name.x0 ? active.x0 : null,
    name: name.x0,
    mode: mode.x0,
    type: type.x0,
    description: desc.x0,
    start: start?.x0 ?? null,
    end: end?.x0 ?? null,
    headerBottom: Math.max(...line.map((w) => w.y1)),
    imageWidth,
  };
}

/** The x range a column's cells take, from its header to the next one (8 px of slack each side). */
export function columnRange(cols: RulesColumns, column: "name" | "mode" | "type" | "description" | "start" | "end"): [number, number] {
  const pad = 8;
  switch (column) {
    case "name":
      return [cols.name - pad, cols.mode - pad];
    case "mode":
      return [cols.mode - pad, cols.type - pad];
    case "type":
      return [cols.type - pad, cols.description - pad];
    case "description":
      return [cols.description - pad, (cols.start ?? cols.end ?? cols.imageWidth + pad) - pad];
    case "start":
      return cols.start === null ? [Infinity, Infinity] : [cols.start - pad, (cols.end ?? cols.imageWidth + pad) - pad];
    case "end": {
      if (cols.end === null) return [Infinity, Infinity];
      const width = cols.start !== null ? cols.end - cols.start : 180;
      return [cols.end - pad, cols.end + width - pad];
    }
  }
}

const MODE_WORD = /^(au[t1]o|manua[l1i|]?)$/i;
const TYPE_WORD = /^(occupanc|restriction|compset|comp-?set|competitor|pickup|event|availability|length)/i;

/** Whether a line of a description is the start of one: "Raise rate by", "Lower rate by" (a letter off allowed). */
export function isDescriptionHead(text: string): boolean {
  return /^(?:raise|lower|increase|decrease)\s+(?:the\s+)?rates?\s+b[yv]\b/i.test(fixTemplateWords(tidy(text)).replace(/^[^A-Za-z]+/, ""));
}

/** Text under the table, never a row: "Showing 1 to 9 of 9 entries", "Previous 1 Next". */
const FOOTER = /^(showing\b|previous\b|next\b)|\bentries\b/i;

/** What the rows are found from: the whole page, and the columns read on their own. */
export type RowSources = {
  /** The whole page's read. */
  full: readonly OcrWord[];
  /** NAME to TYPE, cropped and read on its own. */
  left?: readonly OcrWord[];
  /** DESCRIPTION, cropped and read on its own. */
  desc?: readonly OcrWord[];
};

/** Lines close together, as blocks; a line that starts a description always starts a block. */
type Block = { top: number; bottom: number; head: boolean; text: string };

function blocksOf(words: readonly OcrWord[], heads: boolean): Block[] {
  const lines = wordLines(words);
  if (lines.length === 0) return [];
  const lineH = median(lines.map((l) => Math.max(...l.map((w) => w.y1)) - Math.min(...l.map((w) => w.y0))));
  // Lines of one cell sit about a line apart; rows, two or more.
  const gap = lineH * 1.8;
  const out: Block[] = [];
  for (const line of lines) {
    const top = Math.min(...line.map((w) => w.y0));
    const bottom = Math.max(...line.map((w) => w.y1));
    const text = line.map((w) => w.text).join(" ");
    const head = heads && isDescriptionHead(text);
    const last = out[out.length - 1];
    if (last && !head && top - last.bottom <= gap) {
      last.bottom = Math.max(last.bottom, bottom);
      last.text += ` ${text}`;
      continue;
    }
    out.push({ top, bottom, head, text });
  }
  return out;
}

type Row = { center: number; top: number; bottom: number; anchored: boolean; head: boolean; hasName: boolean };

/**
 * The table's rows. Each row's middle comes from its MODE and TYPE words
 * ("Auto", "Manual", "Occupancy", ...), in the whole page's read and in the
 * NAME to TYPE crop's. A description that starts with "Raise/Lower rate by"
 * and sits on no such row is a row of its own (its MODE and TYPE weren't
 * read), so two rules never share a row. So is a name or description that
 * sits at the screenshot's edge, outside every row: a row cut off there,
 * shown rather than dropped. Each row's band runs from halfway to the row
 * above to halfway to the row below (the gap between their text, when it
 * was read). A last row that runs past the bottom edge is cut off, and a
 * first row past the top when no header is in view.
 */
export function findRowBands(sources: RowSources, cols: RulesColumns, imageHeight: number): RowBand[] {
  const top = cols.headerBottom ?? -Infinity;
  const [m0, m1] = columnRange(cols, "mode");
  const [t0, t1] = columnRange(cols, "type");
  const [n0, n1] = columnRange(cols, "name");
  const below = (w: OcrWord) => w.y0 > top;
  const inCol = (w: OcrWord, a: number, b: number) => xMid(w) >= a && xMid(w) < b && below(w);
  const isAnchor = (w: OcrWord) =>
    (inCol(w, m0, m1) && MODE_WORD.test(w.text.replace(/[^A-Za-z0-9|]/g, ""))) ||
    (inCol(w, t0, t1) && TYPE_WORD.test(w.text.replace(/[^A-Za-z-]/g, "")));
  const anchors = [...sources.full, ...(sources.left ?? [])].filter(isAnchor);
  const descBlocks = blocksOf((sources.desc ?? []).filter(below), true).filter((b) => !FOOTER.test(b.text));
  const nameBlocks = blocksOf((sources.left ?? []).filter((w) => inCol(w, n0, n1)), false).filter((b) => !FOOTER.test(b.text));

  const lineH = median([...anchors.map(height), ...(sources.desc ?? []).map(height)].filter((h) => h > 1)) || 14;
  const rows: Row[] = [];
  for (const y of anchors.map(yMid).sort((a, b) => a - b)) {
    const last = rows[rows.length - 1];
    if (last && y - last.center <= lineH * 1.2) {
      last.center = (last.center + y) / 2;
      continue;
    }
    rows.push({ center: y, top: y - lineH / 2, bottom: y + lineH / 2, anchored: true, head: false, hasName: false });
  }
  const anchored = rows.filter((r) => r.anchored);
  const gaps = anchored.slice(1).map((r, i) => r.center - anchored[i].center);
  let spacing = gaps.length > 0 ? median(gaps) : 0;

  // Descriptions: on their row, or a row of their own.
  const orphans: Block[] = [];
  for (const block of descBlocks) {
    const on = anchored.filter((r) => r.center >= block.top - lineH && r.center <= block.bottom + lineH);
    const row = on.length === 1 ? on[0] : null;
    if (row && !(block.head && row.head)) {
      row.top = Math.min(row.top, block.top);
      row.bottom = Math.max(row.bottom, block.bottom);
      row.head ||= block.head;
    } else if (on.length === 0 || (block.head && row?.head)) {
      orphans.push(block);
    }
  }
  if (spacing === 0) {
    const all = [...anchored.map((r) => r.center), ...orphans.filter((b) => b.head).map((b) => (b.top + b.bottom) / 2)].sort((a, b) => a - b);
    const g = all.slice(1).map((c, i) => c - all[i]);
    spacing = g.length > 0 ? median(g) : cols.headerBottom !== null && all.length > 0 ? 2 * (all[0] - cols.headerBottom) : lineH * 5.5;
  }
  const nearTop = (b: { top: number }) => cols.headerBottom === null && b.top < spacing * 0.5;
  const nearBottom = (b: { bottom: number }) => b.bottom > imageHeight - spacing * 0.5;
  for (const block of orphans) {
    // A description no MODE or TYPE was read beside: a row when it starts one, or when the edge cut it.
    if (!block.head && !nearTop(block) && !nearBottom(block)) continue;
    rows.push({ center: (block.top + block.bottom) / 2, top: block.top, bottom: block.bottom, anchored: false, head: block.head, hasName: false });
  }
  // Names: on a row, or (at an edge) a row cut off there.
  for (const block of nameBlocks) {
    const row = rows.find((r) => block.bottom >= r.top - lineH && block.top <= r.bottom + lineH);
    if (row) {
      row.hasName = true;
      if (!row.anchored) {
        row.top = Math.min(row.top, block.top);
        row.bottom = Math.max(row.bottom, block.bottom);
      }
    } else if (nearTop(block) || nearBottom(block)) {
      rows.push({ center: (block.top + block.bottom) / 2, top: block.top, bottom: block.bottom, anchored: false, head: false, hasName: true });
    }
  }
  if (rows.length === 0) return [];
  rows.sort((a, b) => a.center - b.center);

  return rows.map((row, i) => {
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const between = (a: Row, b: Row) => Math.min(Math.max((Math.max(a.bottom, a.center) + Math.min(b.top, b.center)) / 2, a.center + 1), b.center - 1);
    const bandTop = prev ? between(prev, row) : cols.headerBottom ?? Math.min(row.top, row.center - spacing / 2);
    const bandBottom = next ? between(row, next) : Math.max(row.bottom + 1, row.center + spacing / 2);
    const first = !prev;
    const last = !next;
    return {
      center: row.center,
      top: bandTop,
      bottom: bandBottom,
      cutBottom: last && (row.anchored ? row.center + spacing * 0.45 > imageHeight : nearBottom(row)),
      cutTop: first && cols.headerBottom === null && (row.anchored ? row.center - spacing * 0.45 < 0 : nearTop(row)),
      anchored: row.anchored,
    };
  });
}

/** The words in a band and an x range (by their middles). */
export function wordsIn(words: readonly OcrWord[], band: Pick<RowBand, "top" | "bottom">, x0 = -Infinity, x1 = Infinity): OcrWord[] {
  return words.filter((w) => yMid(w) >= band.top && yMid(w) < band.bottom && xMid(w) >= x0 && xMid(w) < x1);
}

/* ── PIE's count, and what is on the page ──────────────────────── */

/** PIE's "Showing 1 to 9 of 9 entries", when in view. */
export function readEntries(words: readonly OcrWord[]): { from: number; to: number; total: number } | null {
  for (const line of wordLines(words)) {
    const m = textOf(line).match(/showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+entr/i);
    if (m) return { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) };
  }
  return null;
}

/**
 * Whether rules are on the page at all, read or not: a rule's "rate by", or
 * the DESCRIPTION header with text under it.
 */
export function seesRules(words: readonly OcrWord[]): boolean {
  if (wordLines(words).some((l) => /\brate\s+b[yv]\b/i.test(fixTemplateWords(textOf(l))))) return true;
  const desc = words.find((w) => near(letters(w.text), "DESCRIPTION") && /^[A-Z]+$/.test(w.text.replace(/[^A-Za-z]/g, "")));
  return !!desc && words.some((w) => w !== desc && w.y0 > desc.y1 + 2 && Math.abs(w.x0 - desc.x0) < height(desc) * 4);
}

/* ── Price limits ─────────────────────────────────────────────── */

export type LimitRowRead = {
  name: string;
  min: number | null;
  max: number | null;
  /** A number here may be misread: low OCR confidence, a missing currency sign, or two reads that differ. */
  unsure?: boolean;
};

export type LimitsRead = {
  /** The page's "Minimum Price" and "Maximum Price", when in view. */
  master: { min: number | null; max: number | null; unsure?: boolean } | null;
  /** PRICE LIMITS BY ACCOMMODATION TYPE, in order. */
  byType: LimitRowRead[];
};

/**
 * OCR confidence (0 to 100) under which an amount is taken as maybe
 * misread: retina captures read 92 to 96, misread ones 70 to 88.
 */
const SURE = 90;

const hasSign = (text: string) => /[$€£¥]|USD|EUR|GBP|CAD|AUD|MXN/i.test(text);

type Money = { value: number | null; text: string; confidence: number };

function moneyOf(words: readonly OcrWord[]): Money {
  const text = words.map((w) => w.text).join("");
  return { value: words.length ? parseMoney(text) : null, text, confidence: Math.min(100, ...words.map((w) => w.confidence ?? 100)) };
}

/** The money word nearest below a label, in the label's column (a lone sign and the amount beside it together). */
function moneyBelow(words: readonly OcrWord[], label: OcrWord): Money | null {
  const under = words.filter((w) => w.y0 > label.y1 - 2 && w.y0 < label.y1 + height(label) * 4 && Math.abs(w.x0 - label.x0) < height(label) * 3);
  for (const line of wordLines(under)) {
    for (const [i, w] of line.entries()) {
      const lone = /^[$€£¥]$/.test(w.text.trim());
      if (!lone && !looksLikeMoney(w.text)) continue;
      const m = moneyOf(lone && line[i + 1] ? [w, line[i + 1]] : [w]);
      if (m.value !== null) return m;
    }
  }
  return null;
}

/**
 * Whether money read from a table or pair is unsure: read with low
 * confidence, or without the currency sign the others have (OCR reads a
 * "$" as a "3" or "5": "$540.00" as "3540.00").
 */
function unsureMoney(m: Money | null, others: readonly (Money | null)[]): boolean {
  if (!m || m.value === null) return false;
  if (m.confidence < SURE) return true;
  const signed = others.filter((o) => o && o.value !== null && hasSign(o.text)).length;
  const counted = others.filter((o) => o && o.value !== null).length;
  return !hasSign(m.text) && signed > counted / 2;
}

/**
 * The master minimum and maximum, and the per room type limits table.
 * A row of that table is a name on the left with its MIN and MAX under
 * those headers; reading stops at the first line that is not one (the
 * rules section below it). A number that may be misread is marked unsure.
 */
export function readLimits(words: readonly OcrWord[]): LimitsRead {
  const lines = wordLines(words);
  let master: LimitsRead["master"] = null;
  for (const line of lines) {
    const min = line.findIndex((w, i) => /^minimum$/i.test(letters(w.text)) && /^price/i.test(line[i + 1]?.text ?? ""));
    const max = line.findIndex((w, i) => /^maximum$/i.test(letters(w.text)) && /^price/i.test(line[i + 1]?.text ?? ""));
    if (min < 0 && max < 0) continue;
    const lo = min >= 0 ? moneyBelow(words, line[min]) : null;
    const hi = max >= 0 ? moneyBelow(words, line[max]) : null;
    if (lo?.value == null && hi?.value == null) break;
    master = {
      min: lo?.value ?? null,
      max: hi?.value ?? null,
      ...(unsureMoney(lo, [lo, hi]) || unsureMoney(hi, [lo, hi]) ? { unsure: true } : {}),
    };
    break;
  }

  const byType: LimitRowRead[] = [];
  const header = lines.findIndex(
    (l) => l.some((w) => letters(w.text) === "MIN") && l.some((w) => letters(w.text) === "MAX") && l.some((w) => near(letters(w.text), "ACCOMMODATION")),
  );
  if (header >= 0) {
    const minX = lines[header].find((w) => letters(w.text) === "MIN")!.x0;
    const maxX = lines[header].find((w) => letters(w.text) === "MAX")!.x0;
    const pad = 24;
    const read: { name: string; min: Money | null; max: Money | null }[] = [];
    for (const line of lines.slice(header + 1)) {
      const nameWords = line.filter((w) => w.x1 < minX - pad / 2);
      const minWords = line.filter((w) => w.x0 >= minX - pad && w.x0 < maxX - pad);
      const maxWords = line.filter((w) => w.x0 >= maxX - pad);
      const min = minWords.length ? moneyOf(minWords) : null;
      const max = maxWords.length ? moneyOf(maxWords) : null;
      const name = tidy(nameWords.map((w) => w.text).join(" "));
      if (!name || (min?.value == null && max?.value == null)) break;
      read.push({ name, min, max });
    }
    const all = read.flatMap((r) => [r.min, r.max]);
    for (const r of read) {
      const unsure = unsureMoney(r.min, all) || unsureMoney(r.max, all);
      byType.push({ name: r.name, min: r.min?.value ?? null, max: r.max?.value ?? null, ...(unsure ? { unsure: true } : {}) });
    }
  }
  return { master, byType };
}

/**
 * Where to read the limits again, closer: the Minimum and Maximum Price
 * with the amounts under them, and the limits table from its header down to
 * the rules section (or the screenshot's bottom).
 */
export function limitsRegions(words: readonly OcrWord[], imageWidth: number, imageHeight: number): { master: Box | null; table: Box | null } {
  const lines = wordLines(words);
  let master: Box | null = null;
  const label = lines.find((l) => l.some((w, i) => /^(minimum|maximum)$/i.test(letters(w.text)) && /^price/i.test(l[i + 1]?.text ?? "")));
  if (label) {
    const y0 = Math.min(...label.map((w) => w.y0));
    const y1 = Math.max(...label.map((w) => w.y1));
    const h = y1 - y0;
    master = { x0: 0, x1: imageWidth, y0: Math.max(0, Math.floor(y0 - h)), y1: Math.min(imageHeight, Math.ceil(y1 + h * 4)) };
  }
  let table: Box | null = null;
  const header = lines.find((l) => l.some((w) => letters(w.text) === "MIN") && l.some((w) => letters(w.text) === "MAX") && l.some((w) => near(letters(w.text), "ACCOMMODATION")));
  if (header) {
    const y0 = Math.min(...header.map((w) => w.y0));
    const y1 = Math.max(...header.map((w) => w.y1));
    const h = y1 - y0;
    const maxWord = header.find((w) => letters(w.text) === "MAX")!;
    const stop = words
      .filter((w) => w.y0 > y1 + h && (/^(RULES|ALERTS|CREATE|SHOWING)$/i.test(letters(w.text)) || near(letters(w.text), "DESCRIPTION")))
      .map((w) => w.y0);
    table = {
      x0: 0,
      x1: Math.min(imageWidth, Math.ceil(maxWord.x1 + (maxWord.x1 - maxWord.x0) * 6)),
      y0: Math.max(0, Math.floor(y0 - h)),
      y1: Math.min(imageHeight, Math.ceil(stop.length ? Math.min(...stop) - h / 2 : imageHeight)),
    };
  }
  return { master, table };
}

/**
 * A close read of the limits checked against another read of them (the
 * whole page's): a value the two read differently is unsure, and so is a
 * row only the other read found.
 */
export function crossCheckLimits(close: LimitsRead, other: LimitsRead): LimitsRead {
  const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let master = close.master ?? (other.master ? { ...other.master, unsure: true } : null);
  if (close.master && other.master) {
    const differs =
      (close.master.min !== null && other.master.min !== null && close.master.min !== other.master.min) ||
      (close.master.max !== null && other.master.max !== null && close.master.max !== other.master.max);
    if (differs) master = { ...close.master, unsure: true };
  }
  const byType: LimitRowRead[] = close.byType.map((row) => {
    const twin = other.byType.find((o) => key(o.name) === key(row.name));
    const differs = twin && ((twin.min !== null && row.min !== null && twin.min !== row.min) || (twin.max !== null && row.max !== null && twin.max !== row.max));
    return differs ? { ...row, unsure: true } : row;
  });
  for (const row of other.byType) if (!byType.some((r) => key(r.name) === key(row.name))) byType.push({ ...row, unsure: true });
  return { master, byType };
}
