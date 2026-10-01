/**
 * One screenshot of PIE's "Rules and Alerts" page, read: its rules (name,
 * mode, type, description, dates, whether its Active switch is on) and its
 * price limits. The method, proven on real pages:
 *
 *   1. OCR the whole screenshot upscaled in grayscale, for the headers, the
 *      rows and the limits: 2x for a retina capture (at its own size one
 *      number was misread), more when the text is smaller (a capture at 1x
 *      or 1.5x), so the text is read at the same size either way.
 *   2. Crop the DESCRIPTION column (from its header to START DATE's, below
 *      the header), upscale it half as much again and OCR it alone: clean
 *      text in reading order. NAME to TYPE is read the same way. Each word
 *      goes to the row whose band it sits in. The limits are read again the
 *      same way and checked against the first read.
 *   3. Read the Active switch from the pixels: green in the ACTIVE column on
 *      the row is on, none is off.
 *
 * The OCR itself and the image work are handed in (OcrPass), so this runs
 * the same in the browser (tesseract.js on a canvas) and in tests (tesseract.js
 * and sharp under Node). Nothing here keeps or sends the image.
 */

import {
  columnRange,
  crossCheckLimits,
  findRowBands,
  findRulesColumns,
  isDescriptionHead,
  limitsRegions,
  readEntries,
  readLimits,
  seesRules,
  textOf,
  wordLines,
  wordsIn,
  type Box,
  type LimitsRead,
  type OcrWord,
  type RowBand,
  type RulesColumns,
} from "./layout";
import { parseDescription } from "./description";
import { parsePieDate, tidy } from "./text";

/** A screenshot's pixels, four bytes a pixel (RGBA). */
export type RgbaImage = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

/**
 * OCR of a region of the screenshot (all of it when null), upscaled `scale`
 * times in grayscale first, with each word's box in the screenshot's own
 * pixels.
 */
export type OcrPass = (region: Box | null, scale: number) => Promise<OcrWord[]>;

export type PieMode = "auto" | "manual";
export type PieType = "occupancy" | "restriction" | "compset" | "other";

export type PieRowRead = {
  name: string;
  mode: PieMode | null;
  type: PieType | null;
  /** The TYPE cell as read, for a type MAYA does not know. */
  typeText: string;
  description: string;
  /** The Active switch: null when it could not be seen. */
  active: boolean | null;
  startDate: string;
  endDate: string;
  /** The row runs off the screenshot's edge, or its description stops short there. */
  cutOff: boolean;
  /** Which edge cut it. */
  cutEdge: "top" | "bottom" | null;
  /** Its numbers may be misread: two reads of them differ, or OCR wasn't sure of one. */
  numbersUnsure: boolean;
  /** The row's middle, in the screenshot's pixels (for order). */
  y: number;
};

export type ScreenshotRead = {
  width: number;
  height: number;
  /** The rules table's columns: from its header, or carried from an earlier screenshot. null when not found. */
  columns: RulesColumns | null;
  rows: PieRowRead[];
  limits: LimitsRead;
  /** PIE's "Showing 1 to N of N entries", when in view. */
  entries: { from: number; to: number; total: number } | null;
  /** A rules table is on the page (its heading, DESCRIPTION, or a rule's "rate by"), read or not. */
  rulesSeen: boolean;
  /** How many times the page was upscaled for its first read. */
  scale: number;
};

/** The middle of a list of numbers. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The height of the page's words (three letters or more, read with confidence), in its own pixels; null with too few. */
export function textHeight(words: readonly OcrWord[]): number | null {
  const good = words.filter((w) => /^[A-Za-z]{3,}$/.test(w.text) && (w.confidence ?? 100) > 60).map((w) => w.y1 - w.y0);
  return good.length >= 5 ? median(good) : null;
}

/**
 * How many times to upscale a page whose words are `h` pixels tall: so they
 * are read about 27 pixels tall, as a retina capture's are at 2x. Never less
 * than 2x (the proven read) or more than 5x; in half steps.
 */
