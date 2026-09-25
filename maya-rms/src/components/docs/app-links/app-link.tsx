"use client";

import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { useSignedIn } from "./session";

/**
 * Words in the docs that name a place in MAYA. For a signed-in reader they
 * open that place in a new tab (so the page they were reading stays put); for
 * everyone else they are just the words.
 */
export function AppLinkClient({ href, children }: { href: string; children?: ReactNode }) {
  const signedIn = useSignedIn();
  if (!signedIn) return <>{children}</>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      title="Open in MAYA"
      data-app-link
      className="decoration-primary/50 decoration-dotted underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
    >
      {children}
      <ArrowUpRight className="ml-0.5 inline size-[0.85em] -translate-y-px align-baseline text-primary/80" aria-hidden data-print-hide />
      <span className="sr-only"> (opens in MAYA)</span>
    </a>
  );
}

/**
 * A button that opens MAYA at the place a how-to is about, often with a rule
 * or a choice already filled in. Only a signed-in reader sees it.
 */
export function OpenInMayaClient({ href, note, children }: { href: string; note: string | null; children?: ReactNode }) {
  const signedIn = useSignedIn();
  if (!signedIn) return null;
  return (
    <div className="my-6" data-print-hide data-open-in-maya>
      <a
        href={href}
        target="_blank"
        rel="noopener"
        className="inline-flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3.5 py-2 text-sm font-medium text-foreground no-underline transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {children}
        <ArrowUpRight className="size-4 text-primary" aria-hidden />
        <span className="sr-only"> (opens in MAYA)</span>
      </a>
      {note ? <p className="mt-2 text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** One thing for a signed-in reader, another (or nothing) for everyone else. */
export function SignedInOnly({ children, otherwise = null }: { children: ReactNode; otherwise?: ReactNode }) {
  const signedIn = useSignedIn();
  return <>{signedIn ? children : otherwise}</>;
}
