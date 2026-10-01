/**
 * Paging back through history, for the change log and a rule's fire log
 * (Jake's A47: records are kept 90 days, and an "Older" button reaches them).
 *
 * Both work the same way: the newest page comes first, a page that is not
 * the last names where the next, older one starts (an opaque `older`
 * cursor), and asking with `?older=<cursor>` returns that page. The change
 * log hands its cursor out in the X-Changelog-Older header, so its body stays
 * the plain list of items every caller already reads; the fire log carries it
 * in its body. Client-safe.
 */

/** The change log's header naming where the next, older page starts; absent on the last page. */
export const CHANGELOG_OLDER_HEADER = "X-Changelog-Older";

/**
 * The instant just after `at` to the millisecond, for a read that must take
 * everything at or before `at` as the page above judged it (by Date.parse,
 * to the millisecond) when the database keeps microseconds.
 */
export function justAfter(at: string): string {
  return new Date(Date.parse(at) + 1).toISOString();
}

/** One page of the change log: its items, and where the next one starts. */
export type ChangelogPage<T> = { items: T[]; older: string | null };

/**
 * GET /api/changelog, or the page older than `older`. Throws on a failed
 * request, as the dashboard's other reads do.
 */
export async function fetchChangelogPage<T>(older: string | null = null): Promise<ChangelogPage<T>> {
  const url = older ? `/api/changelog?older=${encodeURIComponent(older)}` : "/api/changelog";
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  const items = (await res.json()) as T[];
  return { items, older: res.headers.get(CHANGELOG_OLDER_HEADER) };
}
