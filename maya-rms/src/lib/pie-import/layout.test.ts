/**
 * The screenshot reader's layout and pixel work, on words placed by hand
 * the way OCR returns them from PIE's page (made-up names and numbers), and
 * on drawn pixels.
 */
import { describe, expect, it } from "vitest";
import {
  crossCheckLimits,
  findRowBands,
  findRulesColumns,
  limitsRegions,
  readEntries,
  readLimits,
  seesRules,
  textOf,
  wordLines,
  type Box,
  type OcrWord,
} from "./layout";
import { cleanName, readScreenshot, scaleFor, switchIsOn, textHeight, type RgbaImage } from "./read";

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
    const whole = findRowBands({ full: words }, cols, 830);
    expect(whole.map((b) => b.center)).toEqual(ys);
    expect(whole.map((b) => b.cutBottom)).toEqual([false, false, false]);
    expect(whole[1].top).toBeCloseTo((635 + 712) / 2);
    // The same page cut 20 px lower down the last row.
    expect(findRowBands({ full: words }, cols, 810).map((b) => b.cutBottom)).toEqual([false, false, true]);
  });

  it("finds rows on a screenshot scrolled past the header, the first one cut at the top", () => {
    const cols = { ...findRulesColumns(header(), 2000)!, headerBottom: null };
    const words = ROWS.flatMap((r, i) => row(r, [20, 98, 175][i]).left);
    const bands = findRowBands({ full: words }, cols, 400);
    expect(bands.map((b) => b.cutTop)).toEqual([true, false, false]);
  });
});

