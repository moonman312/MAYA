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

  it("anchors New Year's Eve on the correct prior years, not one year too far back", () => {
    // Dec 31 sits 1 day before the NEXT calendar year's New Year's Day —
    // closer than Christmas — so holidayContextForDate anchors it on
    // year+1. Anchoring candidates on the target's own calendar year
    // instead of the holiday's actual year skipped the most recent real
    // NYE and reached an extra year further back than intended.
    const sel = selectComparableDates("2026-12-31", {
      seasonModel: null,
      historyStart: "2018-01-01",
      historyEnd: "2026-12-20",
    });
    expect(sel.comparables.map((c) => c.date)).toEqual([
      "2025-12-31",
      "2024-12-31",
      "2023-12-31",
    ]);
    // The label names the New Year's Day instance the candidate is offset
    // from (Dec 31 2025 is "1 day before" New Year's Day 2026) — internally
    // consistent, unlike the bug, which named a holiday year that didn't
    // match either the candidate's date or the anchor actually used.
    expect(sel.comparables[0].reasons.join(" ")).toContain("New Year's Day 2026");
    expect(sel.comparables[1].reasons.join(" ")).toContain("New Year's Day 2025");
  });

  it("still selects New Year's Day comparables correctly (control — not shifted)", () => {
    const sel = selectComparableDates("2027-01-01", {
      seasonModel: null,
      historyStart: "2018-01-01",
      historyEnd: "2026-12-20",
    });
    expect(sel.comparables.map((c) => c.date)).toEqual([
      "2026-01-01",
      "2025-01-01",
      "2024-01-01",
    ]);
  });

  it("demotes (never hard-rejects) a candidate that lands on a different holiday's peak day", () => {
    // 2028-06-20 is Juneteenth+1. Its reconstructed candidates in 2027 and
    // 2026 land on/beside Father's Day instead — a different demand driver
    // — and must not outrank the genuine same-holiday 2025 comparable.
    const sel = selectComparableDates("2028-06-20", {
      seasonModel: null,
      historyStart: "2023-01-01",
      historyEnd: "2027-12-31",
    });
    const byDate = new Map(sel.comparables.map((c) => [c.date, c]));
    const crossYear = byDate.get("2027-06-20");
    const sameHolidayYear = byDate.get("2025-06-20");
    expect(crossYear?.tier).toBe(2);
    expect(crossYear?.reasons.join(" ")).toMatch(/Father's Day/i);
    expect(sameHolidayYear?.tier).toBe(1);
    // The genuine same-holiday comparable must outrank the cross-holiday one.
    expect(sameHolidayYear!.score).toBeGreaterThan(crossYear!.score);
  });
});

describe("yearsAgoText never claims a comparable is 'this year' when it isn't", () => {
  it("labels a prior-calendar-year comparable correctly even under the old 320-day bucket", () => {
    // Year-Round model: target 2026-03-02, closest same-DOW comparables
    // land ~245 days back in 2025 — a different calendar year, but under
    // the old day-count threshold that used to say "earlier this year".
    const flat: DailyDemand[] = [];
    for (let d = "2022-01-01"; d <= "2026-02-28"; d = addDays(d, 1)) {
      flat.push({ stay_date: d, value: 50 });
    }
    const model = detectSeasons(flat);
    const sel = selectComparableDates("2026-03-02", {
      seasonModel: model,
      historyStart: "2022-01-01",
      historyEnd: "2025-06-30",
    });
    const priorYear = sel.comparables.find((c) => c.date.startsWith("2025-"));
    expect(priorYear).toBeDefined();
    expect(priorYear!.reasons.join(" ")).not.toContain("earlier this year");
    expect(priorYear!.reasons.join(" ")).toContain("about a year earlier");
  });

  it("does not say 'about a year earlier' for a candidate that is only weeks away but crosses Jan 1", () => {
    // The most mundane case: pricing Jan 5 on Jan 1, closest same-Monday
    // comparable is Dec 22 the year before — 14 days away, a different
    // calendar year. Calling that "about a year earlier" would be its own
    // false claim in the opposite direction.
    const flat: DailyDemand[] = [];
    for (let d = "2022-01-01"; d <= "2025-12-31"; d = addDays(d, 1)) {
      flat.push({ stay_date: d, value: 50 });
    }
    const model = detectSeasons(flat);
    const sel = selectComparableDates("2026-01-05", {
      seasonModel: model,
      historyStart: "2022-01-01",
      historyEnd: "2025-12-31",
    });
    const nearTerm = sel.comparables.find((c) => c.date === "2025-12-22");
    expect(nearTerm).toBeDefined();
    expect(nearTerm!.reasons.join(" ")).not.toContain("earlier this year");
    expect(nearTerm!.reasons.join(" ")).not.toContain("a year earlier");
    expect(nearTerm!.reasons.join(" ")).toContain("recently");
  });

  it("says an exact number of years, not 'about', once the gap is unambiguous", () => {
    const flat: DailyDemand[] = [];
    for (let d = "2020-01-01"; d <= "2024-08-25"; d = addDays(d, 1)) {
      flat.push({ stay_date: d, value: 50 });
    }
    const model = detectSeasons(flat);
    const sel = selectComparableDates("2026-03-02", {
      seasonModel: model,
      historyStart: "2020-01-01",
      historyEnd: "2024-08-25",
    });
    const twoYearsBack = sel.comparables.find((c) => c.date.startsWith("2024-"));
    expect(twoYearsBack).toBeDefined();
    expect(twoYearsBack!.reasons.join(" ")).toContain("2 years earlier");
  });

  it("still says 'earlier this year' for a genuine same-calendar-year comparable", () => {
    const flat: DailyDemand[] = [];
    for (let d = "2024-01-01"; d <= "2026-10-01"; d = addDays(d, 1)) {
      flat.push({ stay_date: d, value: 50 });
    }
    const model = detectSeasons(flat);
    const sel = selectComparableDates("2026-11-02", {
      seasonModel: model,
      historyStart: "2024-01-01",
      historyEnd: "2026-10-01",
    });
    const sameYear = sel.comparables.find((c) => c.date.startsWith("2026-"));
    expect(sameYear).toBeDefined();
    expect(sameYear!.reasons.join(" ")).toContain("earlier this year");
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