export function scaleFor(h: number | null): number {
  if (!h || !(h > 0)) return 2;
  return Math.min(5, Math.max(2, Math.round((27 / h) * 2) / 2));
}

/** Whether every number of one read is in the other (which may have stray marks read as digits too). */
function within(mine: readonly string[], again: readonly string[]): boolean {
  const left = [...again];
  return mine.every((n) => {
    const i = left.indexOf(n);
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  });
}

/** The numbers in a description, in order ("10.00", "31.00", "80", "800"). */
function numbersIn(text: string): string[] {
  return (tidy(text).match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]+$/, ""));
}

/** Green, as PIE draws a switch that is on. */
function isGreen(r: number, g: number, b: number): boolean {
  return g > 110 && g - r > 50 && g - b > 25;
}

/**
 * Whether the switch in `region` is on: green there is on; drawn but not
 * green is off; nothing drawn (all white, or outside the image) is null.
 */
export function switchIsOn(image: RgbaImage, region: Box): boolean | null {
  const x0 = Math.max(0, Math.floor(region.x0));
  const x1 = Math.min(image.width, Math.ceil(region.x1));
  const y0 = Math.max(0, Math.floor(region.y0));
  const y1 = Math.min(image.height, Math.ceil(region.y1));
  let n = 0;
  let green = 0;
  let drawn = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      n++;
      if (isGreen(r, g, b)) green++;
      else if (r < 245 || g < 245 || b < 245) drawn++;
    }
  }
  if (n === 0) return null;
  if (green / n > 0.03) return true;
  if (drawn / n > 0.02) return false;
  return null;
}

function typeOf(text: string): PieType | null {
  const t = text.replace(/[^A-Za-z]/g, "").toLowerCase();
  if (!t) return null;
  if (t.startsWith("occupanc")) return "occupancy";
  if (t.startsWith("restriction")) return "restriction";
  if (t.startsWith("compset") || t.startsWith("comp") || t.startsWith("competitor")) return "compset";
  return "other";
}

function modeOf(text: string): PieMode | null {
  const t = text.replace(/[^A-Za-z0-9|]/g, "").toLowerCase();
  if (/^au[t1]o$/.test(t)) return "auto";
  if (/^manua[l1i|]?$/.test(t)) return "manual";
  return null;
}

/** The switch's region on a row: the ACTIVE column, around the row's middle. */
function switchRegion(cols: RulesColumns, band: RowBand): Box | null {
  if (cols.active === null) return null;
  const width = cols.name - cols.active;
  const half = Math.min(14, (band.bottom - band.top) * 0.3);
  return { x0: cols.active - width * 0.5, x1: cols.name - 8, y0: band.center - half, y1: band.center + half };
}

/** The limits read again from their own crops, closer, and checked against the whole page's read. */
async function readLimitsClosely(full: readonly OcrWord[], image: RgbaImage, ocr: OcrPass, scale: number): Promise<LimitsRead> {
  const first = readLimits(full);
  const regions = limitsRegions(full, image.width, image.height);
  const masterWords = regions.master ? await ocr(regions.master, scale) : [];
  const tableWords = regions.table ? await ocr(regions.table, scale) : [];
  const close: LimitsRead = { master: readLimits(masterWords).master, byType: readLimits(tableWords).byType };
  return crossCheckLimits(close, first);
}

/**
 * Read one screenshot. `carry` is the rules table's columns from an earlier
 * screenshot of the same import, used when this one has no header in view
 * (the page scrolled down) and is the same width.
 */
