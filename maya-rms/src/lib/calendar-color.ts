/**
 * Property-relative RevPAR coloring for the calendar.
 *
 * Days are judged against their peers rather than fixed occupancy cutoffs:
 * past days against the hotel's historical RevPAR terciles, future days
 * against the on-the-books terciles. OTB revenue naturally grows as arrival
 * nears, so comparing future days to realized history would paint the whole
 * future red.
 */

export type DayColor = "green" | "orange" | "red";

export type TercilePair = { p33: number; p67: number };

export type RevparScale = {
  /** Tercile cutoffs for past days; null = not enough data, everything orange. */
  past: TercilePair | null;
  /** Tercile cutoffs for future days; null = not enough data, everything orange. */
  future: TercilePair | null;
};

export type RevparDatum = {
  /** Stay date (YYYY-MM-DD). */
  date: string;
  revpar: number;
  /** Inside a hotel_closed_periods window — excluded from threshold computation. */
  closed?: boolean;
};

/** Minimum entries a series needs before its terciles are trusted. */
export const MIN_SERIES_DAYS = 10;

/** RevPAR = booked revenue / total property rooms, 2dp. 0 when no rooms. */
export function computeRevpar(revenue: number, totalRooms: number): number {
  if (totalRooms <= 0) return 0;
  return Math.round((revenue / totalRooms) * 100) / 100;
}

/**
 * Percentile with linear interpolation between closest ranks (numpy-style),
 * over an ascending-sorted series.
 */
export function percentileLinear(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const pos = clamped * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (pos - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

/** p33/p67 tercile cutoffs (linear interpolation), rounded to 2dp. */
export function terciles(series: number[]): TercilePair {
  const sorted = [...series].sort((a, b) => a - b);
  return {
    p33: Math.round(percentileLinear(sorted, 1 / 3) * 100) / 100,
    p67: Math.round(percentileLinear(sorted, 2 / 3) * 100) / 100,
  };
}

/**
 * Split a daily RevPAR series at `today` (YYYY-MM-DD): stay dates before
 * today are past, today and later are future. Closed entries are dropped so
 * closures do not drag the thresholds down.
 */
export function splitRevparSeries(
  data: RevparDatum[],
  today: string,
): { past: number[]; future: number[] } {
  const past: number[] = [];
  const future: number[] = [];
  for (const d of data) {
    if (d.closed) continue;
    (d.date < today ? past : future).push(d.revpar);
  }
  return { past, future };
}

/**
 * Build the past/future tercile scale. A side with fewer than
 * MIN_SERIES_DAYS entries falls back to the combined series; when the
 * combined series is also too small the side is null (everything orange).
 */
export function buildRevparScale(pastSeries: number[], futureSeries: number[]): RevparScale {
  const combined = [...pastSeries, ...futureSeries];
  const resolve = (series: number[]): TercilePair | null => {
    if (series.length >= MIN_SERIES_DAYS) return terciles(series);
    if (combined.length >= MIN_SERIES_DAYS) return terciles(combined);
    return null;
  };
  return { past: resolve(pastSeries), future: resolve(futureSeries) };
}

/** Red below p33, orange between, green at/above p67; orange without a scale. */
export function colorForRevpar(revpar: number, pair: TercilePair | null): DayColor {
  if (!pair) return "orange";
  if (revpar < pair.p33) return "red";
  if (revpar < pair.p67) return "orange";
  return "green";
}

/** True when `date` falls inside any [start_date, end_date] period (inclusive). */
export function isDateInPeriods(
  date: string,
  periods: { start_date: string; end_date: string }[],
): boolean {
  return periods.some((p) => date >= p.start_date && date <= p.end_date);
}

/** Response-shaped thresholds; degenerate zeros when a side has no scale. */
export function scaleToThresholds(scale: RevparScale): {
  basis: "revpar";
  past: TercilePair;
  future: TercilePair;
} {
  return {
    basis: "revpar",
    past: scale.past ?? { p33: 0, p67: 0 },
    future: scale.future ?? { p33: 0, p67: 0 },
  };
}
