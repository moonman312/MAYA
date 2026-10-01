/**
 * Slow: the whole screenshot reader with real OCR (tesseract.js under Node,
 * the same English data the browser is served), on a made-up screenshot of
 * PIE's Rules and Alerts page (__fixtures__/synthetic-pie.png, drawn by
 * scripts/pie-synthetic-screenshot.mjs): every rule's name, mode, type,
 * description and switch, the cut-off last row, the limits, and what the
 * import makes of them. Then the same page cut through a row, split into two
 * screenshots (apart and overlapping), and drawn at 1x
 * (__fixtures__/synthetic-pie-1x.png). Twenty seconds or so.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PIE_COPY, planImport, type ImportItem, type MayaRoomType } from "./map";
import { mergeReads } from "./merge";
import { nodeOcrWorker } from "./node-ocr.test-support";
import { readScreenshot, type ScreenshotRead } from "./read";

const PNG = path.join(__dirname, "__fixtures__", "synthetic-pie.png");
const PNG_1X = path.join(__dirname, "__fixtures__", "synthetic-pie-1x.png");

const ROOMS: MayaRoomType[] = [
  { id: "a0000000-0000-4000-8000-000000000001", name: "Garden Room", counts_as_room: true, floor_price: 80, ceiling_price: 600 },
  { id: "a0000000-0000-4000-8000-000000000002", name: "Tree House - ADA", counts_as_room: true, floor_price: 100, ceiling_price: 1000 },
  { id: "a0000000-0000-4000-8000-000000000003", name: "Loft Suite", counts_as_room: true, floor_price: 180, ceiling_price: 900 },
  { id: "a0000000-0000-4000-8000-000000000004", name: "Bunk Room", counts_as_room: true, floor_price: 40, ceiling_price: 300 },
];

const NAMES = ["Busy weekends", "Near full", "Quiet stretch", "Flat bump", "Suggest only", "Two night stays", "Late cut"];

/** The rows are 77 px tall under a header at 570 to 618: row i's middle. */
const middle = (i: number) => 570 + 48 + i * 77 + 38.5;

/** What a review item becomes, to compare two reads of the same rule. */
const made = (i: ImportItem) => JSON.stringify(i.drafts.map((d) => [d.condition, d.action]));

