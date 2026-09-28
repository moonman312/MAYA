/**
 * The docs helper's counts as the Command Center shows them: shares out of
 * everything asked, weeks that start on Monday, and each grouping of the
 * weekly function landing in its own table.
 */
import { describe, expect, it } from "vitest";
import registry from "@/lib/deep-links/registry.json";
import { areaLabel, mondayOf, percent, placeLabel, totalsFrom, weeklyFrom, weeksEndingAt } from "./docs-tally";

describe("totalsFrom", () => {
  it("counts set replies as answered and gives the no-answer share", () => {
    const t = totalsFrom([
      { outcome: "answered", n: 60 },
      { outcome: "canned", n: "20" },
      { outcome: "unsure", n: 10 },
      { outcome: "none", n: 10 },
      { outcome: "spam", n: 999 },
    ]);
    expect(t.asked).toBe(100);
    expect(t.answeredShare).toBe(0.8);
    expect(t.noneShare).toBe(0.1);
    expect(t.byOutcome.none).toBe(10);
  });

  it("has no shares when nothing was asked", () => {
    const t = totalsFrom([]);
    expect(t.asked).toBe(0);
    expect(t.answeredShare).toBeNull();
    expect(percent(t.noneShare)).toBe("-");
  });
});

describe("weeks", () => {
  it("start on Monday, and the last one holds today", () => {
    expect(mondayOf("2026-09-25")).toBe("2026-09-21");
    expect(mondayOf("2026-09-21")).toBe("2026-09-21");
    expect(mondayOf("2026-09-27")).toBe("2026-09-21");
    const w = weeksEndingAt("2026-09-25", 12);
    expect(w).toHaveLength(12);
    expect(w[11]).toBe("2026-09-21");
    expect(w[0]).toBe("2026-07-06");
  });
});

describe("weeklyFrom", () => {
  const weeks = ["2026-09-14", "2026-09-21"];
  const rows = [
    // grouped by outcome and signed in
    { week: "2026-09-21", outcome: "answered", signed_in: true, section: null, app_area: null, n: 5 },
    { week: "2026-09-21", outcome: "none", signed_in: false, section: null, app_area: null, n: "2" },
    { week: "2026-09-14", outcome: "canned", signed_in: false, section: null, app_area: null, n: 3 },
    // grouped by outcome and section
    { week: "2026-09-21", outcome: "answered", signed_in: null, section: "rules", app_area: null, n: 5 },
    { week: "2026-09-21", outcome: "none", signed_in: null, section: "home", app_area: null, n: 2 },
    { week: "2026-09-14", outcome: "canned", signed_in: null, section: "rules", app_area: null, n: 3 },
    // grouped by outcome and app area ('' is "not opened from Help" and is left out)
    { week: "2026-09-21", outcome: "answered", signed_in: null, section: null, app_area: "calendar", n: 4 },
    { week: "2026-09-21", outcome: "none", signed_in: null, section: null, app_area: "", n: 3 },
    // outside the weeks shown
    { week: "2026-01-05", outcome: "none", signed_in: true, section: null, app_area: null, n: 50 },
  ];
  const w = weeklyFrom(rows, weeks);

  it("adds up each week by reply and by signed in or not", () => {
    expect(w.lines.map((l) => [l.week, l.asked, l.signedIn, l.signedOut])).toEqual([
      ["2026-09-14", 3, 0, 3],
      ["2026-09-21", 7, 5, 2],
    ]);
    expect(w.lines[1].byOutcome).toEqual({ answered: 5, canned: 0, unsure: 0, none: 2 });
  });

  it("lists where questions were asked, busiest first, with the no answers", () => {
    expect(w.places.map((p) => [p.label, p.perWeek, p.asked, p.none])).toEqual([
      ["Rules", [3, 5], 8, 0],
      ["Docs home", [0, 2], 2, 2],
    ]);
    expect(w.areas.map((a) => [a.label, a.perWeek])).toEqual([["Calendar", [0, 4]]]);
  });
});

describe("labels", () => {
  it("name every place and every MAYA screen in plain words", () => {
    expect(placeLabel("home")).toBe("Docs home");
    expect(placeLabel("support")).toBe("Support page");
    expect(placeLabel("billing")).toBe("Billing");
    for (const screen of Object.keys(registry.help.screens)) expect(areaLabel(screen)).not.toBe(screen);
  });
});
