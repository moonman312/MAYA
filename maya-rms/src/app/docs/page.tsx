import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import { sectionsWithPages } from "@/lib/docs/content";
import { PMS_CARDS, START_WHERE_YOU_ARE, SUPPORT_EMAIL, TOP_QUESTIONS } from "@/lib/docs/home";
import { SECTION_ICONS } from "@/components/docs/section-icons";
import { HeroSearch } from "@/components/docs/hero-search";

export const metadata: Metadata = {
  title: { absolute: "MAYA docs" },
  description: "Everything about MAYA, in plain words, with nothing left out.",
  alternates: { canonical: "/docs" },
  openGraph: {
    type: "website",
    title: "MAYA docs",
    description: "Everything about MAYA, in plain words, with nothing left out.",
    url: "/docs",
    siteName: "MAYA",
  },
  twitter: {
    card: "summary",
    title: "MAYA docs",
    description: "Everything about MAYA, in plain words, with nothing left out.",
  },
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-5 text-sm font-semibold tracking-widest text-primary uppercase">{children}</h2>;
}

export default function DocsHome() {
  const sections = sectionsWithPages();
  const pageCount = sections.reduce((n, s) => n + s.pages.length, 0);
  return (
    <div className="max-w-5xl">
      <header className="pt-4 pb-10 sm:pt-8">
        <p className="mb-4 text-sm font-medium tracking-widest text-primary uppercase">MAYA docs</p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight text-balance sm:text-5xl">
          You set the rules. <span className="text-muted-foreground">MAYA runs them.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted-foreground">Everything about MAYA, in plain words, with nothing left out.</p>
        <div className="mt-8 max-w-2xl">
          <HeroSearch />
          <p className="mt-3 text-sm text-muted-foreground">
            {pageCount} pages. Press <kbd className="rounded border border-border px-1.5 font-mono text-xs">/</kbd> to search from anywhere.
          </p>
        </div>
      </header>

      <section aria-labelledby="start-where" className="py-8">
        <SectionLabel>
          <span id="start-where">Start where you are</span>
        </SectionLabel>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {START_WHERE_YOU_ARE.map((c) => (
            <li key={c.href}>
              <Link
                href={c.href}
                className="group flex h-full flex-col justify-between gap-3 rounded-2xl border border-border bg-card/40 p-5 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span>
                  <span className="block text-base font-semibold text-foreground">{c.label}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{c.blurb}</span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="top-questions" className="py-8">
        <SectionLabel>
          <span id="top-questions">Top questions</span>
        </SectionLabel>
        <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {TOP_QUESTIONS.map((t) => (
            <li key={t.href + t.q}>
              <Link
                href={t.href}
                className="group flex items-start justify-between gap-3 rounded-lg border-b border-border/60 py-3 text-[0.975rem] text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {t.q}
                <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="your-system" className="py-8">
        <SectionLabel>
          <span id="your-system">Your property system</span>
        </SectionLabel>
        <ul className="grid gap-3 md:grid-cols-3">
          {PMS_CARDS.map((p) => (
            <li key={p.name}>
              <Link
                href={p.href}
                className="flex h-full flex-col gap-2 rounded-2xl border border-border p-5 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="text-base font-semibold text-foreground">{p.name}</span>
                <span className="text-sm text-muted-foreground">{p.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="all-sections" className="py-8">
        <SectionLabel>
          <span id="all-sections">Every section</span>
        </SectionLabel>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => {
            const Icon = SECTION_ICONS[s.slug];
            return (
              <li key={s.slug}>
                <Link
                  href={s.pages[0].url}
                  className="group flex h-full gap-4 rounded-2xl border border-border p-5 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {Icon ? (
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden />
                    </span>
                  ) : null}
                  <span>
                    <span className="block font-semibold text-foreground">{s.label}</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">{s.blurb}</span>
                    <span className="mt-2 block text-xs text-muted-foreground/80">
                      {s.pages.length} page{s.pages.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-6 rounded-2xl border border-primary/20 bg-primary/5 p-6">
        <p className="flex items-start gap-3 text-foreground">
          <Mail className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <span>
            Not answered?{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Docs question")}`}
              className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"
            >
              Email us at {SUPPORT_EMAIL}
            </a>
            . We aim to reply within one business day.
          </span>
        </p>
      </section>
    </div>
  );
}
