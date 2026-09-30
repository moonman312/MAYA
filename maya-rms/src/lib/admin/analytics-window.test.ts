import { describe, expect, it } from "vitest";
import { addDays, analyticsHref, analyticsWindow, isoWeekOf, rangeChoices, rangeInWords, validDay } from "./analytics-window";

const TODAY = "2026-09-30"; // a Wednesday

describe("the window a URL asks for", () => {
  it("is the last 30 days without test properties by default", () => {
    expect(analyticsWindow({}, TODAY)).toEqual({ from: "2026-09-01", to: TODAY, includeTest: false });
  });

  it("falls back on a day that doesn't exist rather than failing the page", () => {
    expect(validDay("2026-02-30", "x")).toBe("x");
    expect(validDay("2026-9-1", "x")).toBe("x");
    expect(analyticsWindow({ from: "2026-09-10", to: "nope", test: "1" }, TODAY)).toEqual({ from: "2026-09-10", to: TODAY, includeTest: true });
  });

  it("writes the link the page reads back", () => {
    expect(analyticsHref("2026-09-01", TODAY, false)).toBe("/admin/analytics?from=2026-09-01&to=2026-09-30");
    expect(analyticsHref("2026-09-01", TODAY, true)).toBe("/admin/analytics?from=2026-09-01&to=2026-09-30&test=1");
  });
});

describe("the picker's buttons", () => {
  it("are this week and last week (Monday to Sunday, UTC), then the common windows ending today", () => {
    expect(isoWeekOf(TODAY)).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(rangeChoices(TODAY)).toEqual([
      { label: "This week", from: "2026-09-28", to: "2026-10-04", common: false },
      { label: "Last week", from: "2026-09-21", to: "2026-09-27", common: false },
      { label: "7d", from: "2026-09-24", to: TODAY, common: true },
      { label: "30d", from: "2026-09-01", to: TODAY, common: true },
      { label: "90d", from: addDays(TODAY, -89), to: TODAY, common: true },
    ]);
  });
});

describe("the window in words", () => {
  it("says it the way a person would", () => {
    expect(rangeInWords("2026-09-01", TODAY, TODAY)).toBe("last 30 days");
    expect(rangeInWords("2026-09-24", TODAY, TODAY)).toBe("last 7 days");
    expect(rangeInWords(TODAY, TODAY, TODAY)).toBe("today");
    expect(rangeInWords("2026-09-29", "2026-09-29", TODAY)).toBe("yesterday");
    expect(rangeInWords("2026-09-28", "2026-10-04", TODAY)).toBe("this week");
    expect(rangeInWords("2026-09-21", "2026-09-27", TODAY)).toBe("last week");
    expect(rangeInWords("2026-08-03", "2026-08-14", TODAY)).toBe("Aug 3 to Aug 14");
    expect(rangeInWords("2025-12-20", "2026-01-05", TODAY)).toBe("Dec 20, 2025 to Jan 5");
    expect(rangeInWords("2026-09-03", "2026-09-03", TODAY)).toBe("Sep 3");
  });
});
