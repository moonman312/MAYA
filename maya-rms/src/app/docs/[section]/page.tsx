import { notFound, redirect } from "next/navigation";
import { firstPageOf, sectionsWithPages } from "@/lib/docs/content";

// There are no section pages: a section's address opens its first page.

export const dynamicParams = false;

export function generateStaticParams() {
  return sectionsWithPages().map((s) => ({ section: s.slug }));
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const first = firstPageOf(section);
  if (!first) notFound();
  redirect(first.url);
}
