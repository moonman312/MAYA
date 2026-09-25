import fs from "node:fs";
import path from "node:path";
import pagesJson from "./generated/pages.json";
import { sections, type DocsSection } from "./sections";
import { splitFrontmatter, stripTrailingNotes } from "./source.mjs";

// Everything a docs route needs, read at build time. The page list comes
// from lib/docs/generated/pages.json (written by scripts/docs-build.mjs);
// the page body is read from content/docs.

export interface DocsHeading {
  depth: number;
  text: string;
  id: string;
}

export interface DocsPage {
  path: string;
  url: string;
  section: string;
  sectionLabel: string;
  slug: string;
  order: number;
  title: string;
  summary: string;
  readingTime: number;
  readingNote: string | null;
  updated: string | null;
  pms: string[];
  headings: DocsHeading[];
  questions: string[];
  faq: { q: string; a: string }[];
}

export const docsPages = pagesJson as DocsPage[];

const CONTENT = path.join(process.cwd(), "content/docs");

export function getPage(section: string, slug: string): DocsPage | undefined {
  return docsPages.find((p) => p.section === section && p.slug === slug);
}

export function pagesIn(section: string): DocsPage[] {
  return docsPages.filter((p) => p.section === section);
}

export function firstPageOf(section: string): DocsPage | undefined {
  return pagesIn(section)[0];
}

export function sectionsWithPages(): (DocsSection & { pages: DocsPage[] })[] {
  return sections.map((s) => ({ ...s, pages: pagesIn(s.slug) })).filter((s) => s.pages.length > 0);
}

/** The page before and after, in nav order across sections. */
export function neighbours(page: DocsPage): { prev: DocsPage | null; next: DocsPage | null } {
  const i = docsPages.findIndex((p) => p.url === page.url);
  return { prev: i > 0 ? docsPages[i - 1] : null, next: i >= 0 && i < docsPages.length - 1 ? docsPages[i + 1] : null };
}

/** The page's MDX body, without frontmatter or trailing source notes. */
export function readBody(page: DocsPage): string {
  const raw = fs.readFileSync(path.join(CONTENT, `${page.path}.mdx`), "utf8");
  return stripTrailingNotes(splitFrontmatter(raw).body);
}
