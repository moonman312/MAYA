/**
 * Calendar intelligence for the Observation Engine.
 *
 * Everything here answers one question for the comparable-date matcher:
 * "what kind of day is this?" — day of week, weekend vs weekday, and holiday
 * context. Holidays are matched by identity and offset, never by calendar
 * date: the Saturday after Thanksgiving 2026 compares to the Saturday after
 * Thanksgiving 2025, even though the dates differ by days. Fixed-date
 * holidays (July 4th) additionally carry a placement class, because the same
 * holiday behaves differently when it lands on a Saturday than on a
 * Wednesday.
 *
 * Pure functions only — no clocks, no I/O. All dates are YYYY-MM-DD strings
 * interpreted as calendar dates (UTC math internally).
 */

/* ── Basic date math ─────────────────────────────────────────── */

export const DOW_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const DAY_MS = 86_400_000;

function toUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** 0 = Sunday .. 6 = Saturday. */
export function dayOfWeek(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function dayOfWeekName(date: string): string {
  return DOW_NAMES[dayOfWeek(date)];
}

export type DowClass = "weekend" | "weekday";

/** Hotel weekend nights are Friday and Saturday stays. */
export function dowClass(dow: number): DowClass {
  return dow === 5 || dow === 6 ? "weekend" : "weekday";
}

/* ── Day-of-year keys (leap-safe) ────────────────────────────── */

/**
 * "MM-DD" key with February 29 folded into February 28, so every date maps
 * onto a stable 365-slot year regardless of leap years.
 */
export function foldedMonthDayKey(date: string): string {
  const key = date.slice(5);
  return key === "02-29" ? "02-28" : key;
}

/** The 365 folded keys in calendar order, "01-01" .. "12-31". */
export const YEAR_KEYS: string[] = (() => {
  const keys: string[] = [];
  for (let d = toUtcMs("2001-01-01"); d <= toUtcMs("2001-12-31"); d += DAY_MS) {
    keys.push(fromUtcMs(d).slice(5));
  }
  return keys;
})();

const KEY_INDEX = new Map(YEAR_KEYS.map((k, i) => [k, i]));

/** 0..364 slot for a date, leap-folded. */
export function dayOfYearIndex(date: string): number {
  return KEY_INDEX.get(foldedMonthDayKey(date))!;
}

/** 0..364 slot for an already-folded "MM-DD" key. */
export function foldedKeyIndex(key: string): number {
  return KEY_INDEX.get(key)!;
}

/** Shortest circular distance between two year slots, in days. */
export function circularDayDistance(idxA: number, idxB: number): number {
  const d = Math.abs(idxA - idxB);
  return Math.min(d, 365 - d);
}

/** "06-10" → "June 10" for explanations. */
export function keyToHuman(key: string): string {
  const [m, d] = key.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}`;
}

/* ── Holidays ────────────────────────────────────────────────── */

export type HolidayPlacement = "weekend" | "bridge" | "midweek";

/**
 * How a holiday's own weekday shapes the surrounding demand: landing on or
 * next to the weekend makes a long weekend, Monday/Thursday makes a bridge
 * day, Tuesday/Wednesday splits the week.
 */
export function holidayPlacement(dow: number): HolidayPlacement {
  if (dow === 5 || dow === 6 || dow === 0) return "weekend";
  if (dow === 1 || dow === 4) return "bridge";
  return "midweek";
}

export interface HolidayDef {
  key: string;
  label: string;
  date: (year: number) => string;
  /** Days of demand influence on each side of the holiday. */
  influence: { before: number; after: number };
}

function fixed(month: number, day: number): (year: number) => string {
  return (year) =>
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nthWeekdayOfMonth(year: number, month: number, dow: number, n: number): string {
  const firstDow = dayOfWeek(fixed(month, 1)(year));
  const day = 1 + ((dow - firstDow + 7) % 7) + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastWeekdayOfMonth(year: number, month: number, dow: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return addDays(last, -((dayOfWeek(last) - dow + 7) % 7));
}

/** Gregorian Easter (Meeus/Jones/Butcher). */
export function easterDate(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * US holiday set, v1. Table order is the tie-break when a date sits equally
 * close to two holidays. Christmas's influence runs through New Year's Eve
 * so the whole holiday stretch is treated as special.
 */
export const HOLIDAYS: HolidayDef[] = [
  { key: "new_years_day", label: "New Year's Day", date: fixed(1, 1), influence: { before: 1, after: 1 } },
  { key: "mlk_day", label: "Martin Luther King Jr. Day", date: (y) => nthWeekdayOfMonth(y, 1, 1, 3), influence: { before: 3, after: 1 } },
  { key: "valentines_day", label: "Valentine's Day", date: fixed(2, 14), influence: { before: 1, after: 1 } },
  { key: "presidents_day", label: "Presidents' Day", date: (y) => nthWeekdayOfMonth(y, 2, 1, 3), influence: { before: 3, after: 1 } },
  { key: "st_patricks_day", label: "St. Patrick's Day", date: fixed(3, 17), influence: { before: 1, after: 1 } },
  { key: "easter", label: "Easter", date: easterDate, influence: { before: 2, after: 1 } },
  { key: "mothers_day", label: "Mother's Day", date: (y) => nthWeekdayOfMonth(y, 5, 0, 2), influence: { before: 2, after: 0 } },
  { key: "memorial_day", label: "Memorial Day", date: (y) => lastWeekdayOfMonth(y, 5, 1), influence: { before: 3, after: 1 } },
  { key: "fathers_day", label: "Father's Day", date: (y) => nthWeekdayOfMonth(y, 6, 0, 3), influence: { before: 2, after: 0 } },
  { key: "juneteenth", label: "Juneteenth", date: fixed(6, 19), influence: { before: 1, after: 1 } },
  { key: "independence_day", label: "Independence Day", date: fixed(7, 4), influence: { before: 2, after: 2 } },
  { key: "labor_day", label: "Labor Day", date: (y) => nthWeekdayOfMonth(y, 9, 1, 1), influence: { before: 3, after: 1 } },
  { key: "indigenous_peoples_day", label: "Indigenous Peoples' Day", date: (y) => nthWeekdayOfMonth(y, 10, 1, 2), influence: { before: 3, after: 1 } },
  { key: "halloween", label: "Halloween", date: fixed(10, 31), influence: { before: 1, after: 1 } },
  { key: "veterans_day", label: "Veterans Day", date: fixed(11, 11), influence: { before: 1, after: 1 } },
  { key: "thanksgiving", label: "Thanksgiving", date: (y) => nthWeekdayOfMonth(y, 11, 4, 4), influence: { before: 1, after: 3 } },
  { key: "christmas", label: "Christmas", date: fixed(12, 25), influence: { before: 1, after: 7 } },
];

const HOLIDAY_INDEX = new Map(HOLIDAYS.map((h, i) => [h.key, i]));

export function holidayDateInYear(key: string, year: number): string {
  const def = HOLIDAYS[HOLIDAY_INDEX.get(key)!];
  return def.date(year);
}

export function holidaysForYear(year: number): { key: string; label: string; date: string }[] {
  return HOLIDAYS.map((h) => ({ key: h.key, label: h.label, date: h.date(year) })).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

export interface HolidayContext {
  key: string;
  label: string;
  /** Days from the holiday itself: 0 = the day, -1 = day before, 2 = two after. */
  offset: number;
  /** Placement class of the holiday's own weekday in that year. */
  placement: HolidayPlacement;
  /** The holiday's date in the target's year frame. */
  holidayDate: string;
}

/**
 * The holiday whose influence window covers `date`, or null. When two
 * windows overlap (Christmas through New Year's), the nearer holiday wins;
 * exact ties fall to table order.
 */
export function holidayContextForDate(date: string): HolidayContext | null {
  const year = Number(date.slice(0, 4));
  let best: (HolidayContext & { dist: number; order: number }) | null = null;
  for (const y of [year - 1, year, year + 1]) {
    for (let i = 0; i < HOLIDAYS.length; i++) {
      const def = HOLIDAYS[i];
      const hd = def.date(y);
      const offset = daysBetween(hd, date);
      if (offset < -def.influence.before || offset > def.influence.after) continue;
      const dist = Math.abs(offset);
      if (
        best === null ||
        dist < best.dist ||
        (dist === best.dist && i < best.order)
      ) {
        best = {
          key: def.key,
          label: def.label,
          offset,
          placement: holidayPlacement(dayOfWeek(hd)),
          holidayDate: hd,
          dist,
          order: i,
        };
      }
    }
  }
  if (!best) return null;
  return {
    key: best.key,
    label: best.label,
    offset: best.offset,
    placement: best.placement,
    holidayDate: best.holidayDate,
  };
}
