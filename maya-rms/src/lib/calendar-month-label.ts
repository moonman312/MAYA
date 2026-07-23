/**
 * Deterministic "Month YYYY" for a UTC calendar month (no Intl), so SSR and
 * browser hydration always match.
 */
const UTC_MONTH_NAMES = [
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

export function formatUtcMonthYear(year: number, month: number): string {
  const m = Math.trunc(month);
  if (m < 1 || m > 12) return String(year);
  return `${UTC_MONTH_NAMES[m - 1]} ${year}`;
}

/**
 * Deterministic "Month D, YYYY" (e.g. "August 4, 2026") — no Intl, so SSR and
 * browser hydration always match. Used for the selected-day detail heading.
 */
export function formatUtcLongDate(year: number, month: number, day: number): string {
  const m = Math.trunc(month);
  if (m < 1 || m > 12) return String(year);
  return `${UTC_MONTH_NAMES[m - 1]} ${Math.trunc(day)}, ${year}`;
}
