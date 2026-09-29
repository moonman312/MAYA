/**
 * The exact moment, in the viewer's own clock with its zone: the PMS tab's
 * Last sync and request times, and the hover on a change log time.
 *
 * Browsers refuse dateStyle/timeStyle alongside timeZoneName (a RangeError),
 * so this spells the parts out. A value that isn't a date comes back as it
 * was rather than as "Invalid Date".
 */
export function formatDisplayTime(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}
