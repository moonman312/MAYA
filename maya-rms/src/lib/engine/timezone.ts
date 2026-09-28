/**
 * Hotel-local calendar semantics — Implementation Guide §4.4, §5.1.
 *
 * Stay dates are YYYY-MM-DD civil dates for the property. Evaluation instant
 * is converted to the hotel's local calendar date via IANA timezone.
 */

/** Format an ISO timestamp as YYYY-MM-DD in the hotel's timezone. */
export function evalIsoToHotelDateString(isoEvalTs: string, hotelTimeZone: string): string {
  const d = new Date(isoEvalTs);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: hotelTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
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
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: hotelTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
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
const ymdFormatters = new Map<string, Intl.DateTimeFormat>();

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

/**
 * ISO weekday 1 = Monday … 7 = Sunday for `stayYmd` as a hotel-local civil date.
 */
export function hotelStayDateIsoWeekday(stayYmd: string, hotelTimeZone: string): number {
  const anchor = utcInstantForHotelCalendarDate(stayYmd, hotelTimeZone);
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: hotelTimeZone,
    weekday: "long",
  }).format(anchor);
  const map: Record<string, number> = {
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
    Sunday: 7,
  };
  return map[w] ?? 1;
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
