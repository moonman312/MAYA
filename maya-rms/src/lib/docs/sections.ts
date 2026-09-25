import sectionList from "./sections.json";

export type SectionSlug =
  | "start"
  | "account"
  | "pay"
  | "connect"
  | "review"
  | "rules"
  | "watch"
  | "live"
  | "billing"
  | "team"
  | "recipes"
  | "wrong"
  | "reference"
  | "help";

export interface DocsSection {
  slug: SectionSlug;
  label: string;
  blurb: string;
}

// The order here is the order of the left nav and of previous/next.
export const sections = sectionList as DocsSection[];

export function sectionBySlug(slug: string): DocsSection | undefined {
  return sections.find((s) => s.slug === slug);
}
