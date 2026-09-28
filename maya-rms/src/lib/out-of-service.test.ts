import { describe, expect, it } from "vitest";
import { peakUnitsOut } from "./out-of-service";

describe("peakUnitsOut", () => {
  const row = (start_date: string, end_date: string, units: number) => ({ start_date, end_date, units });

  it("stacks rows that share a night, and not rows that only share the range", () => {
    const rows = [row("2026-10-01", "2026-10-03", 2), row("2026-10-03", "2026-10-05", 1), row("2026-10-07", "2026-10-08", 2)];
    expect(peakUnitsOut(rows, "2026-10-01", "2026-10-08")).toBe(3);
    expect(peakUnitsOut(rows, "2026-10-04", "2026-10-08")).toBe(2);
    expect(peakUnitsOut(rows, "2026-10-06", "2026-10-06")).toBe(0);
  });

  it("is 0 with nothing out", () => {
    expect(peakUnitsOut([], "2026-10-01", "2026-10-31")).toBe(0);
  });
});
