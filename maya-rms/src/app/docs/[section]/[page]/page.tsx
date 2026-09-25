import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { compileMDX } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { docsPages, getPage, neighbours, readBody } from "@/lib/docs/content";
import { createAppLinker, type AppLabels } from "@/lib/docs/app-linker.mjs";
import appLabels from "@/lib/docs/app-labels.json";
import { SUPPORT_EMAIL } from "@/lib/docs/home";
import { mdxComponents } from "@/components/docs/mdx";
import { Breadcrumbs } from "@/components/docs/breadcrumbs";
import { PageMeta } from "@/components/docs/page-meta";
import { MobileToc, Toc } from "@/components/docs/toc";
import { PrevNext } from "@/components/docs/prev-next";
import { PageFeedback } from "@/components/docs/page-feedback";
import { AskStarters } from "@/components/docs/ask/ask-context";

type Params = Promise<{ section: string; page: string }>;

// Links on-screen labels to their place in MAYA (only signed-in readers see them).
const remarkAppLinks = createAppLinker(appLabels as unknown as AppLabels);

export const dynamicParams = false;

export function generateStaticParams() {
  return docsPages.map((p) => ({ section: p.section, page: p.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { section, page: slug } = await params;
  const page = getPage(section, slug);
  if (!page) return {};
  return {
    title: page.title,
    description: page.summary,
    alternates: { canonical: page.url },
    openGraph: {
      type: "article",
      title: `${page.title} · MAYA docs`,
      description: page.summary,
      url: page.url,
      siteName: "MAYA",
    },
    twitter: { card: "summary", title: `${page.title} · MAYA docs`, description: page.summary },
  };
}

export default async function DocsPageRoute({ params }: { params: Params }) {
  const { section, page: slug } = await params;
  const page = getPage(section, slug);
  if (!page) notFound();

  const { content } = await compileMDX({
    source: readBody(page),
    components: mdxComponents,
    options: {
      blockJS: false,
      blockDangerousJS: true,
      mdxOptions: { remarkPlugins: [remarkGfm, [remarkAppLinks, { page: page.path }]], rehypePlugins: [rehypeSlug] },
    },
  });
  const { prev, next } = neighbours(page);
  const faq =
    page.faq.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: page.faq.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }
      : null;

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_13.5rem] xl:gap-12">
      <div className="min-w-0 max-w-[45rem]">
        <Breadcrumbs
          items={[
            { href: "/docs", label: "Docs" },
            { href: `/docs/${page.section}`, label: page.sectionLabel },
            { label: page.title },
          ]}
        />
        <h1 className="text-3xl font-bold tracking-tight text-balance text-foreground sm:text-4xl">{page.title}</h1>
        <PageMeta readingTime={page.readingTime} readingNote={page.readingNote} section={page.sectionLabel} updated={page.updated} />
        <MobileToc headings={page.headings} />
        <article className="docs-prose text-[1.0625rem] leading-[1.75] text-foreground/85">{content}</article>
        <PageFeedback page={page.url} />
        <PrevNext prev={prev} next={next} />
        <p className="mt-10 text-sm text-muted-foreground">
          Not answered here?{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Docs: ${page.title}`)}`}
            className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"
          >
            Email us
          </a>
          . We aim to reply within one business day.
        </p>
      </div>
      <aside className="hidden xl:block" data-print-hide>
        <div className="sticky top-[92px] max-h-[calc(100dvh-110px)] overflow-y-auto pb-8">
          <Toc headings={page.headings} />
        </div>
      </aside>
      <AskStarters questions={page.questions.slice(0, 6)} />
      {faq ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faq).replace(/</g, "\\u003c") }} />
      ) : null}
    </div>
  );
}
