/**
 * Slow: the whole screenshot reader with real OCR (tesseract.js under Node,
 * the same English data the browser is served), on a made-up screenshot of
 * PIE's Rules and Alerts page (__fixtures__/synthetic-pie.png, drawn by
 * scripts/pie-synthetic-screenshot.mjs): every rule's name, mode, type,
 * description and switch, the cut-off last row, the limits, and what the
 * import makes of them. A few seconds.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PIE_COPY, planImport, type MayaRoomType } from "./map";
import { mergeReads } from "./merge";
import { nodeOcrWorker } from "./node-ocr.test-support";
import { readScreenshot, type ScreenshotRead } from "./read";

const PNG = path.join(__dirname, "__fixtures__", "synthetic-pie.png");

const ROOMS: MayaRoomType[] = [
  { id: "a0000000-0000-4000-8000-000000000001", name: "Garden Room", counts_as_room: true, floor_price: 80, ceiling_price: 600 },
  { id: "a0000000-0000-4000-8000-000000000002", name: "Tree House - ADA", counts_as_room: true, floor_price: 100, ceiling_price: 1000 },
  { id: "a0000000-0000-4000-8000-000000000003", name: "Loft Suite", counts_as_room: true, floor_price: 180, ceiling_price: 900 },
  { id: "a0000000-0000-4000-8000-000000000004", name: "Bunk Room", counts_as_room: true, floor_price: 40, ceiling_price: 300 },
];

describe("reading a screenshot of PIE's page with real OCR (slow)", () => {
  let ocr: Awaited<ReturnType<typeof nodeOcrWorker>>;
  let read: ScreenshotRead;

  beforeAll(async () => {
    ocr = await nodeOcrWorker();
    const { image, pass } = await ocr.open(readFileSync(PNG));
    read = await readScreenshot(image, pass);
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
      ["Flat bump", "ready", false, true],
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
    expect(limits.changes.map((c) => [c.name, c.floor, c.ceiling, c.from])).toEqual([
      ["Garden Room", 110, 520, "own"],
      ["Tree House - ADA", 240, 1250, "own"],
      ["Bunk Room", 95, 2800, "master"],
    ]);
    expect(limits.unmatched).toEqual([]);
  });
});
