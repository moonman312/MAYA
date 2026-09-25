import type { Metadata } from "next";
import { DocsShell } from "@/components/docs/shell";
import { DocsSiteFooter, DocsSiteHeader } from "@/components/docs/site-chrome";
import { sectionsWithPages } from "@/lib/docs/content";
import { HOME_STARTERS } from "@/lib/docs/home";
import { APP_ORIGIN } from "@/lib/docs/site";

const description =
  "Everything about MAYA, in plain words: rules, your property system, going live, billing and what to do when something looks wrong.";

// Pages set their own; this keeps the app's title off the section addresses.
export const metadata: Metadata = {
  metadataBase: new URL(APP_ORIGIN),
  title: { default: "MAYA docs", template: "%s · MAYA docs" },
  description,
  openGraph: { type: "website", title: "MAYA docs", description, siteName: "MAYA" },
  twitter: { card: "summary", title: "MAYA docs", description },
};

// A kill switch for the docs helper; read when the pages are built.
const askEnabled = process.env.DOCS_ASK_DISABLED !== "1";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const sections = sectionsWithPages().map((s) => ({
    slug: s.slug,
    label: s.label,
    pages: s.pages.map((p) => ({ url: p.url, title: p.title })),
  }));
  return (
    <div className="docs-root flex min-h-screen flex-col bg-background font-sans text-foreground antialiased">
      <a
        href="#docs-content"
        className="sr-only z-[70] rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <DocsSiteHeader current="docs" wide />
      <DocsShell sections={sections} askEnabled={askEnabled} starters={HOME_STARTERS}>
        {children}
      </DocsShell>
      <DocsSiteFooter />
    </div>
  );
}
