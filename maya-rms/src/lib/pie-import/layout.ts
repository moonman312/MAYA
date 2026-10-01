/**
 * Where things are on a screenshot of PIE's "Rules and Alerts" page, from
 * the words OCR found and their boxes: the rules table's columns (from its
 * headers ACTIVE, NAME, MODE, TYPE, DESCRIPTION, START DATE, END DATE), its
 * rows (from each row's MODE and TYPE words), the "Minimum Price / Maximum
 * Price" pair and the "PRICE LIMITS BY ACCOMMODATION TYPE" table.
 *
 * Everything is in the screenshot's own pixels. Pure: no OCR, no pixels.
 */

import { looksLikeMoney, parseMoney, tidy } from "./text";

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
  /** The row's middle, from its MODE and TYPE words. */
  center: number;
  top: number;
  bottom: number;
  /** The row runs past the screenshot's bottom (or top) edge. */
  cutBottom: boolean;
  cutTop: boolean;
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

/** At most one letter different (an OCR slip in a header). */
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

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

/**
 * The table's rows, from the MODE words ("Auto", "Manual") and TYPE words
 * ("Occupancy", "Restriction", ...) below the header: each row's middle,
 * and its band from halfway to the row above to halfway to the row below.
 * A last row whose band runs past the bottom edge is cut off (and a first
 * row past the top, when no header is in view).
 */
export function findRowBands(words: readonly OcrWord[], cols: RulesColumns, imageHeight: number): RowBand[] {
  const top = cols.headerBottom ?? -Infinity;
  const [m0, m1] = columnRange(cols, "mode");
  const [t0, t1] = columnRange(cols, "type");
  const inCol = (w: OcrWord, a: number, b: number) => xMid(w) >= a && xMid(w) < b && w.y0 > top;
  const anchors = words.filter(
    (w) =>
      (inCol(w, m0, m1) && MODE_WORD.test(w.text.replace(/[^A-Za-z0-9|]/g, ""))) ||
      (inCol(w, t0, t1) && TYPE_WORD.test(w.text.replace(/[^A-Za-z-]/g, ""))),
  );
  if (anchors.length === 0) return [];
  const lineH = median(anchors.map(height));
  const centers: number[] = [];
  for (const y of anchors.map(yMid).sort((a, b) => a - b)) {
    const last = centers[centers.length - 1];
    if (last !== undefined && y - last <= lineH * 1.2) continue;
    centers.push(y);
  }
  const gaps = centers.slice(1).map((c, i) => c - centers[i]);
  const spacing =
    gaps.length > 0 ? median(gaps) : cols.headerBottom !== null ? 2 * (centers[0] - cols.headerBottom) : lineH * 4;
  return centers.map((center, i) => {
    const prev = centers[i - 1];
    const next = centers[i + 1];
    const bandTop = prev !== undefined ? (prev + center) / 2 : cols.headerBottom ?? center - spacing / 2;
    const bandBottom = next !== undefined ? (center + next) / 2 : center + spacing / 2;
    return {
      center,
      top: bandTop,
      bottom: bandBottom,
      cutBottom: next === undefined && center + spacing * 0.45 > imageHeight,
      cutTop: prev === undefined && cols.headerBottom === null && center - spacing * 0.45 < 0,
    };
  });
}

/** The words in a band and an x range (by their middles). */
export function wordsIn(words: readonly OcrWord[], band: Pick<RowBand, "top" | "bottom">, x0 = -Infinity, x1 = Infinity): OcrWord[] {
  return words.filter((w) => yMid(w) >= band.top && yMid(w) < band.bottom && xMid(w) >= x0 && xMid(w) < x1);
}

/* ── Price limits ─────────────────────────────────────────────── */

export type LimitRowRead = { name: string; min: number | null; max: number | null };

export type LimitsRead = {
  /** The page's "Minimum Price" and "Maximum Price", when in view. */
  master: { min: number | null; max: number | null } | null;
  /** PRICE LIMITS BY ACCOMMODATION TYPE, in order. */
  byType: LimitRowRead[];
};

/** The money word nearest below a label, in the label's column. */
function moneyBelow(words: readonly OcrWord[], label: OcrWord): number | null {
  const below = words
    .filter((w) => w.y0 > label.y1 - 2 && w.y0 < label.y1 + height(label) * 4 && Math.abs(w.x0 - label.x0) < height(label) * 3)
    .filter((w) => looksLikeMoney(w.text) || /^[$€£¥]$/.test(w.text.trim()))
    .sort((a, b) => a.y0 - b.y0);
  for (const w of below) {
    const v = parseMoney(w.text);
    if (v !== null) return v;
  }
  return null;
}

/**
 * The master minimum and maximum, and the per room type limits table.
 * A row of that table is a name on the left with its MIN and MAX under
 * those headers; reading stops at the first line that is not one (the
 * rules section below it).
 */
export function readLimits(words: readonly OcrWord[]): LimitsRead {
  const lines = wordLines(words);
  let master: LimitsRead["master"] = null;
  for (const line of lines) {
    const min = line.findIndex((w, i) => /^minimum$/i.test(letters(w.text)) && /^price/i.test(line[i + 1]?.text ?? ""));
    const max = line.findIndex((w, i) => /^maximum$/i.test(letters(w.text)) && /^price/i.test(line[i + 1]?.text ?? ""));
    if (min < 0 && max < 0) continue;
    master = {
      min: min >= 0 ? moneyBelow(words, line[min]) : null,
      max: max >= 0 ? moneyBelow(words, line[max]) : null,
    };
    if (master.min === null && master.max === null) master = null;
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
    for (const line of lines.slice(header + 1)) {
      const nameWords = line.filter((w) => w.x1 < minX - pad / 2);
      const minWords = line.filter((w) => w.x0 >= minX - pad && w.x0 < maxX - pad);
      const maxWords = line.filter((w) => w.x0 >= maxX - pad);
      const min = minWords.length ? parseMoney(minWords.map((w) => w.text).join("")) : null;
      const max = maxWords.length ? parseMoney(maxWords.map((w) => w.text).join("")) : null;
      const name = tidy(nameWords.map((w) => w.text).join(" "));
      if (!name || (min === null && max === null)) break;
      byType.push({ name, min, max });
    }
  }
  return { master, byType };
}
