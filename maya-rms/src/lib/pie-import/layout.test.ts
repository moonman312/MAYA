/**
 * The screenshot reader's layout and pixel work, on words placed by hand
 * the way OCR returns them from PIE's page (made-up names and numbers), and
 * on drawn pixels.
 */
import { describe, expect, it } from "vitest";
import { findRowBands, findRulesColumns, readLimits, textOf, wordLines, type Box, type OcrWord } from "./layout";
import { cleanName, readScreenshot, switchIsOn, type RgbaImage } from "./read";

/** A word at (x, y), its box sized from its letters. */
function w(text: string, x: number, y: number): OcrWord {
  return { text, x0: x, y0: y - 7, x1: x + text.length * 8, y1: y + 7, confidence: 90 };
}

/** Words of a phrase, left to right from x. */
function phrase(text: string, x: number, y: number): OcrWord[] {
  const out: OcrWord[] = [];
  let at = x;
  for (const t of text.split(" ")) {
    out.push(w(t, at, y));
    at += t.length * 8 + 6;
  }
  return out;
}

const COLS = { active: 150, name: 290, mode: 550, type: 735, description: 920, start: 1430, end: 1615 };
const HEADER_Y = 570;

function header(y = HEADER_Y): OcrWord[] {
  return [
    w("ACTIVE", COLS.active, y),
    w("$", 250, y),
    w("NAME", COLS.name, y),
    w("MODE", COLS.mode, y),
    w("TYPE", COLS.type, y),
    w("DESCRIPTION", COLS.description, y),
    w("START", COLS.start, y),
    w("DATE", COLS.start + 58, y),
    w("END", COLS.end, y),
    w("DATE", COLS.end + 40, y),
  ];
}

type RowSpec = { name: string; mode: string; type: string; desc: [string, string?]; start?: string; end?: string };

/** One table row centred on y: two-line name and description, mode and type in the middle. */
function row(r: RowSpec, y: number): { left: OcrWord[]; desc: OcrWord[]; dates: OcrWord[] } {
  return {
    left: [...phrase(r.name, COLS.name, y), ...phrase(r.mode, COLS.mode, y), ...phrase(r.type, COLS.type, y)],
    desc: [...phrase(r.desc[0], COLS.description, y - 13), ...(r.desc[1] ? phrase(r.desc[1], COLS.description, y + 13) : [])],
    dates: [w(r.start ?? "N/A", COLS.start, y), w(r.end ?? "N/A", COLS.end, y)],
  };
}

const ROWS: RowSpec[] = [
  { name: "Busy weekend", mode: "Auto", type: "Occupancy", desc: ["Raise rate by 10.00 % when occupancy is greater than 60.00 %", "and when booking 30-500 days in advance"] },
  { name: "Quiet week", mode: "Manual", type: "Occupancy", desc: ["Lower rate by 8.00 % when occupancy is lower than 20.00 %", "and when booking today-14 days in advance"] },
  { name: "Min stay", mode: "Auto", type: "Restriction", desc: ["Set minimum stay to 2 nights when occupancy is greater", "than 90.00 %"] },
];

describe("finding the rules table", () => {
  it("finds every column from the header row, not the limits table's TYPE", () => {
    const words = [...phrase("ACCOMMODATION TYPE", 80, 78), w("MIN", 1100, 78), w("MAX", 1490, 78), ...header()];
    expect(findRulesColumns(words, 2000)).toEqual({ ...COLS, headerBottom: HEADER_Y + 7, imageWidth: 2000 });
  });

  it("takes a header word with one letter misread, and is null with no header", () => {
    const words = header().map((x) => (x.text === "DESCRIPTION" ? { ...x, text: "DESCRIPT1ON" } : x));
    expect(findRulesColumns(words, 2000)?.description).toBe(COLS.description);
    expect(findRulesColumns(phrase("Raise rate by 10.00 %", 920, 600), 2000)).toBeNull();
    // Body text that happens to say "description" is not the header.
    expect(findRulesColumns([w("description", 920, 600), w("NAME", 290, 600), w("MODE", 550, 600), w("TYPE", 735, 600)], 2000)).toBeNull();
  });

  it("finds rows from their MODE and TYPE words, and a last row the edge cuts", () => {
    const cols = findRulesColumns(header(), 2000)!;
    const ys = [635, 712, 790];
    const words = [...header(), ...ROWS.flatMap((r, i) => row(r, ys[i]).left)];
    const whole = findRowBands(words, cols, 830);
    expect(whole.map((b) => b.center)).toEqual(ys);
    expect(whole.map((b) => b.cutBottom)).toEqual([false, false, false]);
    expect(whole[1].top).toBeCloseTo((635 + 712) / 2);
    // The same page cut 20 px lower down the last row.
    expect(findRowBands(words, cols, 810).map((b) => b.cutBottom)).toEqual([false, false, true]);
  });

  it("finds rows on a screenshot scrolled past the header, the first one cut at the top", () => {
    const cols = { ...findRulesColumns(header(), 2000)!, headerBottom: null };
    const words = ROWS.flatMap((r, i) => row(r, [20, 98, 175][i]).left);
    const bands = findRowBands(words, cols, 400);
    expect(bands.map((b) => b.cutTop)).toEqual([true, false, false]);
  });
});

