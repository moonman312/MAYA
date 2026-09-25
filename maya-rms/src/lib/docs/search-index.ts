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

export function buildSearch(pages: SearchPage[]): DocsSearchIndex {
  const mini = new MiniSearch<SearchPage & { id: number }>({
    fields: ["t", "k", "hs", "sum"],
    extractField: (doc, field) => (field === "hs" ? doc.h.join(" • ") : String((doc as unknown as Record<string, unknown>)[field] ?? "")),
    searchOptions: { boost: { t: 4, k: 3, hs: 2, sum: 1 }, prefix: true, fuzzy: 0.2 },
  });
  mini.addAll(pages.map((p, id) => ({ ...p, id })));
  return { mini, pages };
}

function findHeading(page: SearchPage, terms: string[]): { heading: string; anchor: string } | null {
  for (let i = 0; i < page.h.length; i++) {
    const words = page.h[i].toLowerCase().split(/[^a-z0-9$%]+/);
    if (terms.some((t) => words.some((w) => w.startsWith(t.toLowerCase())))) return { heading: page.h[i], anchor: page.hid[i] };
  }
  return null;
}

/** Up to `limit` pages, grouped by section (best section first), each with the heading that matched. */
export function searchDocs(index: DocsSearchIndex, query: string, limit = 10): SearchResult[] {
  if (!query.trim()) return [];
  const hits = index.mini.search(query.trim()).slice(0, limit);
  const top = hits.map((h) => {
    const p = index.pages[h.id as number];
    const heading = findHeading(p, h.terms);
    return { url: p.u, title: p.t, section: p.s, heading: heading?.heading ?? null, anchor: heading?.anchor ?? null };
  });
  const order: string[] = [];
  for (const r of top) if (!order.includes(r.section)) order.push(r.section);
  return order.flatMap((s) => top.filter((r) => r.section === s));
}