describe("finding rows from every read, never two rules in one", () => {
  const cols = () => findRulesColumns(header(), 2000)!;
  const ys = [635, 712, 790];
  const rows = () => ROWS.map((r, i) => row(r, ys[i]));

  it("makes a row of a description that starts a rule when its MODE and TYPE weren't read", () => {
    const r = rows();
    // The middle row's "Auto" and "Occupancy" were missed by both reads.
    const left = [...r[0].left, ...r[1].left.filter((x) => !["Manual", "Occupancy"].includes(x.text)), ...r[2].left];
    const bands = findRowBands({ full: [...header(), ...left], left, desc: r.flatMap((x) => x.desc) }, cols(), 830);
    expect(bands).toHaveLength(3);
    expect(bands.map((b) => b.anchored)).toEqual([true, false, true]);
    expect(bands[1].center).toBeCloseTo(712, -1);
    // Each description stays in its own band.
    expect(textOf(r[0].desc.filter((x) => (x.y0 + x.y1) / 2 >= bands[0].top && (x.y0 + x.y1) / 2 < bands[0].bottom))).toBe(
      "Raise rate by 10.00 % when occupancy is greater than 60.00 % and when booking 30-500 days in advance",
    );
    expect(r[1].desc.every((x) => (x.y0 + x.y1) / 2 >= bands[1].top && (x.y0 + x.y1) / 2 < bands[1].bottom)).toBe(true);
  });

  it("takes the rows from the NAME to TYPE crop when the whole page's read missed them", () => {
    const r = rows();
    const bands = findRowBands({ full: header(), left: r.flatMap((x) => x.left), desc: r.flatMap((x) => x.desc) }, cols(), 830);
    expect(bands.map((b) => [b.center, b.anchored])).toEqual(ys.map((y) => [y, true]));
  });

  it("keeps a row the bottom edge cut above its MODE and TYPE, as a cut row", () => {
    const r = rows();
    // The screenshot ends just under the last row's first line of description.
    const height = 790 - 13 + 8;
    const desc = [...r[0].desc, ...r[1].desc, ...phrase(ROWS[2].desc[0], COLS.description, 790 - 13)];
    const left = [...r[0].left, ...r[1].left];
    const bands = findRowBands({ full: [...header(), ...left], left, desc }, cols(), height);
    expect(bands.map((b) => [b.anchored, b.cutBottom])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
  });

  it("keeps the rest of a row at the top of a screenshot scrolled past the header, as a row cut at the top", () => {
    const scrolled = { ...cols(), headerBottom: null };
    // The page scrolled so the first row's second line of description and name are all that show.
    const desc = [...phrase("and when booking 30-500 days in advance", COLS.description, 8), ...row(ROWS[1], 85).desc, ...row(ROWS[2], 162).desc];
    const left = [...phrase("days out", COLS.name, 8), ...row(ROWS[1], 85).left, ...row(ROWS[2], 162).left];
    const bands = findRowBands({ full: left, left, desc }, scrolled, 400);
    expect(bands.map((b) => [b.anchored, b.cutTop])).toEqual([
      [false, true],
      [true, false],
      [true, false],
    ]);
  });

  it("leaves out the table's footer", () => {
    const r = rows();
    const desc = [...r.flatMap((x) => x.desc), ...phrase("Showing 1 to 3 of 3 entries", COLS.description, 860)];
    const left = r.flatMap((x) => x.left);
    expect(findRowBands({ full: [...header(), ...left], left, desc }, cols(), 900)).toHaveLength(3);
  });

  it("reads PIE's count of its rules, and whether rules are on the page at all", () => {
    expect(readEntries([...phrase("Showing 1 to 7 of 7 entries", 1700, 520)])).toEqual({ from: 1, to: 7, total: 7 });
    expect(readEntries(header())).toBeNull();
    expect(seesRules(phrase("Raise rate by 10.00 % when occupancy is greater than 60.00 %", 920, 640))).toBe(true);
    expect(seesRules(phrase("Ralse rate bv 10.00 % when", 920, 640))).toBe(true);
    expect(seesRules([...header(), w("Raise", 920, 640)])).toBe(true);
    expect(seesRules([...phrase("PRICE LIMITS BY ACCOMMODATION TYPE", 149, 126), w("$109.00", 1133, 226)])).toBe(false);
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

  const table = (rows: [string, OcrWord, OcrWord][]) => [
    ...phrase("ACCOMMODATION TYPE", 129, 178),
    w("MIN", 1133, 178),
    w("MAX", 1525, 178),
    ...rows.flatMap(([name, min, max]) => [...phrase(name, 129, min.y0 + 7), min, max]),
  ];

  it("marks a number OCR wasn't sure of, or one missing the $ the others have, as unsure", () => {
    const words = table([
      ["Garden Room", w("$110.00", 1133, 226), w("$520.00", 1525, 226)],
      // "$540.00" read as "3540.00".
      ["Tree House - ADA", w("$240.00", 1133, 275), w("3540.00", 1525, 275)],
      ["Loft Suite", { ...w("$135.00", 1133, 324), confidence: 77 }, w("$900.00", 1525, 324)],
      ["Bunk Room", w("$40.00", 1133, 373), w("$300.00", 1525, 373)],
    ]);
    expect(readLimits(words).byType).toEqual([
      { name: "Garden Room", min: 110, max: 520 },
      { name: "Tree House - ADA", min: 240, max: 3540, unsure: true },
      { name: "Loft Suite", min: 135, max: 900, unsure: true },
      { name: "Bunk Room", min: 40, max: 300 },
    ]);
  });

  it("checks a close read of the limits against another: values they differ on, and rows only one found, are unsure", () => {
    const close = { master: { min: 95, max: 2800 }, byType: [{ name: "Garden Room", min: 110, max: 520 }, { name: "Loft Suite", min: 180, max: 900 }] };
    const other = {
      master: { min: 96, max: 2800 },
      byType: [
        { name: "Garden Room", min: 110, max: 520 },
        { name: "Loft Suite", min: 180, max: 300 },
        { name: "Yurt", min: 60, max: 200 },
      ],
    };
    expect(crossCheckLimits(close, other)).toEqual({
      master: { min: 95, max: 2800, unsure: true },
      byType: [
        { name: "Garden Room", min: 110, max: 520 },
        { name: "Loft Suite", min: 180, max: 900, unsure: true },
        { name: "Yurt", min: 60, max: 200, unsure: true },
      ],
    });
    expect(crossCheckLimits(close, close)).toEqual(close);
  });

  it("finds where to read the limits again: the minimum and maximum, and the table down to the rules", () => {
    const words = [
      ...phrase("Minimum Price *", 98, 27),
      ...phrase("Maximum Price *", 420, 27),
      w("$99.00", 98, 53),
      ...phrase("ACCOMMODATION TYPE", 129, 178),
      w("MIN", 1133, 178),
      w("MAX", 1525, 178),
      ...phrase("Garden Room", 129, 226),
      ...phrase("RULES AND ALERTS", 99, 470),
    ];
    const { master, table } = limitsRegions(words, 2000, 900);
    expect(master).toEqual({ x0: 0, x1: 2000, y0: 6, y1: 90 });
    expect(table?.y0).toBe(157);
    expect(table?.y1).toBe(470 - 7 - 7);
    expect(table!.x1).toBeGreaterThan(1525 + 24);
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

describe("how close to read", () => {
  it("reads small text closer: a retina capture at 2x, a 1x capture at 4x", () => {
    expect(scaleFor(13)).toBe(2);
    expect(scaleFor(12.5)).toBe(2);
    expect(scaleFor(9.5)).toBe(3);
    expect(scaleFor(7)).toBe(4);
    expect(scaleFor(3)).toBe(5);
    expect(scaleFor(null)).toBe(2);
    // Words of three letters or more, read with confidence, tell the height.
    const words = ["Raise", "rate", "when", "occupancy", "greater", "than"].map((t, i) => ({ ...w(t, 100 + i * 80, 50), y0: 46, y1: 53 }));
    expect(textHeight(words)).toBe(7);
    expect(textHeight(words.slice(0, 2))).toBeNull();
  });
});

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
      // The DESCRIPTION crop, the NAME to TYPE crop, and the dates.
      if (region.x0 >= COLS.start - 8) return rows.flatMap((r) => r.dates);
      return region.x0 > COLS.type ? rows.flatMap((r) => r.desc) : rows.flatMap((r) => r.left);
    };
    const read = await readScreenshot(img, ocr);
    expect(asked.map((a) => a.scale)).toEqual([2, 3, 3, 3]);
    expect(asked[1].region).toEqual({ x0: COLS.description - 8, x1: COLS.start - 8, y0: HEADER_Y + 7 + 4, y1: 830 });
    expect(asked[3].region).toEqual({ x0: COLS.start - 8, x1: COLS.end + (COLS.end - COLS.start) - 8, y0: HEADER_Y + 7 + 4, y1: 830 });
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

  it("reads a 1x capture's page and columns closer", async () => {
    // The same page at half the size: words 7 px tall, so the page is read again at 4x and the columns at 6x.
    const half = (x: OcrWord): OcrWord => ({ ...x, x0: x.x0 / 2, x1: x.x1 / 2, y0: x.y0 / 2, y1: x.y1 / 2 });
    const r = row(ROWS[0], 635);
    const full = [...header(), ...r.left, ...r.dates].map(half);
    const asked: number[] = [];
    const ocr = async (region: Box | null, scale: number) => {
      asked.push(scale);
      if (!region) return full;
      if (region.x0 >= (COLS.start - 8) / 2 - 8) return r.dates.map(half);
      return (region.x0 > COLS.type / 2 ? r.desc : r.left).map(half);
    };
    const read = await readScreenshot(canvas(1000, 350), ocr);
    expect(asked).toEqual([2, 4, 6, 6, 6]);
    expect(read.scale).toBe(4);
    expect(read.rows.map((x) => [x.name, x.description])).toEqual([
      ["Busy weekend", "Raise rate by 10.00 % when occupancy is greater than 60.00 % and when booking 30-500 days in advance"],
    ]);
  });

  it("leaves a line the edge cut through out of a cut row, and keeps a whole one that touches the edge", async () => {
    const ys = [635, 712];
    const rows = ROWS.slice(0, 2).map((r, i) => row(r, ys[i]));
    // The image ends 4 px into the second row's second line: its top half read as noise.
    const height = 712 + 13 - 3;
    const noise = phrase("sanq wh 3 Rv", COLS.description, height - 2).map((x) => ({ ...x, y0: height - 5, y1: height, confidence: 20 }));
    const desc = [...rows[0].desc, ...phrase(ROWS[1].desc[0], COLS.description, 712 - 13), ...noise];
    const full = [...header(), ...rows.flatMap((r) => r.left)];
    const ocr = async (region: Box | null) => {
      if (!region) return full;
      if (region.x0 >= COLS.start - 8) return [];
      return region.x0 > COLS.type ? desc : rows.flatMap((r) => r.left);
    };
    const read = await readScreenshot(canvas(2000, height), ocr);
    expect(read.rows[1]).toMatchObject({ cutOff: true, cutEdge: "bottom", description: "Lower rate by 8.00 % when occupancy is lower than 20.00 %" });
    // The same line read with confidence, touching the edge only with a "y": kept.
    const whole = [...rows[0].desc, ...phrase(ROWS[1].desc[0], COLS.description, 712 - 13), ...phrase("and when booking", COLS.description, height - 6).map((x) => ({ ...x, y1: height }))];
    const ocr2 = async (region: Box | null) => (!region ? full : region.x0 >= COLS.start - 8 ? [] : region.x0 > COLS.type ? whole : rows.flatMap((r) => r.left));
    expect((await readScreenshot(canvas(2000, height), ocr2)).rows[1].description).toBe(
      "Lower rate by 8.00 % when occupancy is lower than 20.00 % and when booking",
    );
  });

  it("marks a row's numbers unsure when the whole page's read of them differs", async () => {
    const r = row(ROWS[0], 635);
    const page = (n: string) => [
      ...header(),
      ...r.left,
      ...phrase(`Raise rate by 10.00 % when occupancy is greater than ${n} %`, COLS.description, 635 - 13),
      ...phrase("and when booking 30-500 days in advance", COLS.description, 635 + 13),
      // A stray mark read as a digit is no difference.
      w("7", COLS.description + 400, 635),
    ];
    const read = async (n: string) =>
      (
        await readScreenshot(canvas(2000, 760), async (region) =>
          !region ? page(n) : region.x0 >= COLS.start - 8 ? [] : region.x0 > COLS.type ? r.desc : r.left,
        )
      ).rows[0].numbersUnsure;
    expect(await read("60.00")).toBe(false);
    expect(await read("68.00")).toBe(true);
  });

  it("reads the limits again from their own crops, and marks a value the two reads differ on", async () => {
    const page = [
      ...phrase("Minimum Price *", 98, 27),
      ...phrase("Maximum Price *", 420, 27),
      w("$99.00", 98, 53),
      w("$2,500.00", 420, 53),
      ...phrase("ACCOMMODATION TYPE", 129, 178),
      w("MIN", 1133, 178),
      w("MAX", 1525, 178),
      ...phrase("Garden Room", 129, 226),
      w("$109.00", 1133, 226),
      w("$450.00", 1525, 226),
      ...phrase("Loft Suite", 129, 275),
      w("$180.00", 1133, 275),
      w("$900.00", 1525, 275),
    ];
    const asked: (Box | null)[] = [];
    const ocr = async (region: Box | null) => {
      asked.push(region);
      if (!region) return page;
      // The close read of the table sees Loft Suite's ceiling differently.
      return page.filter((x) => x.y0 >= region.y0 && x.y1 <= region.y1).map((x) => (x.text === "$900.00" ? { ...x, text: "$300.00" } : x));
    };
    const read = await readScreenshot(canvas(2000, 400), ocr);
    expect(asked.filter((a) => a !== null)).toHaveLength(2);
    expect(read.limits).toEqual({
      master: { min: 99, max: 2500 },
      byType: [
        { name: "Garden Room", min: 109, max: 450 },
        { name: "Loft Suite", min: 180, max: 300, unsure: true },
      ],
    });
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