describe("reading a screenshot of PIE's page with real OCR (slow)", () => {
  let ocr: Awaited<ReturnType<typeof nodeOcrWorker>>;
  let png: Buffer;
  let read: ScreenshotRead;

  /** Read screenshots one after another, the headings carried, as the dialog does. */
  async function readAll(images: Buffer[]): Promise<ScreenshotRead[]> {
    const out: ScreenshotRead[] = [];
    let carry: ScreenshotRead["columns"] = null;
    for (const input of images) {
      const { image, pass } = await ocr.open(input);
      const r = await readScreenshot(image, pass, carry);
      if (r.columns?.headerBottom != null) carry = r.columns;
      out.push(r);
    }
    return out;
  }
  const crop = (top: number, height: number) => sharp(png).extract({ left: 0, top, width: 2000, height }).png().toBuffer();

  beforeAll(async () => {
    ocr = await nodeOcrWorker();
    png = readFileSync(PNG);
    [read] = await readAll([png]);
  }, 120_000);
  afterAll(async () => {
    await ocr?.close();
  });

  it("reads every row: name, mode, type, description, switch, and the cut-off last row", () => {
    expect(read.rows.map((r) => [r.name, r.mode, r.type, r.active, r.cutOff])).toEqual([
      ["Busy weekends", "auto", "occupancy", true, false],
      ["Near full", "auto", "occupancy", true, false],
      ["Quiet stretch", "auto", "occupancy", true, false],
      ["Flat bump", "auto", "occupancy", false, false],
      ["Suggest only", "manual", "occupancy", true, false],
      ["Two night stays", "auto", "restriction", true, false],
      ["Late cut", "auto", "occupancy", false, true],
    ]);
    expect(read.rows.slice(0, 5).map((r) => r.description)).toEqual([
      "Raise rate by 12.00 % when occupancy is greater than 55.00 % and when booking 20-700 days in advance",
      "Raise rate by 8.00 % when occupancy is greater than 82.00 %",
      "Lower rate by 7.00 % when occupancy is lower than 25.00 % and when booking today-21 days in advance",
      "Raise rate by 15.00 when occupancy is greater than 70.00 %",
      "Raise rate by 5.00 % when occupancy is greater than 65.00 % and when booking 10-400 days in advance",
    ]);
    expect(read.rows.every((r) => r.startDate === "N/A" && r.endDate === "N/A")).toBe(true);
    expect(read.rows.some((r) => r.numbersUnsure)).toBe(false);
    expect(read.entries).toEqual({ from: 1, to: 7, total: 7 });
    expect(read.scale).toBe(2);
  });

  it("reads the minimum and maximum price and the limits by accommodation type", () => {
    expect(read.limits).toEqual({
      master: { min: 95, max: 2800 },
      byType: [
        { name: "Garden Room", min: 110, max: 520 },
        { name: "Tree House - ADA", min: 240, max: 1250 },
        { name: "Loft Suite", min: 180, max: 900 },
      ],
    });
  });

  it("makes MAYA rules, notes and limits of them", () => {
    const { items, limits } = planImport(mergeReads([read]), ROOMS, { today: "2026-10-01" });
    expect(items.map((i) => [i.pie.name, i.status, i.on, i.ticked])).toEqual([
      ["Busy weekends", "ready", true, true],
      ["Near full", "ready", true, true],
      ["Quiet stretch", "ready", true, true],
      // A fixed amount with no sign, checked before it's ticked.
      ["Flat bump", "ready", false, false],
      ["Suggest only", "ready", true, true],
      ["Two night stays", "not_imported", true, false],
      ["Late cut", "needs_edit", false, false],
    ]);
    expect(items[0].drafts[0].condition).toEqual({ occupancy_operator: "gt", occupancy_threshold: 0.55, dta_operator: "gt", dta_threshold_days: 19 });
    expect(items[2].drafts[0]).toMatchObject({ condition: { occupancy_operator: "lt", occupancy_threshold: 0.25, dta_operator: "lt", dta_threshold_days: 22 }, action: { adjust_rate_percent: -7 } });
    expect(items[3].drafts[0].action).toEqual({ adjust_rate_dollars: 15 });
    expect(items[4].notes).toContain(PIE_COPY.manual);
    expect(items[5].reason).toBe(PIE_COPY.restriction);
    expect(items[6].reason).toBe(PIE_COPY.cutOff);
    // Each type's own row, and the minimum and maximum for the one without (Loft Suite's already match).
    expect(limits.changes.map((c) => [c.name, c.floor, c.ceiling, c.from, c.check])).toEqual([
      ["Garden Room", 110, 520, "own", null],
      ["Tree House - ADA", 240, 1250, "own", null],
      ["Bunk Room", 95, 2800, "master", null],
    ]);
    expect(limits.unmatched).toEqual([]);
  });

  it("shows a row the screenshot's edge cuts through as cut, never drops it, and counts PIE's rules", async () => {
    // Cut through the middle of Flat bump's one line.
    const merged = mergeReads(await readAll([await crop(0, Math.round(middle(3)))]));
    const { items } = planImport(merged, ROOMS, { today: "2026-10-01" });
    expect(items.map((i) => [i.pie.name, i.status])).toEqual([
      ["Busy weekends", "ready"],
      ["Near full", "ready"],
      ["Quiet stretch", "ready"],
      [expect.any(String), "needs_edit"],
    ]);
    expect(items[3].reason).toBe(PIE_COPY.cutOff);
    expect(merged).toMatchObject({ listed: 7, missing: 3 });
  }, 120_000);

  it("reads two screenshots split through a row, without overlap: every rule once, the split one put together or to finish", async () => {
    // Split between the two lines of Quiet stretch's description: its halves read whole together.
    const between = Math.round(middle(2));
    const merged = mergeReads(await readAll([await crop(0, between), await crop(between, 1132 - between)]));
    const { items } = planImport(merged, ROOMS, { today: "2026-10-01" });
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.pie.name).filter((n) => NAMES.includes(n))).toEqual(NAMES.filter((n) => n !== "Quiet stretch"));
    expect(items[2]).toMatchObject({ status: "ready", ticked: false, notes: [PIE_COPY.joined] });
    expect(items[2].pie.description).toBe("Lower rate by 7.00 % when occupancy is lower than 25.00 % and when booking today-21 days in advance");
    expect(merged.missing).toBe(0);
    // Split through Flat bump's one line: nothing of it reads, and it is still there, to finish.
    const through = Math.round(middle(3));
    const torn = mergeReads(await readAll([await crop(0, through), await crop(through, 1132 - through)]));
    const plan = planImport(torn, ROOMS, { today: "2026-10-01" });
    expect(plan.items).toHaveLength(7);
    expect(plan.items[3]).toMatchObject({ status: "needs_edit", reason: PIE_COPY.cutOff });
  }, 120_000);

  it("reads two overlapping screenshots: every rule once, as the whole page reads them", async () => {
    const reads = await readAll([await crop(0, 950), await crop(800, 1132 - 800)]);
    const items = planImport(mergeReads(reads), ROOMS, { today: "2026-10-01" }).items;
    const whole = planImport(mergeReads([read]), ROOMS, { today: "2026-10-01" }).items;
    expect(items.map((i) => [i.pie.name, i.status, made(i)])).toEqual(whole.map((i) => [i.pie.name, i.status, made(i)]));
  }, 120_000);

  it("reads a 1x capture closer, and anything it may have misread is left unticked", async () => {
    const [small] = await readAll([readFileSync(PNG_1X)]);
    expect(small.scale).toBe(4);
    expect(small.rows).toHaveLength(7);
    const { items, limits } = planImport(mergeReads([small]), ROOMS, { today: "2026-10-01" });
    const whole = planImport(mergeReads([read]), ROOMS, { today: "2026-10-01" });
    // What would be added as it stands (ticked) is exactly what the retina read makes.
    for (const item of items.filter((i) => i.ticked)) {
      expect(made(item)).toBe(made(whole.items.find((w) => w.pie.name === item.pie.name)!));
    }
    for (const change of limits.changes.filter((c) => c.check === null && c.problem === null)) {
      expect([change.floor, change.ceiling]).toEqual(
        ((c) => [c?.floor, c?.ceiling])(whole.limits.changes.find((w) => w.roomTypeId === change.roomTypeId)),
      );
    }
  }, 120_000);
});