export async function readScreenshot(image: RgbaImage, ocr: OcrPass, carry: RulesColumns | null = null): Promise<ScreenshotRead> {
  const first = await ocr(null, 2);
  const scale = scaleFor(textHeight(first));
  const full = scale === 2 ? first : await ocr(null, scale);
  // The crops, half as close again.
  const close = scale * 1.5;
  const limits = await readLimitsClosely(full, image, ocr, close);
  const columns =
    findRulesColumns(full, image.width) ??
    (carry && carry.imageWidth === image.width ? { ...carry, headerBottom: null } : null);
  const out: ScreenshotRead = {
    width: image.width,
    height: image.height,
    columns,
    rows: [],
    limits,
    entries: readEntries(full),
    rulesSeen: seesRules(full),
    scale,
  };
  if (!columns) return out;

  const [d0, d1] = columnRange(columns, "description");
  // Below the header; from the very top when it scrolled out of view.
  const top = columns.headerBottom === null ? 0 : Math.max(0, Math.round(columns.headerBottom + 4));
  const crop: Box = { x0: Math.max(0, Math.round(d0)), x1: Math.min(image.width, Math.round(d1)), y0: top, y1: image.height };
  const descWords = crop.x1 - crop.x0 > 10 && crop.y1 - crop.y0 > 10 ? await ocr(crop, close) : [];

  // NAME, MODE and TYPE cropped and read the same way: the whole page's
  // read puts stray marks into names.
  const [n0] = columnRange(columns, "name");
  const left: Box = { x0: Math.max(0, Math.round(n0)), x1: Math.max(0, Math.round(d0)), y0: top, y1: image.height };
  const leftWords = left.x1 - left.x0 > 10 && left.y1 - left.y0 > 10 ? await ocr(left, close) : [];

  // START DATE and END DATE the same way.
  const [s0] = columnRange(columns, "start");
  const [, e1] = columnRange(columns, "end");
  const dates: Box | null =
    Number.isFinite(s0) || Number.isFinite(e1)
      ? { x0: Math.max(0, Math.round(Number.isFinite(s0) ? s0 : columnRange(columns, "end")[0])), x1: Math.min(image.width, Math.round(Number.isFinite(e1) ? e1 : image.width)), y0: top, y1: image.height }
      : null;
  const dateWords = dates && dates.x1 - dates.x0 > 10 && dates.y1 - dates.y0 > 10 ? await ocr(dates, close) : [];

  const bands = findRowBands({ full, left: leftWords, desc: descWords }, columns, image.height);
  if (bands.length === 0) return out;
  const scrolled = columns.headerBottom === null;

  // A line the edge cut through reads as noise (the halves of letters, read
  // with little confidence, or under half a line tall): left out of a cut
  // row, whole. A line whole but touching the edge (a "y" reaching it) stays.
  const lineHeight = (words: readonly OcrWord[]) => {
    const hs = wordLines(words)
      .filter((l) => l.every((w) => w.y0 > top + 3 && w.y1 < image.height - 3))
      .map((l) => Math.max(...l.map((w) => w.y1)) - Math.min(...l.map((w) => w.y0)));
    return hs.length > 0 ? median(hs) : null;
  };
  const descH = lineHeight(descWords);
  const leftH = lineHeight(leftWords);
  const halfRead = (line: readonly OcrWord[], typical: number | null) => {
    const sure = line.reduce((n, w) => n + (w.confidence ?? 100), 0) / line.length;
    const tall = Math.max(...line.map((w) => w.y1)) - Math.min(...line.map((w) => w.y0));
    return sure < 60 || (typical !== null && tall < typical * 0.5);
  };
  const edgeLine = (line: readonly OcrWord[], edge: "top" | "bottom", typical: number | null) =>
    (edge === "bottom" ? line.some((w) => w.y1 > image.height - 3) : line.some((w) => w.y0 < top + 3)) && halfRead(line, typical);
  const keep = (words: readonly OcrWord[], edge: "top" | "bottom" | null, typical: number | null) =>
    edge ? wordLines(words).filter((l) => !edgeLine(l, edge, typical)).flat() : [...words];
  const cell = (band: RowBand, column: "name" | "mode" | "type" | "start" | "end", edge: "top" | "bottom" | null) => {
    const [a, b] = columnRange(columns, column);
    const dated = column === "start" || column === "end";
    const source = dated ? (dateWords.length > 0 ? dateWords : full) : leftWords;
    return textOf(keep(wordsIn(source, band, a, b), edge, dated ? null : leftH));
  };

  out.rows = bands.map((band, i) => {
    const first = i === 0;
    const last = i === bands.length - 1;
    const words = wordsIn(descWords, band);
    const read = parseDescription(textOf(words));
    // The last row's description stops short, or its words touch the bottom
    // edge; the first row's (no header in view) touches the top edge, or
    // starts part way through. A row that is both (the only one) is cut at
    // the edge it is nearer.
    const stopsShort = (read.ok && !read.complete) || (!read.ok && read.reason === "cut");
    const atBottom = band.cutBottom || (last && (stopsShort || words.some((w) => w.y1 > image.height - 3)));
    const atTop =
      band.cutTop || (first && scrolled && (words.some((w) => w.y0 < top + 3) || (!band.anchored && !read.ok && read.reason === "not_rate")));
    // A description read from its "rate by" to its end, clear of the top
    // edge, is whole even when the top of the row (its switch's edge) isn't.
    const wholeBelowTop =
      read.ok && read.complete && words.length > 0 && Math.min(...words.map((w) => w.y0)) > top + 3 && isDescriptionHead(textOf(wordLines(words)[0]));
    const fromTop = atTop && !wholeBelowTop;
    const edge: "top" | "bottom" | null = atBottom && fromTop ? (band.center < image.height / 2 ? "top" : "bottom") : atBottom ? "bottom" : fromTop ? "top" : null;
    const kept = keep(words, edge, descH);
    const description = textOf(kept);
    // The numbers, checked against the whole page's read of the same row.
    const again = numbersIn(textOf(wordsIn(full, band, d0, d1)));
    const mine = numbersIn(description);
    const numbersUnsure =
      kept.some((w) => /\d/.test(w.text) && (w.confidence ?? 100) < 60) || (!edge && again.length > 0 && !within(mine, again));
    const typeText = cell(band, "type", edge);
    const region = switchRegion(columns, band);
    return {
      name: cleanName(cell(band, "name", edge)),
      mode: modeOf(cell(band, "mode", edge)),
      type: typeOf(typeText),
      typeText,
      description,
      active: region ? switchIsOn(image, region) : null,
      startDate: cell(band, "start", edge),
      endDate: cell(band, "end", edge),
      cutOff: edge !== null,
      cutEdge: edge,
      numbersUnsure,
      y: band.center,
    };
  });
  return out;
}

