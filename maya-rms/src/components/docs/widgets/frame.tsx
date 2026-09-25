import type { ReactNode } from "react";

/**
 * The "Try it" card around every interactive illustration: a label, one
 * line of what it shows, the live widget, its plain-sentence fallback (for
 * print and for readers with scripting off) and the made-up-numbers note.
 */
export function WidgetFrame({ what, fallback, children }: { what: string; fallback: string; children: ReactNode }) {
  return (
    <figure className="not-prose my-9 overflow-hidden rounded-2xl border border-border bg-card/60" data-widget>
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3 sm:px-5">
        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-primary uppercase">
          Try it
        </span>
        <span className="text-sm text-muted-foreground">{what}</span>
      </figcaption>
      <div className="px-4 py-5 sm:px-5" data-widget-live>
        {children}
      </div>
      <p className="hidden px-4 py-4 text-[0.975rem] sm:px-5" data-widget-static>
        {fallback}
      </p>
      <noscript>
        <p className="px-4 py-4 text-[0.975rem] sm:px-5">{fallback}</p>
      </noscript>
      <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
        An illustration with made-up numbers, not your property.
      </p>
    </figure>
  );
}
