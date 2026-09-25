import { Clock } from "lucide-react";

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Reading time (or the page's own reading note), section, and when it was last updated. */
export function PageMeta({ readingTime, readingNote, section, updated }: { readingTime: number; readingNote: string | null; section: string; updated: string | null }) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <Clock className="size-3.5" aria-hidden />
      <span>{readingNote ?? `${readingTime} min read`}</span>
      <span aria-hidden>·</span>
      <span>{section}</span>
      {updated ? (
        <>
          <span aria-hidden>·</span>
          <span>Updated {formatDate(updated)}</span>
        </>
      ) : null}
    </p>
  );
}
