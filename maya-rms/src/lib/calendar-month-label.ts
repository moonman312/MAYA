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
