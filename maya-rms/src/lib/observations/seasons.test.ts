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
import { dailyPaceSeries } from "../../../supabase/functions/_shared/observations/booking-pace";
import type { SlimReservationRow } from "../../../supabase/functions/_shared/observations/booking-rows";

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

describe("a real, unevenly-spaced nine-season property", () => {
  // A concrete property Jake described: nine non-uniform demand windows,
  // including a genuinely short (10-day) holiday-week regime nested between
  // two much longer, much quieter stretches. Nothing about season detection
  // should assume four evenly-spaced seasons, a minimum length longer than
  // ten days, or a cap anywhere near nine — this is what "let the data
  // decide" has to actually handle.
  function nineSeasonValue(date: string): number {
    const key = date.slice(5);
    if (key >= "07-01" && key <= "07-30") return 100; // Jul 1 - Jul 30
    if (key >= "08-01" && key <= "09-15") return 60; // Aug 1 - Sep 15
    if (key >= "09-16" && key <= "10-31") return 30; // Sep 16 - Oct 31
    if (key >= "11-01" && key <= "12-23") return 15; // Nov 1 - Dec 23
    if (key >= "12-24" || key <= "01-02") return 50; // Dec 24 - Jan 2 (10 days, wraps)
    if (key >= "01-03" && key <= "02-12") return 15; // Jan 3 - Feb 12
    if (key >= "02-13" && key <= "04-30") return 35; // Feb 13 - Apr 30
    if (key >= "05-01" && key <= "05-24") return 55; // May 1 - May 24
    return 75; // May 25 - Jun 30
  }

  it("finds all nine seasons, including the short holiday week, once corroborated across years", () => {
    const daily = genDaily("2022-01-01", "2025-12-31", (d) => nineSeasonValue(d));
    const model = detectSeasons(daily);
    expect(model.seasons).toHaveLength(9);

    const holidayWeek = seasonForDate(model, "2025-12-28");
    expect(holidayWeek.days).toBeLessThanOrEqual(15);
    expect(holidayWeek.meanIndex).toBeGreaterThan(seasonForDate(model, "2025-12-10").meanIndex);
    expect(holidayWeek.meanIndex).toBeGreaterThan(seasonForDate(model, "2026-01-10").meanIndex);
    // The holiday week sits between two distinct, quieter neighbors, not
    // absorbed into either.
    expect(seasonForDate(model, "2025-12-10").id).not.toBe(holidayWeek.id);
    expect(seasonForDate(model, "2026-01-10").id).not.toBe(holidayWeek.id);

    // Every other described window resolves to its own season too.
    const julPeak = seasonForDate(model, "2025-07-15");
    const augShoulder = seasonForDate(model, "2025-08-20");
    const fallShoulder = seasonForDate(model, "2025-10-15");
    const novLow = seasonForDate(model, "2025-11-15");
    const janLow = seasonForDate(model, "2026-01-20");
    const springShoulder = seasonForDate(model, "2026-03-15");
    const mayShoulder = seasonForDate(model, "2026-05-10");
    const juneRamp = seasonForDate(model, "2026-06-15");
    const ids = new Set(
      [julPeak, augShoulder, fallShoulder, novLow, holidayWeek, janLow, springShoulder, mayShoulder, juneRamp].map(
        (s) => s.id,
      ),
    );
    expect(ids.size).toBe(9);
  });

  it("does not invent the holiday week from a single year", () => {
    const daily = genDaily("2025-01-01", "2025-12-31", (d) => nineSeasonValue(d));
    const model = detectSeasons(daily);
    // One year alone can't corroborate a 10-day regime against a one-off
    // event — it should fall back to fewer, cruder seasons rather than
    // confidently declaring a pattern from a single occurrence.
    expect(model.seasons.length).toBeLessThan(9);
  });
});

describe("booking pace as a third season signal", () => {
  // The sellout-blindness problem: a period sold out at a premium and a
  // period sold out at a discount read identically in occupancy — and so
  // do a period that filled six weeks out and one that filled in the final
  // days. Here both regimes end at 19 of 20 rooms every night (level and
  // weekly shape are dead flat all year); only WHEN the bookings arrived
  // differs. Occupancy alone must see one season; pace must split them.
  const CAPACITY = 20;
  const FAST_WINDOWS = [80, 75, 70, 65, 60, 55, 50, 45, 40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20];
  const SLOW_WINDOWS = [7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 0, 0, 0];

  function build(): { daily: DailyDemand[]; rows: SlimReservationRow[] } {
    const daily: DailyDemand[] = [];
    const rows: SlimReservationRow[] = [];
    for (let d = "2024-01-01"; d <= "2025-12-31"; d = addDays(d, 1)) {
      const m = month(d);
      const fast = m >= 3 && m <= 6;
      daily.push({ stay_date: d, value: 19 });
      for (const bw of fast ? FAST_WINDOWS : SLOW_WINDOWS) {
        rows.push({ stay_date: d, booking_window_days: bw });
      }
    }
    return { daily, rows };
  }

  it("splits two near-sellout regimes that occupancy alone cannot tell apart", () => {
    const { daily, rows } = build();

    const withoutPace = detectSeasons(daily);
    expect(withoutPace.seasons).toHaveLength(1); // occupancy is blind here

    const model = detectSeasons(daily, { pace: dailyPaceSeries(rows, CAPACITY) });
    expect(model.seasons).toHaveLength(2);

    const fastSeason = seasonForDate(model, "2025-04-15");
    const slowSeason = seasonForDate(model, "2025-09-15");
    expect(fastSeason.id).not.toBe(slowSeason.id);
    expect(fastSeason.paceIndex!).toBeGreaterThan(slowSeason.paceIndex!);
    // The slow regime wraps the year end.
    expect(seasonForDate(model, "2025-01-15").id).toBe(slowSeason.id);

    const text = describeSeasonModel(model);
    expect(text).toContain("books up earlier than the rest of your year");
    expect(text).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("ignores a pace series too sparse to trust", () => {
    const { daily, rows } = build();
    const sparse = dailyPaceSeries(rows, CAPACITY).slice(0, 10);
    const model = detectSeasons(daily, { pace: sparse });
    expect(model.seasons).toHaveLength(1);
    expect(model.seasons[0].paceIndex).toBeUndefined();
  });
});