/**
 * A name without the stray marks OCR finds at a cell's edges (a sort arrow,
 * a cursor): lone punctuation that is not part of what PIE writes in names
 * ("> 87%" keeps its ">").
 */
export function cleanName(name: string): string {
  const words = tidy(name)
    .split(" ")
    .filter((w) => !/^[)(|:;'"`°~_.,\][{}]{1,2}$/.test(w));
  // A bracket with no partner is a mark too.
  const joined = words.join(" ");
  const opens = (joined.match(/\(/g) ?? []).length;
  const closes = (joined.match(/\)/g) ?? []).length;
  return (opens === closes ? joined : joined.replace(/[()]/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * A row's text as one string, for telling two reads of the same row apart:
 * its name, description, dates (as dates, so "N/A" read with a stray mark
 * is still none), mode and type (two rules alike but for their dates are two
 * rules).
 */
export function rowKey(row: Pick<PieRowRead, "name" | "description" | "startDate" | "endDate" | "mode" | "type">): string {
  const squash = (s: string) => tidy(s).toLowerCase().replace(/[^a-z0-9%]+/g, "");
  const date = (raw: string) => {
    const d = parsePieDate(raw);
    return d.kind === "none" ? "" : d.kind === "date" ? d.date : squash(raw);
  };
  return [squash(row.name), squash(row.description), date(row.startDate), date(row.endDate), row.mode ?? "", row.type ?? ""].join("|");
}
