export declare function splitFrontmatter(raw: string): {
  frontmatter: string | null;
  body: string;
  bodyLine: number;
};
export declare function stripTrailingNotes(body: string): string;
export declare function parseFrontmatter(text: string): Record<string, unknown>;
export declare function splitRef(item: string): { text: string; ref: string | null };
export declare function withReadingTime(raw: string, minutes: number): string;
