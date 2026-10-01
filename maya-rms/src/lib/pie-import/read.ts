/**
 * One screenshot of PIE's "Rules and Alerts" page, read: its rules (name,
 * mode, type, description, dates, whether its Active switch is on) and its
 * price limits. The method, proven on real pages:
 *
 *   1. OCR the whole screenshot upscaled 2x in grayscale (at its own size one
 *      number was misread), for the headers, the rows and the limits.
 *   2. Crop the DESCRIPTION column (from its header to START DATE's, below
 *      the header), upscale it 3x and OCR it alone: clean text in reading
 *      order. Each word goes to the row whose band it sits in.
 *   3. Read the Active switch from the pixels: green in the ACTIVE column on
 *      the row is on, none is off.
 *
 * The OCR itself and the image work are handed in (OcrPass), so this runs
 * the same in the browser (tesseract.js on a canvas) and in tests (tesseract.js
 * and sharp under Node). Nothing here keeps or sends the image.
 */

import {
  columnRange,
  findRowBands,
  findRulesColumns,
  readLimits,
  textOf,
  wordsIn,
  type Box,
  type LimitsRead,
  type OcrWord,
  type RowBand,
  type RulesColumns,
} from "./layout";
import { parseDescription } from "./description";
import { tidy } from "./text";

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
};

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

/**
 * Read one screenshot. `carry` is the rules table's columns from an earlier
 * screenshot of the same import, used when this one has no header in view
 * (the page scrolled down) and is the same width.
 */
export async function readScreenshot(image: RgbaImage, ocr: OcrPass, carry: RulesColumns | null = null): Promise<ScreenshotRead> {
  const full = await ocr(null, 2);
  const limits = readLimits(full);
  const columns =
    findRulesColumns(full, image.width) ??
    (carry && carry.imageWidth === image.width ? { ...carry, headerBottom: null } : null);
  const out: ScreenshotRead = { width: image.width, height: image.height, columns, rows: [], limits };
  if (!columns) return out;

  const bands = findRowBands(full, columns, image.height);
  if (bands.length === 0) return out;

  const [d0, d1] = columnRange(columns, "description");
  const top = Math.max(0, Math.round((columns.headerBottom ?? 0) + 4));
  const crop: Box = { x0: Math.max(0, Math.round(d0)), x1: Math.min(image.width, Math.round(d1)), y0: top, y1: image.height };
  const descWords = crop.x1 - crop.x0 > 10 && crop.y1 - crop.y0 > 10 ? await ocr(crop, 3) : [];

  // NAME, MODE and TYPE cropped and read the same way: the whole page's
  // read puts stray marks into names.
  const [n0] = columnRange(columns, "name");
  const left: Box = { x0: Math.max(0, Math.round(n0)), x1: Math.max(0, Math.round(d0)), y0: top, y1: image.height };
  const leftWords = left.x1 - left.x0 > 10 && left.y1 - left.y0 > 10 ? await ocr(left, 3) : [];

  const cell = (band: RowBand, column: "name" | "mode" | "type" | "start" | "end") => {
    const [a, b] = columnRange(columns, column);
    const source = column === "start" || column === "end" ? full : leftWords;
    return textOf(wordsIn(source, band, a, b));
  };

  out.rows = bands.map((band, i) => {
    const desc = wordsIn(descWords, band);
    const description = textOf(desc);
    const last = i === bands.length - 1;
    // The last row's description stops short, or its words touch the bottom edge.
    const read = parseDescription(description);
    const stopsShort = (read.ok && !read.complete) || (!read.ok && read.reason === "cut");
    const touchesEdge = desc.some((w) => w.y1 > image.height - 3);
    const typeText = cell(band, "type");
    const region = switchRegion(columns, band);
    return {
      name: cleanName(cell(band, "name")),
      mode: modeOf(cell(band, "mode")),
      type: typeOf(typeText),
      typeText,
      description,
      active: region ? switchIsOn(image, region) : null,
      startDate: cell(band, "start"),
      endDate: cell(band, "end"),
      cutOff: band.cutBottom || band.cutTop || (last && (stopsShort || touchesEdge)) || (i === 0 && band.cutTop),
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

/** A row's text as one string, for telling two reads of the same row apart. */
export function rowKey(row: Pick<PieRowRead, "name" | "description">): string {
  const squash = (s: string) => tidy(s).toLowerCase().replace(/[^a-z0-9%]+/g, "");
  return `${squash(row.name)}|${squash(row.description)}`;
}