describe("lines and text", () => {
  it("groups words into lines and reads them in order", () => {
    const words = [w("when", 200, 102), w("Raise", 100, 100), w("rate", 150, 99), w("and", 100, 126)];
    expect(wordLines(words).map((l) => l.map((x) => x.text))).toEqual([["Raise", "rate", "when"], ["and"]]);
    expect(textOf(words)).toBe("Raise rate when and");
  });

  it("drops stray marks from names, never what PIE writes", () => {
    expect(cleanName("Peak Season Push )")).toBe("Peak Season Push");
    expect(cleanName("Occupancy > 87%")).toBe("Occupancy > 87%");
    expect(cleanName("Suites (sea view)")).toBe("Suites (sea view)");
    expect(cleanName("' Busy : nights")).toBe("Busy nights");
  });
});

describe("price limits", () => {
  it("reads the minimum and maximum price and the table by accommodation type", () => {
    const words = [
      ...phrase("Minimum Price *", 98, 27),
      ...phrase("Maximum Price *", 420, 27),
      w("$99.00", 98, 53),
      w("$2,500.00", 420, 53),
      w("EDIT", 787, 53),
      ...phrase("PRICE LIMITS BY ACCOMMODATION TYPE", 149, 126),
      ...phrase("ACCOMMODATION TYPE", 129, 178),
      w("MIN", 1133, 178),
      w("MAX", 1525, 178),
      ...phrase("Garden Room", 129, 226),
      w("$109.00", 1133, 226),
      w("$450.00", 1525, 226),
      ...phrase("Tree House - ADA", 129, 275),
      w("$1,200.00", 1133, 275),
      w("$3,000.00", 1525, 275),
      ...phrase("RULES AND ALERTS", 99, 689),
      ...header(813),
    ];
    expect(readLimits(words)).toEqual({
      master: { min: 99, max: 2500 },
      byType: [
        { name: "Garden Room", min: 109, max: 450 },
        { name: "Tree House - ADA", min: 1200, max: 3000 },
      ],
    });
  });

  it("is empty when neither is in view", () => {
    expect(readLimits(header())).toEqual({ master: null, byType: [] });
  });
});

/* ── Pixels ───────────────────────────────────────────────────── */

const GREEN: [number, number, number] = [65, 182, 120];
const GREY: [number, number, number] = [236, 236, 236];

function canvas(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

function fill(img: RgbaImage, box: Box, rgb: [number, number, number]) {
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * img.width + x) * 4;
      [img.data[i], img.data[i + 1], img.data[i + 2]] = rgb;
    }
  }
}

/** PIE's switch: green on the left with a tick when on; white with a grey right half when off. */
function drawSwitch(img: RgbaImage, x: number, y: number, on: boolean) {
  fill(img, { x0: x, y0: y - 22, x1: x + 100, y1: y - 21 }, [220, 220, 220]);
  fill(img, { x0: x, y0: y + 21, x1: x + 100, y1: y + 22 }, [220, 220, 220]);
  if (on) fill(img, { x0: x, y0: y - 21, x1: x + 50, y1: y + 21 }, GREEN);
  else fill(img, { x0: x + 50, y0: y - 21, x1: x + 100, y1: y + 21 }, GREY);
}

