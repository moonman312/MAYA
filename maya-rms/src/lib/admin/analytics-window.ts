/**
 * The analytics page's window: which UTC days it covers, how its links are
 * written, and how it reads in words. Shared by the page (on the server) and
 * the date picker (in the browser), which is handed the server's "today" so
 * the two never disagree around midnight.
 */

export type AnalyticsWindow = { from: string; to: string; includeTest: boolean };

const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A day from the URL, or the fallback. Shape alone accepts 2026-02-30, which
 * Postgres then rejects mid-query; round-tripping through Date is what makes a
 * hand-edited URL fall back instead of failing the page.
 */
export function validDay(v: string | undefined, fallback: string): string {
  return v && DAY_RX.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : fallback;
}

/** The window a URL asks for: the last 30 days by default, test properties left out. */
export function analyticsWindow(params: { from?: string; to?: string; test?: string }, today: string): AnalyticsWindow {
  return {
    from: validDay(params.from, addDays(today, -29)),
    to: validDay(params.to, today),
    includeTest: params.test === "1",
  };
}

export function analyticsHref(from: string, to: string, includeTest: boolean): string {
  return `/admin/analytics?from=${from}&to=${to}${includeTest ? "&test=1" : ""}`;
}

/** Monday to Sunday in UTC, the same week the walked-away card counts. */
export function isoWeekOf(day: string): { from: string; to: string } {
  const offset = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(day, -offset);
  return { from: monday, to: addDays(monday, 6) };
}

export type RangeChoice = { label: string; from: string; to: string; common: boolean };

/**
 * The picker's buttons. The common ones (the last 7, 30 and 90 days) are
 * fetched ahead so a click on one shows at once.
 */
export function rangeChoices(today: string): RangeChoice[] {
  const thisWeek = isoWeekOf(today);
  const lastWeek = isoWeekOf(addDays(thisWeek.from, -1));
  return [
    { label: "This week", ...thisWeek, common: false },
    { label: "Last week", ...lastWeek, common: false },
    ...[7, 30, 90].map((days) => ({ label: `${days}d`, from: addDays(today, -(days - 1)), to: today, common: true })),
  ];
}

function dayInWords(day: string, today: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const short = `${MONTHS[m - 1]} ${d}`;
  return day.slice(0, 4) === today.slice(0, 4) ? short : `${short}, ${y}`;
}

/** "last 30 days", "this week", "Sep 3 to Sep 14": the window as a person would say it. */
export function rangeInWords(from: string, to: string, today: string): string {
  if (from === to) {
    if (to === today) return "today";
    if (to === addDays(today, -1)) return "yesterday";
    return dayInWords(from, today);
  }
  const thisWeek = isoWeekOf(today);
  if (from === thisWeek.from && to === thisWeek.to) return "this week";
  const lastWeek = isoWeekOf(addDays(thisWeek.from, -1));
  if (from === lastWeek.from && to === lastWeek.to) return "last week";
  if (to === today && from < to) {
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    return `last ${days} days`;
  }
  return `${dayInWords(from, today)} to ${dayInWords(to, today)}`;
}
