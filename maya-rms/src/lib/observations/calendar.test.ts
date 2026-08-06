import { describe, expect, it } from "vitest";
import {
  addDays,
  circularDayDistance,
  dayOfWeek,
  dayOfWeekName,
  dayOfYearIndex,
  daysBetween,
  dowClass,
  easterDate,
  foldedMonthDayKey,
  holidayContextForDate,
  holidayDateInYear,
  holidayPlacement,
  holidaysForYear,
  keyToHuman,
} from "../../../supabase/functions/_shared/observations/calendar";

describe("date math", () => {
  it("computes day of week: the exact case from the design discussion", () => {
    // Same calendar date, different day of week — never comparable.
    expect(dayOfWeekName("2025-07-25")).toBe("Friday");
    expect(dayOfWeekName("2026-07-25")).toBe("Saturday");
  });

  it("classifies Friday and Saturday stays as hotel weekend nights", () => {
    expect(dowClass(5)).toBe("weekend");
    expect(dowClass(6)).toBe("weekend");
    expect(dowClass(0)).toBe("weekday"); // Sunday night is a weekday stay
    expect(dowClass(3)).toBe("weekday");
  });

  it("does date arithmetic across leap days", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2025-02-28", "2025-03-01")).toBe(1);
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("folds February 29 into a stable 365-slot year", () => {
    expect(foldedMonthDayKey("2024-02-29")).toBe("02-28");
    expect(foldedMonthDayKey("2024-03-01")).toBe("03-01");
    expect(dayOfYearIndex("2024-03-01")).toBe(dayOfYearIndex("2025-03-01"));
    expect(dayOfYearIndex("2025-01-01")).toBe(0);
    expect(dayOfYearIndex("2025-12-31")).toBe(364);
  });

  it("measures circular day-of-year distance", () => {
    expect(circularDayDistance(0, 364)).toBe(1);
    expect(circularDayDistance(10, 200)).toBe(175);
    expect(circularDayDistance(100, 100)).toBe(0);
  });

  it("formats keys for humans", () => {
    expect(keyToHuman("06-10")).toBe("June 10");
    expect(keyToHuman("01-01")).toBe("January 1");
  });
});

describe("holiday dates", () => {
  it("computes Easter for known years", () => {
    expect(easterDate(2024)).toBe("2024-03-31");
    expect(easterDate(2025)).toBe("2025-04-20");
    expect(easterDate(2026)).toBe("2026-04-05");
    expect(easterDate(2027)).toBe("2027-03-28");
  });

  it("computes floating holidays", () => {
    expect(holidayDateInYear("thanksgiving", 2024)).toBe("2024-11-28");
    expect(holidayDateInYear("thanksgiving", 2025)).toBe("2025-11-27");
    expect(holidayDateInYear("thanksgiving", 2026)).toBe("2026-11-26");
    expect(holidayDateInYear("memorial_day", 2026)).toBe("2026-05-25");
    expect(holidayDateInYear("labor_day", 2026)).toBe("2026-09-07");
    expect(holidayDateInYear("mlk_day", 2026)).toBe("2026-01-19");
    expect(holidayDateInYear("mothers_day", 2026)).toBe("2026-05-10");
  });

  it("lists a year's holidays in date order", () => {
    const days = holidaysForYear(2026);
    const dates = days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
    expect(days.find((d) => d.key === "independence_day")?.date).toBe("2026-07-04");
  });
});

describe("holiday context", () => {
  it("tags the holiday itself and its influence window by offset", () => {
    expect(holidayContextForDate("2026-11-26")).toMatchObject({
      key: "thanksgiving",
      offset: 0,
    });
    expect(holidayContextForDate("2026-11-25")).toMatchObject({
      key: "thanksgiving",
      offset: -1,
    });
    expect(holidayContextForDate("2026-11-29")).toMatchObject({
      key: "thanksgiving",
      offset: 3,
    });
    expect(holidayContextForDate("2026-11-30")).toBeNull();
  });

  it("bounds the July 4th window", () => {
    expect(holidayContextForDate("2026-07-03")).toMatchObject({
      key: "independence_day",
      offset: -1,
    });
    expect(holidayContextForDate("2026-07-07")).toBeNull();
  });

  it("treats the Christmas to New Year stretch as one connected context", () => {
    expect(holidayContextForDate("2026-12-27")).toMatchObject({ key: "christmas", offset: 2 });
    expect(holidayContextForDate("2026-12-31")).toMatchObject({
      key: "new_years_day",
      offset: -1,
    });
    expect(holidayContextForDate("2027-01-01")).toMatchObject({
      key: "new_years_day",
      offset: 0,
    });
  });

  it("returns null for a plain day", () => {
    expect(holidayContextForDate("2026-08-12")).toBeNull();
  });

  it("classifies placement by the holiday's own weekday that year", () => {
    // July 4th: Saturday 2026, Friday 2025, Thursday 2024, Tuesday 2028.
    expect(holidayContextForDate("2026-07-04")?.placement).toBe("weekend");
    expect(holidayContextForDate("2025-07-04")?.placement).toBe("weekend");
    expect(holidayContextForDate("2024-07-04")?.placement).toBe("bridge");
    expect(holidayContextForDate("2028-07-04")?.placement).toBe("midweek");
    expect(holidayPlacement(dayOfWeek("2026-07-05"))).toBe("weekend"); // Sunday
    expect(holidayPlacement(3)).toBe("midweek");
  });
});
