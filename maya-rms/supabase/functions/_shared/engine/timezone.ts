/**
 * Hotel-local calendar semantics — Implementation Guide §4.4, §5.1.
 * Deno-portable copy of src/lib/engine/timezone.ts (identical; no imports).
 */

const ymdFormatters = new Map<string, Intl.DateTimeFormat>();

/** The YYYY-MM-DD formatter for a time zone, made once (a bad zone throws, every time). */
function ymdFormatter(hotelTimeZone: string): Intl.DateTimeFormat {
  let fmt = ymdFormatters.get(hotelTimeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: hotelTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    ymdFormatters.set(hotelTimeZone, fmt);
  }
  return fmt;
}

/**
 * Answers already worked out, per time zone and input: each is a pure
 * function of the two, asked again and again in a run (a night's weekday per
 * rule, a fire's hotel day per room type), and making a formatter and
 * scanning a day for it cost far more than the lookup. Emptied when large,
 * like hotelDayStartIso's.
 */
const hotelDateCache = new Map<string, string>();
const weekdayCache = new Map<string, number>();
const MEMO_LIMIT = 20_000;

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= MEMO_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

/** Format an ISO timestamp as YYYY-MM-DD in the hotel's timezone. */
export function evalIsoToHotelDateString(isoEvalTs: string, hotelTimeZone: string): string {
  const key = `${hotelTimeZone}|${isoEvalTs}`;
  const hit = hotelDateCache.get(key);
  if (hit !== undefined) return hit;
  return remember(hotelDateCache, key, ymdFormatter(hotelTimeZone).format(new Date(isoEvalTs)));
}

/**
 * Find a UTC instant whose calendar date in `hotelTimeZone` equals `stayYmd`.
 * Used for weekday (DOW) checks at local civil midnight context.
 */
export function utcInstantForHotelCalendarDate(stayYmd: string, hotelTimeZone: string): Date {
  const [ys, ms, ds] = stayYmd.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  const target = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const fmt = ymdFormatter(hotelTimeZone);
  const start = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  const end = Date.UTC(y, m - 1, d + 2, 0, 0, 0);
  for (let t = start; t <= end; t += 900_000) {
    if (fmt.format(new Date(t)) === target) {
      return new Date(t);
    }
  }
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

const dayStartCache = new Map<string, string>();

/**
 * The instant hotel day `ymd` begins at the property, as an ISO string: its
 * local midnight, or on a day whose midnight a clock change skips, the first
 * moment of that date. Pickup count windows and rule waits count whole hotel
 * days (Jake, 2026-09-28), so this is where they open and end. Exact for
 * every zone whose offset is a whole number of quarter hours (all of them
 * today). Memoized: a run asks for the same few days over and over.
 */
export function hotelDayStartIso(ymd: string, hotelTimeZone: string): string {
  const key = `${hotelTimeZone}|${ymd}`;
  const hit = dayStartCache.get(key);
  if (hit !== undefined) return hit;
  const fmt = ymdFormatter(hotelTimeZone);
  const [y, m, d] = ymd.split("-").map(Number);
  // Local midnight lies within 14 hours of UTC midnight either way.
  const from = Date.UTC(y, m - 1, d) - 15 * 3_600_000;
  const to = Date.UTC(y, m - 1, d) + 15 * 3_600_000;
  let found = Date.UTC(y, m - 1, d);
  for (let t = from; t <= to; t += 900_000) {
    if (fmt.format(new Date(t)) === ymd) {
      found = t;
      break;
    }
  }
  const out = new Date(found).toISOString();
  if (dayStartCache.size > 5000) dayStartCache.clear();
  dayStartCache.set(key, out);
  return out;
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * ISO weekday 1 = Monday … 7 = Sunday for `stayYmd` as a hotel-local civil date.
 */
export function hotelStayDateIsoWeekday(stayYmd: string, hotelTimeZone: string): number {
  const key = `${hotelTimeZone}|${stayYmd}`;
  const hit = weekdayCache.get(key);
  if (hit !== undefined) return hit;
  const anchor = utcInstantForHotelCalendarDate(stayYmd, hotelTimeZone);
  let weekdayFmt = weekdayFormatters.get(hotelTimeZone);
  if (!weekdayFmt) {
    weekdayFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: hotelTimeZone,
      weekday: "long",
    });
    weekdayFormatters.set(hotelTimeZone, weekdayFmt);
  }
  const w = weekdayFmt.format(anchor);
  const map: Record<string, number> = {
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
    Sunday: 7,
  };
  return remember(weekdayCache, key, map[w] ?? 1);
}

/** Add whole calendar days to a YYYY-MM-DD string (Gregorian, UTC-safe components). */
export function addCalendarDays(ymd: string, days: number): string {
  const [ys, ms, ds] = ymd.split("-").map(Number);
  const t = Date.UTC(ys, ms - 1, ds) + days * 86_400_000;
  const nd = new Date(t);
  const y = nd.getUTCFullYear();
  const m = nd.getUTCMonth() + 1;
  const d = nd.getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
