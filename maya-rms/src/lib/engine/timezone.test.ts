/**
 * The hotel-date helpers remember their answers (a run asks the same few
 * again and again: a night's weekday per rule, a fire's hotel day per room
 * type). Remembering must never change an answer: each is checked against
 * the helper as it was before, working it out afresh every time, on both
 * copies of the engine, across time zones with clock changes, a skipped day
 * and quarter-hour offsets.
 */
import { describe, expect, it } from "vitest";
import * as app from "./timezone";
import * as edge from "../../../supabase/functions/_shared/engine/timezone";
import { holidayContextForDate } from "@/lib/observations/calendar";

/** evalIsoToHotelDateString before it remembered anything. */
function freshHotelDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** hotelStayDateIsoWeekday before it remembered anything. */
function freshWeekday(stayYmd: string, timeZone: string): number {
  const [y, m, d] = stayYmd.split("-").map(Number);
  const target = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  let anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  for (let t = Date.UTC(y, m - 1, d - 1); t <= Date.UTC(y, m - 1, d + 2); t += 900_000) {
    if (fmt.format(new Date(t)) === target) {
      anchor = new Date(t);
      break;
    }
  }
  const w = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(anchor);
  return { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }[w] ?? 1;
}

const ZONES = ["America/New_York", "Pacific/Apia", "Pacific/Kiritimati", "Asia/Kathmandu", "Australia/Lord_Howe", "Europe/London", "UTC"];

function days(first: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
}

// Samoa skipped 30 December 2011; the rest cross clock changes both ways.
const DATES = [...days("2011-12-27", 8), ...days("2026-03-06", 5), ...days("2026-10-02", 5), ...days("2026-10-30", 5), "2028-02-29"];

describe.each([
  { name: "app engine", tz: app },
  { name: "edge engine", tz: edge },
])("remembered hotel dates ($name)", ({ tz }) => {
  it("gives each night the weekday it had when worked out afresh, the first time and every time after", () => {
    for (const zone of ZONES) {
      for (const d of DATES) {
        const want = freshWeekday(d, zone);
        expect([tz.hotelStayDateIsoWeekday(d, zone), tz.hotelStayDateIsoWeekday(d, zone)]).toEqual([want, want]);
      }
    }
  });

  it("gives each instant the hotel day it had when worked out afresh, around midnight and clock changes", () => {
    for (const zone of ZONES) {
      for (const d of DATES) {
        for (const hour of [0, 5, 9, 10, 11, 13, 14, 23]) {
          for (const iso of [`${d}T${String(hour).padStart(2, "0")}:59:59.999Z`, `${d}T${String(hour).padStart(2, "0")}:00:00+00:00`]) {
            const want = freshHotelDate(iso, zone);
            expect([tz.evalIsoToHotelDateString(iso, zone), tz.evalIsoToHotelDateString(iso, zone)]).toEqual([want, want]);
          }
        }
      }
    }
  });

  it("stays right past the point where it forgets and starts again", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 25_000; i++) {
      const iso = new Date(start + i * 3_601_000).toISOString();
      if (i % 997 === 0) expect(tz.evalIsoToHotelDateString(iso, "America/New_York")).toBe(freshHotelDate(iso, "America/New_York"));
      else tz.evalIsoToHotelDateString(iso, "America/New_York");
    }
    expect(tz.evalIsoToHotelDateString("2026-10-01T03:59:59.000Z", "America/New_York")).toBe("2026-09-30");
    expect(tz.hotelStayDateIsoWeekday("2026-10-01", "America/New_York")).toBe(4);
  });

  it("refuses a time zone that doesn't exist every time it is asked, as it did", () => {
    expect(() => tz.evalIsoToHotelDateString("2026-10-01T12:00:00Z", "Mars/Olympus")).toThrow(RangeError);
    expect(() => tz.evalIsoToHotelDateString("2026-10-01T12:00:00Z", "Mars/Olympus")).toThrow(RangeError);
    expect(() => tz.hotelStayDateIsoWeekday("2026-10-01", "Mars/Olympus")).toThrow(RangeError);
    expect(() => tz.hotelStayDateIsoWeekday("2026-10-01", "Mars/Olympus")).toThrow(RangeError);
  });

  it("finds the start of a hotel day as before", () => {
    expect(tz.hotelDayStartIso("2026-10-01", "America/New_York")).toBe("2026-10-01T04:00:00.000Z");
    expect(tz.hotelDayStartIso("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z");
    expect(tz.hotelDayStartIso("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00.000Z");
    expect(tz.hotelDayStartIso("2026-10-01", "Asia/Kathmandu")).toBe("2026-09-30T18:15:00.000Z");
  });
});

describe("remembered holidays", () => {
  it("answers a date the same way every time, and a caller changing its answer changes no one else's", () => {
    const first = holidayContextForDate("2026-12-24");
    expect(first).toMatchObject({ key: "christmas", offset: -1, holidayDate: "2026-12-25" });
    first!.label = "changed";
    first!.offset = 99;
    expect(holidayContextForDate("2026-12-24")).toEqual({ ...first, label: "Christmas", offset: -1 });
    expect(holidayContextForDate("2026-08-12")).toBeNull();
    expect(holidayContextForDate("2026-08-12")).toBeNull();
  });
});
