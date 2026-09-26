// The docs search: one record per page, searched in the browser as you type.
// Shared by the search box and its tests.

import MiniSearch from "minisearch";

export interface SearchPage {
  /** url */
  u: string;
  /** title */
  t: string;
  /** section label */
  s: string;
  /** summary */
  sum: string;
  /** headings and their ids */
  h: string[];
  hid: string[];
  /** keywords, comma separated */
  k: string;
}

export interface SearchResult {
  url: string;
  title: string;
  section: string;
  heading: string | null;
  anchor: string | null;
}

export type DocsSearchIndex = { mini: MiniSearch<SearchPage & { id: number }>; pages: SearchPage[] };

// How many typos the search forgives: a fifth of the word's letters, rounded.
const FUZZY = 0.2;

export function buildSearch(pages: SearchPage[]): DocsSearchIndex {
  const mini = new MiniSearch<SearchPage & { id: number }>({
    fields: ["t", "k", "hs", "sum"],
    extractField: (doc, field) => (field === "hs" ? doc.h.join(" • ") : String((doc as unknown as Record<string, unknown>)[field] ?? "")),
    searchOptions: { boost: { t: 4, k: 3, hs: 2, sum: 1 }, prefix: true, fuzzy: FUZZY },
  });
  mini.addAll(pages.map((p, id) => ({ ...p, id })));
  return { mini, pages };
}

// Words too common to say which heading a question is about.
const STOP_WORDS = new Set(
  "about all also and any are but can could did does for from get had has have how into its just not our out should some than that the their them then there these they this those was were what when where which who why will with would you your".split(" ")
);

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9$%]+/).filter(Boolean);

// Whether adding, dropping or changing at most `max` letters turns a into b.
function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...row) > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

// How well one query term fits one word: 2 for the same word, 1 for a word it
// starts (the reader is still typing), or for a word the search matched that
// is within the search's own typo allowance of it (another ending, or a small
// typo anywhere, "ocupancy" for "occupancy" too).
function fit(term: string, word: string, matched: Set<string>): number {
  if (word === term) return 2;
  if (word.startsWith(term)) return 1;
  if (matched.has(word) && withinEdits(term, word, Math.round(term.length * FUZZY))) return 1;
  return 0;
}

/** The heading that fits the query best, or null when no heading fits it. */
function findHeading(page: SearchPage, queryTerms: string[], matchedTerms: string[]): { heading: string; anchor: string } | null {
  const matched = new Set(matchedTerms.map((t) => t.toLowerCase()));
  const terms = [...new Set(queryTerms.map((t) => t.toLowerCase()))].filter((t) => !/^[a-z]{1,2}$/.test(t) && !STOP_WORDS.has(t));
  const title = words(page.t);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < page.h.length; i++) {
    const heading = words(page.h[i]);
    let score = 0;
    for (const t of terms) {
      const s = Math.max(0, ...heading.map((w) => fit(t, w, matched)));
      // A word the page title also has counts half: the title is why the page
      // came up, and the reader's other words say which part of it they want.
      score += title.some((w) => fit(t, w, matched)) ? s / 2 : s;
    }
    // Ties go to the heading higher up the page.
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best < 0 ? null : { heading: page.h[best], anchor: page.hid[best] };
}

/** Up to `limit` pages, grouped by section (best section first), each with the heading that matched. */
export function searchDocs(index: DocsSearchIndex, query: string, limit = 10): SearchResult[] {
  if (!query.trim()) return [];
  const hits = index.mini.search(query.trim()).slice(0, limit);
  const top = hits.map((h) => {
    const p = index.pages[h.id as number];
    const heading = findHeading(p, h.queryTerms, h.terms);
    return { url: p.u, title: p.t, section: p.s, heading: heading?.heading ?? null, anchor: heading?.anchor ?? null };
  });
  const order: string[] = [];
  for (const r of top) if (!order.includes(r.section)) order.push(r.section);
  return order.flatMap((s) => top.filter((r) => r.section === s));
}
