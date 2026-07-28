import { describe, expect, it } from "vitest";
import {
  addDays,
  circularDayDistance,
  dayOfWeek,
  dayOfYearIndex,
} from "../../../supabase/functions/_shared/observations/calendar";
import {
  detectSeasons,
  type DailyDemand,
  type SeasonModel,
} from "../../../supabase/functions/_shared/observations/seasons";
import {
  describeComparableSelection,
  selectComparableDates,
} from "../../../supabase/functions/_shared/observations/comparable-dates";

const NO_MATH_SYMBOLS = /[<>]/;

function beachModel(): SeasonModel {
  const daily: DailyDemand[] = [];
  for (let d = "2023-01-01"; d <= "2025-12-31"; d = addDays(d, 1)) {
    const m = Number(d.slice(5, 7));
    const value = m >= 6 && m <= 8 ? 100 : m === 5 || m === 9 ? 60 : 30;
    daily.push({ stay_date: d, value });
  }
  return detectSeasons(daily);
}

const MODEL = beachModel();

describe("selectComparableDates for plain dates", () => {
  const sel = selectComparableDates("2026-07-25", {
    seasonModel: MODEL,
    historyStart: "2023-06-01",
    historyEnd: "2026-07-20",
  });

  it("only ever matches the same day of week", () => {
    // 2026-07-25 is a Saturday; 2025-07-25 is a Friday and must not appear.
    for (const c of sel.comparables) {
      expect(dayOfWeek(c.date)).toBe(6);
    }
    expect(sel.comparables.map((c) => c.date)).not.toContain("2025-07-25");
  });

  it("prefers the most recent same-season Saturdays", () => {
    expect(sel.comparables[0].date).toBe("2026-07-18");
    expect(sel.comparables.map((c) => c.date)).toContain("2026-07-11");
    expect(sel.comparables).toHaveLength(8);
  });

  it("never uses holiday-context days as comparables for plain days", () => {
    // 2026-07-04 is a Saturday in season — but it's Independence Day.
    expect(sel.comparables.map((c) => c.date)).not.toContain("2026-07-04");
  });

  it("records the assumptions the drill-down will show", () => {
    expect(sel.assumptions.dayOfWeek).toBe("Saturday");
    expect(sel.assumptions.holiday).toBeNull();
    expect(sel.assumptions.seasonLabel).toBe("Peak Season");
    expect(sel.assumptions.relaxed).toBe(false);
  });

  it("skips dates the caller excludes", () => {
    const withExclusion = selectComparableDates("2026-07-25", {
      seasonModel: MODEL,
      historyStart: "2023-06-01",
      historyEnd: "2026-07-20",
      isExcluded: (d) => d === "2026-07-18",
    });
    expect(withExclusion.comparables.map((c) => c.date)).not.toContain("2026-07-18");
  });

  it("is deterministic", () => {
    const again = selectComparableDates("2026-07-25", {
      seasonModel: MODEL,
      historyStart: "2023-06-01",
      historyEnd: "2026-07-20",
    });
    expect(again).toEqual(sel);
  });
});

describe("selectComparableDates for holidays", () => {
  it("matches Thanksgiving to Thanksgiving by offset, never by calendar date", () => {
    const sel = selectComparableDates("2026-11-26", {
      seasonModel: null,
      historyStart: "2023-01-01",
      historyEnd: "2026-11-20",
    });
    expect(sel.comparables.map((c) => c.date)).toEqual([
      "2025-11-27",
      "2024-11-28",
      "2023-11-23",
    ]);
    expect(sel.comparables.map((c) => c.date)).not.toContain("2025-11-26");
    expect(sel.comparables[0].reasons.join(" ")).toContain("Thanksgiving 2025");
    expect(sel.assumptions.holiday?.key).toBe("thanksgiving");
  });

  it("aligns the day after the holiday across years", () => {
    const sel = selectComparableDates("2026-11-27", {
      seasonModel: null,
      historyStart: "2023-01-01",
      historyEnd: "2026-11-20",
    });
    expect(sel.comparables.map((c) => c.date)).toEqual([
      "2025-11-28",
      "2024-11-29",
      "2023-11-24",
    ]);
    expect(sel.comparables[0].reasons.join(" ")).toContain("after the holiday");
  });

  it("prefers years where a fixed holiday landed with similar weekend placement", () => {
    // July 4th: Saturday 2026, Friday 2025 (weekend), Thursday 2024 (bridge).
    const sel = selectComparableDates("2026-07-04", {
      seasonModel: MODEL,
      historyStart: "2023-01-01",
      historyEnd: "2026-06-30",
    });
    expect(sel.comparables[0].date).toBe("2025-07-04");
    expect(sel.comparables[0].reasons).toContain("similar weekend placement");
    const y2024 = sel.comparables.find((c) => c.date === "2024-07-04");
    expect(y2024?.reasons).not.toContain("similar weekend placement");
  });
});

describe("relaxation on thin history", () => {
  it("widens to the same weekend/weekday class and says so", () => {
    const sel = selectComparableDates("2026-07-25", {
      seasonModel: MODEL,
      historyStart: "2026-07-01",
      historyEnd: "2026-07-20",
    });
    expect(sel.assumptions.relaxed).toBe(true);
    const fridays = sel.comparables.filter((c) => c.tier === 2);
    expect(fridays.map((c) => c.date)).toContain("2026-07-17");
    for (const c of fridays) expect(dayOfWeek(c.date)).toBe(5);
    // Tier 2 still refuses holiday context: July 3 is a Friday, but it's
    // inside the Independence Day window.
    expect(sel.comparables.map((c) => c.date)).not.toContain("2026-07-03");
  });

  it("falls back to nearby weeks of prior years without a season model", () => {
    const sel = selectComparableDates("2026-03-15", {
      seasonModel: null,
      historyStart: "2024-01-01",
      historyEnd: "2026-03-10",
    });
    expect(sel.comparables.length).toBeGreaterThan(0);
    const targetIdx = dayOfYearIndex("2026-03-15");
    for (const c of sel.comparables) {
      expect(dayOfWeek(c.date)).toBe(dayOfWeek("2026-03-15"));
      expect(circularDayDistance(dayOfYearIndex(c.date), targetIdx)).toBeLessThanOrEqual(45);
    }
    expect(sel.comparables.map((c) => c.date)).toContain("2026-03-08");
  });
});

describe("describeComparableSelection", () => {
  it("explains a plain-date comparison in words", () => {
    const sel = selectComparableDates("2026-07-25", {
      seasonModel: MODEL,
      historyStart: "2023-06-01",
      historyEnd: "2026-07-20",
    });
    const text = describeComparableSelection(sel);
    expect(text).toContain("We compared this Saturday with other Saturdays");
    expect(text).toContain("Peak Season");
    expect(text).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("explains a holiday comparison and a thin-history widening", () => {
    const holiday = selectComparableDates("2026-11-26", {
      seasonModel: null,
      historyStart: "2023-01-01",
      historyEnd: "2026-11-20",
    });
    expect(describeComparableSelection(holiday)).toContain("Thanksgiving");

    const thin = selectComparableDates("2026-07-25", {
      seasonModel: MODEL,
      historyStart: "2026-07-01",
      historyEnd: "2026-07-20",
    });
    expect(describeComparableSelection(thin)).toContain("widened the comparison");
    expect(describeComparableSelection(thin)).not.toMatch(NO_MATH_SYMBOLS);
  });
});
