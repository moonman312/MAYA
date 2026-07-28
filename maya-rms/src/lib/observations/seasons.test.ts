import { describe, expect, it } from "vitest";
import {
  addDays,
  dayOfWeek,
  holidayDateInYear,
} from "../../../supabase/functions/_shared/observations/calendar";
import {
  describeSeasonModel,
  detectSeasons,
  seasonForDate,
  type DailyDemand,
} from "../../../supabase/functions/_shared/observations/seasons";

const NO_MATH_SYMBOLS = /[<>]/;

function genDaily(
  from: string,
  to: string,
  fn: (date: string, dow: number) => number,
): DailyDemand[] {
  const out: DailyDemand[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push({ stay_date: d, value: fn(d, dayOfWeek(d)) });
  }
  return out;
}

const month = (date: string) => Number(date.slice(5, 7));

/** Beach resort: summer plateau, spring/fall shoulders, quiet winter. */
function beachValue(date: string): number {
  const m = month(date);
  if (m >= 6 && m <= 8) return 100;
  if (m === 5 || m === 9) return 60;
  return 30;
}

describe("detectSeasons on synthetic hotels", () => {
  it("finds one Year-Round season for a flat hotel", () => {
    const daily = genDaily("2024-01-01", "2025-12-31", () => 50);
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(1);
    expect(model.seasons[0].label).toBe("Year-Round");
    expect(model.seasons[0].meanIndex).toBeCloseTo(1, 1);
  });

  it("finds four seasons for a beach resort, with the winter wrapping the year end", () => {
    const daily = genDaily("2023-01-01", "2025-12-31", (d) => beachValue(d));
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(4);

    const peak = seasonForDate(model, "2025-07-15");
    expect(peak.label).toBe("Peak Season");
    expect(peak.meanIndex).toBeGreaterThan(2.5);
    expect(seasonForDate(model, "2025-06-15").id).toBe(peak.id);
    expect(seasonForDate(model, "2025-08-20").id).toBe(peak.id);

    const low = seasonForDate(model, "2025-01-15");
    expect(low.label).toBe("Low Season");
    // Winter wraps: late December and early January are the same season.
    expect(seasonForDate(model, "2025-12-15").id).toBe(low.id);

    const spring = seasonForDate(model, "2025-05-15");
    const fall = seasonForDate(model, "2025-09-15");
    expect(spring.id).not.toBe(fall.id);
    expect(spring.label).toContain("Shoulder");
    expect(fall.label).toContain("Shoulder");
  });

  it("absorbs a short dip inside a season instead of splitting it", () => {
    const daily = genDaily("2023-01-01", "2025-12-31", (d) => {
      const key = d.slice(5);
      if (key >= "07-10" && key <= "07-14") return 60; // 5-day soft patch
      return beachValue(d);
    });
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(4);
    expect(seasonForDate(model, "2025-07-12").id).toBe(seasonForDate(model, "2025-06-20").id);
  });

  it("finds a ski season that wraps the year end", () => {
    const daily = genDaily("2024-01-01", "2025-12-31", (d) => {
      const m = month(d);
      return m === 12 || m <= 3 ? 100 : 40;
    });
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(2);
    const peak = seasonForDate(model, "2025-01-20");
    expect(peak.label).toBe("Peak Season");
    expect(seasonForDate(model, "2025-12-20").id).toBe(peak.id);
    expect(peak.days).toBeGreaterThan(100);
    expect(peak.days).toBeLessThan(145);
  });

  it("sets aside a one-off festival instead of inventing a season (single year of history)", () => {
    const daily = genDaily("2025-01-01", "2025-12-31", (d) => {
      const key = d.slice(5);
      return key >= "08-10" && key <= "08-23" ? 300 : 50;
    });
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(1);
    expect(model.outlierKeys).toContain("08-15");
    expect(model.outlierKeys.length).toBeGreaterThanOrEqual(10);
  });

  it("lets multi-year medians erase an event that happened only one year", () => {
    const daily = genDaily("2023-01-01", "2025-12-31", (d) => {
      if (d >= "2024-09-05" && d <= "2024-09-25") return 200;
      return 50;
    });
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(1);
  });

  it("does not let a recurring holiday spike become a season", () => {
    const daily = genDaily("2023-01-01", "2025-12-31", (d) => {
      for (const y of [2023, 2024, 2025]) {
        const tg = holidayDateInYear("thanksgiving", y);
        if (d >= addDays(tg, -1) && d <= addDays(tg, 3)) return 250;
      }
      return 50;
    });
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(1);
  });

  it("splits seasons whose LEVEL matches but whose weekly shape flips", () => {
    // Summer: hot weekends, dead weekdays. Rest of year: steady weekdays,
    // soft weekends. Overall averages nearly identical — level-only
    // segmentation would see one flat year.
    const daily = genDaily("2024-01-01", "2025-12-31", (d, dow) => {
      const summer = month(d) >= 6 && month(d) <= 8;
      const weekend = dow === 5 || dow === 6;
      if (summer) return weekend ? 150 : 60;
      return weekend ? 80 : 90;
    });
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(2);

    const summer = seasonForDate(model, "2025-07-15");
    const rest = seasonForDate(model, "2025-02-15");
    expect(summer.id).not.toBe(rest.id);
    expect(summer.dow.weekendLift).toBeGreaterThan(1.5);
    expect(rest.dow.weekendLift).toBeLessThan(1.05);
    // The off season wraps around the year end.
    expect(seasonForDate(model, "2025-11-15").id).toBe(rest.id);

    // Levels are too close for Peak/Low naming — seasons get calendar names.
    expect(summer.label).not.toContain("Peak");
    expect(rest.label).not.toContain("Low");

    const text = describeSeasonModel(model);
    expect(text).toContain("weekends run hotter than weekdays");
    expect(text).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("handles leap-day lookups", () => {
    const daily = genDaily("2023-01-01", "2025-12-31", (d) => beachValue(d));
    const model = detectSeasons(daily);
    expect(seasonForDate(model, "2028-02-29").id).toBe(seasonForDate(model, "2028-02-28").id);
  });

  it("falls back to a single Year-Round season on thin history", () => {
    const daily = genDaily("2025-06-01", "2025-06-30", () => 50);
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(1);
    expect(model.seasons[0].label).toBe("Year-Round");
    expect(model.refined).toBe(false);
  });

  it("describes the beach model in plain words", () => {
    const daily = genDaily("2023-01-01", "2025-12-31", (d) => beachValue(d));
    const text = describeSeasonModel(detectSeasons(daily));
    expect(text).toContain("Peak Season");
    expect(text).toContain("through");
    expect(text).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("is deterministic", () => {
    const daily = genDaily("2023-01-01", "2025-12-31", (d) => beachValue(d));
    expect(detectSeasons(daily)).toEqual(detectSeasons(daily));
  });
});
