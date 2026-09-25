import Link from "next/link";
import { MARKETING_URL, PRIVACY_URL, TERMS_URL, WAITLIST_URL, WHITE_PAPER_URL } from "@/lib/docs/site";
import { SignedInOnly } from "./app-links/app-link";

// The docs' own header and footer: the marketing site's menu, pointing back
// to get-maya.com. A signed-in reader gets "Open MAYA"; everyone else gets a
// quiet "Join the waitlist" and no way into the app.

const linkClass = "text-sm text-muted-foreground transition-colors hover:text-foreground";

export function DocsSiteHeader({ current, wide = false }: { current: "docs" | "support"; wide?: boolean }) {
  return (
    <nav className="fixed top-0 z-50 w-full border-b border-border bg-background/80 px-6 py-5 backdrop-blur-lg" aria-label="MAYA">
      <div className={`mx-auto flex items-center justify-between gap-4 ${wide ? "max-w-7xl" : "max-w-5xl"}`}>
        <a href={MARKETING_URL} className="text-lg font-bold tracking-wide text-foreground">
          MAYA
        </a>
        <div className="flex items-center gap-4 sm:gap-6">
          <Link href="/docs" aria-current={current === "docs" ? "page" : undefined} className={current === "docs" ? "text-sm text-foreground" : linkClass}>
            Docs
          </Link>
          <Link
            href="/support"
            aria-current={current === "support" ? "page" : undefined}
            className={current === "support" ? "text-sm text-foreground" : linkClass}
          >
            Support
          </Link>
          <a href={WHITE_PAPER_URL} className={`${linkClass} hidden sm:inline`}>
            White Paper
          </a>
          <SignedInOnly
            otherwise={
              <a href={WAITLIST_URL} className="text-sm font-medium text-primary transition-opacity hover:opacity-80">
                Join the waitlist
              </a>
            }
          >
            <Link href="/" className="text-sm font-medium text-primary transition-opacity hover:opacity-80">
              Open MAYA
            </Link>
          </SignedInOnly>
        </div>
      </div>
    </nav>
  );
}

export function DocsSiteFooter() {
  const small = "text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground";
  return (
    <footer className="relative z-10 border-t border-border px-6 py-8">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4">
        <a href={MARKETING_URL} className="text-sm font-semibold tracking-wide text-foreground">
          MAYA
        </a>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/docs" className={small}>
            Docs
          </Link>
          <Link href="/support" className={small}>
            Support
          </Link>
          <a href={PRIVACY_URL} className={small}>
            Privacy
          </a>
          <a href={TERMS_URL} className={small}>
            Terms
          </a>
          <p className="text-xs text-muted-foreground">&copy; {new Date().getFullYear()} MAYA. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
