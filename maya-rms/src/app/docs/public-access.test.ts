/**
 * The docs and support pages are public: anyone can read every one of them
 * without signing in. Four things make that so, and each is checked here for
 * every page the docs build writes:
 *
 * 1. the middleware skips them (no session refresh, so no waiting on Supabase
 *    and nothing that could turn a reader away), while app routes and /go
 *    still get it;
 * 2. the accept-the-Terms screen never covers them;
 * 3. their route files use nothing that reads the request (cookies, headers,
 *    the server Supabase client), so they are built ahead of time;
 * 4. every page on disk is one the build lists, so none is missing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../../../middleware";
import { isAcceptanceExemptPath } from "@/lib/legal/versions";
import { docsPages, sectionsWithPages } from "@/lib/docs/content";

const ROOT = path.resolve(__dirname, "../../..");
const matcher = new RegExp(`^${config.matcher[0]}$`);

const publicPaths = [
  "/docs",
  "/support",
  ...sectionsWithPages().map((s) => `/docs/${s.slug}`),
  ...docsPages.map((p) => p.url),
];

describe("every docs and support page is public", () => {
  it("covers all 112 pages and every section", () => {
    expect(docsPages.length).toBeGreaterThanOrEqual(112);
    expect(new Set(publicPaths).size).toBe(publicPaths.length);
  });

  it.each(publicPaths)("%s skips the session middleware and the Terms screen", (p) => {
    expect(matcher.test(p)).toBe(false);
    expect(isAcceptanceExemptPath(p)).toBe(true);
  });

  it("the helper's index, the sitemap, robots.txt, llms.txt and the share image skip the middleware too", () => {
    const index = fs.readdirSync(path.join(ROOT, "public")).find((f) => /^docs-index\.[0-9a-f]+\.json$/.test(f));
    expect(index).toBeTruthy();
    for (const p of [`/${index}`, "/sitemap.xml", "/robots.txt", "/llms.txt", "/opengraph-image"]) {
      expect(matcher.test(p)).toBe(false);
    }
  });

  it.each(["/", "/go/rules.list", "/login", "/account/team", "/onboarding/review", "/admin/docs-questions", "/docsx", "/support/x"])(
    "%s still gets the session middleware",
    (p) => {
      expect(matcher.test(p)).toBe(true);
    },
  );

  it("the docs and support routes read nothing from the request, so they are built ahead of time", () => {
    const files = [
      "src/app/docs/layout.tsx",
      "src/app/docs/page.tsx",
      "src/app/docs/[section]/page.tsx",
      "src/app/docs/[section]/[page]/page.tsx",
      "src/app/support/page.tsx",
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/next\/headers|utils\/supabase\/server|cookies\(|headers\(|force-dynamic|searchParams/);
      expect(src, f).not.toMatch(/redirect\(["'`]\/login/);
    }
    for (const f of ["src/app/docs/[section]/page.tsx", "src/app/docs/[section]/[page]/page.tsx"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).toMatch(/export const dynamicParams = false/);
      expect(src, f).toMatch(/export function generateStaticParams/);
    }
  });

  it("every page written in content/docs is a page the build lists", () => {
    const dir = path.join(ROOT, "content/docs");
    const onDisk = fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".mdx"))
      .map((f) => f.replace(/\\/g, "/").replace(/\.mdx$/, ""))
      .sort();
    expect(docsPages.map((p) => p.path).sort()).toEqual(onDisk);
  });
});
