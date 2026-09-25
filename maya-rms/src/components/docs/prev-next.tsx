import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { DocsPage } from "@/lib/docs/content";

function Card({ page, dir }: { page: DocsPage; dir: "prev" | "next" }) {
  return (
    <Link
      href={page.url}
      rel={dir}
      className="group flex flex-1 flex-col gap-1 rounded-xl border border-border px-4 py-3.5 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[dir=next]:text-right"
      data-dir={dir}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground data-[dir=next]:justify-end" data-dir={dir}>
        {dir === "prev" ? <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" aria-hidden /> : null}
        {dir === "prev" ? "Previous" : "Next"} · {page.sectionLabel}
        {dir === "next" ? <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden /> : null}
      </span>
      <span className="font-medium text-foreground">{page.title}</span>
    </Link>
  );
}

export function PrevNext({ prev, next }: { prev: DocsPage | null; next: DocsPage | null }) {
  if (!prev && !next) return null;
  return (
    <nav aria-label="Previous and next page" className="mt-12 flex flex-col gap-3 sm:flex-row" data-print-hide>
      {prev ? <Card page={prev} dir="prev" /> : <span className="hidden flex-1 sm:block" />}
      {next ? <Card page={next} dir="next" /> : <span className="hidden flex-1 sm:block" />}
    </nav>
  );
}