describe("the Active switch", () => {
  const region = (y: number): Box => ({ x0: 80, x1: 282, y0: y - 14, y1: y + 14 });

  it("is on with green in the ACTIVE column, off with none, unknown with nothing drawn", () => {
    const img = canvas(400, 300);
    drawSwitch(img, 135, 50, true);
    drawSwitch(img, 135, 130, false);
    expect(switchIsOn(img, region(50))).toBe(true);
    expect(switchIsOn(img, region(130))).toBe(false);
    expect(switchIsOn(img, region(220))).toBeNull();
    expect(switchIsOn(img, { x0: 500, x1: 600, y0: 0, y1: 10 })).toBeNull();
  });

  it("isn't fooled by a little green elsewhere in the row", () => {
    const img = canvas(400, 100);
    drawSwitch(img, 135, 50, false);
    fill(img, { x0: 90, y0: 45, x1: 93, y1: 48 }, GREEN);
    expect(switchIsOn(img, region(50))).toBe(false);
  });
});

/* ── A whole screenshot, with a stand-in OCR ──────────────────── */

describe("reading a screenshot", () => {
  it("puts each row's name, mode, type, description, dates and switch together", async () => {
    const ys = [635, 712, 790];
    const rows = ROWS.map((r, i) => row({ ...r, ...(i === 0 ? { start: "10/01/2026", end: "10/31/2026" } : {}) }, ys[i]));
    const full = [...header(), ...rows.flatMap((r) => [...r.left, ...r.dates])];
    const img = canvas(2000, 830);
    ys.forEach((y, i) => drawSwitch(img, 135, y, i !== 1));
    const asked: { region: Box | null; scale: number }[] = [];
    const ocr = async (region: Box | null, scale: number) => {
      asked.push({ region, scale });
      if (!region) return full;
      // The DESCRIPTION crop, and the NAME to TYPE crop.
      return region.x0 > COLS.type ? rows.flatMap((r) => r.desc) : rows.flatMap((r) => r.left);
    };
    const read = await readScreenshot(img, ocr);
    expect(asked.map((a) => a.scale)).toEqual([2, 3, 3]);
    expect(asked[1].region).toEqual({ x0: COLS.description - 8, x1: COLS.start - 8, y0: HEADER_Y + 7 + 4, y1: 830 });
    expect(read.rows.map((r) => [r.name, r.mode, r.type, r.active, r.cutOff])).toEqual([
      ["Busy weekend", "auto", "occupancy", true, false],
      ["Quiet week", "manual", "occupancy", false, false],
      ["Min stay", "auto", "restriction", true, false],
    ]);
    expect(read.rows[0].description).toBe(
      "Raise rate by 10.00 % when occupancy is greater than 60.00 % and when booking 30-500 days in advance",
    );
    expect(read.rows[0].startDate).toBe("10/01/2026");
    expect(read.rows[1].endDate).toBe("N/A");
  });

  it("marks the last row cut off when its description stops short", async () => {
    const ys = [635, 712];
    // The second row's description ends at "and": its second line is not there.
    const rows = ROWS.slice(0, 2).map((r, i) => row(i === 1 ? { ...r, desc: [`${r.desc[0]} and`] } : r, ys[i]));
    // Rows 77 px apart, the image ending 48 px under the second row's middle: its band fits, its text doesn't.
    const img = canvas(2000, 760);
    const full = [...header(), ...rows.flatMap((r) => r.left)];
    const ocr = async (region: Box | null) => (!region ? full : region.x0 > COLS.type ? rows.flatMap((r) => r.desc) : rows.flatMap((r) => r.left));
    const read = await readScreenshot(img, ocr);
    expect(read.rows.map((r) => r.cutOff)).toEqual([false, true]);
  });

  it("carries the columns to a screenshot of the same page scrolled past the header", async () => {
    const cols = findRulesColumns(header(), 2000)!;
    const r = row(ROWS[0], 60);
    const img = canvas(2000, 300);
    const ocr = async (region: Box | null) => (!region ? r.left : region.x0 > COLS.type ? r.desc : r.left);
    expect((await readScreenshot(img, ocr)).rows).toEqual([]);
    const read = await readScreenshot(img, ocr, cols);
    expect(read.rows.map((x) => x.name)).toEqual(["Busy weekend"]);
    // A narrower screenshot is another page layout: nothing carried.
    expect((await readScreenshot(canvas(1500, 300), ocr, cols)).rows).toEqual([]);
  });
});
