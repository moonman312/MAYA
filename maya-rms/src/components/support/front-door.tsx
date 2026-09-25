import Link from "next/link";
import { ArrowRight, ExternalLink, Mail } from "lucide-react";
import { PMS_ROADMAP } from "@/lib/docs/pms-list";
import { PMS_CARDS, START_WHERE_YOU_ARE, SUPPORT_EMAIL, TOP_QUESTIONS } from "@/lib/docs/home";
import { WAITLIST_URL } from "@/lib/docs/site";
import { links } from "@/lib/deep-links";
import { HeroSearch } from "@/components/docs/hero-search";
import { ThemeToggle } from "@/components/docs/theme-toggle";
import { SignedInOnly } from "@/components/docs/app-links/app-link";

type PmsAction = { label: string; href: string; external?: boolean };

// A signed-in owner can open MAYA where connecting starts; a visitor only
// ever gets the guide and the waitlist, never a way into the app.
const PMS_ACTIONS: Record<string, { visitor: PmsAction; signedIn?: PmsAction }> = {
  Cloudbeds: { visitor: { label: "Connect", href: "/docs/connect/cloudbeds#way-1-from-the-cloudbeds-marketplace" } },
  ThinkReservations: {
    visitor: { label: "Join the waitlist", href: WAITLIST_URL, external: true },
    signedIn: { label: "Open MAYA", href: links.goHref("connect"), external: true },
  },
  Mews: { visitor: { label: "Email us", href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Connecting Mews")}` } },
};

function PmsActionLink({ action }: { action: PmsAction }) {
  return (
    <a
      href={action.href}
      {...(action.external ? { target: "_blank", rel: "noopener" } : {})}
      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {action.label}
      {action.external ? <ExternalLink className="size-3.5" aria-hidden /> : null}
    </a>
  );
}

function Label({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mb-5 text-sm font-semibold tracking-widest text-primary uppercase">
      {children}
    </h2>
  );
}

/** The support page: search, the docs helper, the top questions and how to reach us. */
export function FrontDoor() {
  const comingSoon = PMS_ROADMAP.filter((p) => p.status === "Coming soon");
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-28 pb-24 sm:px-6">
      <header className="pb-10">
        <div className="flex items-start justify-between gap-4">
          <p className="mb-4 text-sm font-medium tracking-widest text-primary uppercase">Support</p>
          <ThemeToggle />
        </div>
        <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">How can we help?</h1>
        <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
          Search the docs, ask the docs helper, or email us. Every answer is written down in the{" "}
          <Link href="/docs" className="text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">
            docs
          </Link>
          .
        </p>
        <div className="mt-8 max-w-2xl">
          <HeroSearch />
        </div>
      </header>

      <section aria-labelledby="support-top" className="py-8">
        <Label id="support-top">Top questions</Label>
        <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {TOP_QUESTIONS.map((t) => (
            <li key={t.href + t.q}>
              <Link
                href={t.href}
                className="group flex items-start justify-between gap-3 border-b border-border/60 py-3 text-[0.975rem] text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {t.q}
                <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="support-pms" className="py-8">
        <Label id="support-pms">Your property system</Label>
        <ul className="grid gap-3 md:grid-cols-3">
          {PMS_CARDS.map((p) => {
            const action = PMS_ACTIONS[p.name];
            return (
              <li key={p.name} className="flex flex-col gap-3 rounded-2xl border border-border p-5">
                <p className="text-base font-semibold text-foreground">{p.name}</p>
                <p className="flex-1 text-sm text-muted-foreground">{p.status}</p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={p.href}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    Read the guide
                  </Link>
                  {action.signedIn ? (
                    <SignedInOnly otherwise={<PmsActionLink action={action.visitor} />}>
                      <PmsActionLink action={action.signedIn} />
                    </SignedInOnly>
                  ) : (
                    <PmsActionLink action={action.visitor} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-6 rounded-2xl border border-border">
          <p className="border-b border-border px-5 py-3 text-xs font-medium tracking-widest text-muted-foreground uppercase">On the way</p>
          <ul className="divide-y divide-border">
            {comingSoon.map((p) => (
              <li key={p.name} className="flex items-center justify-between px-5 py-3 text-sm">
                <span className="flex items-center gap-3">
                  <span className="size-2 rounded-full bg-muted-foreground/30" aria-hidden />
                  <span className="font-medium text-foreground">{p.name}</span>
                </span>
                <span className="text-muted-foreground">Coming soon</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">
            Using one of these?{" "}
            <a href={WAITLIST_URL} className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">
              Join the waitlist
            </a>
            .
          </p>
        </div>
      </section>

      <section aria-labelledby="support-start" className="py-8">
        <Label id="support-start">Start reading</Label>
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

      <section aria-labelledby="support-stuck" className="py-8">
        <Label id="support-stuck">Still stuck?</Label>
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-6">
          <p className="flex items-start gap-3 text-lg text-foreground">
            <Mail className="mt-1 size-5 shrink-0 text-primary" aria-hidden />
            <span>
              Email{" "}
              <a
                href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("MAYA support")}`}
                className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"
              >
                {SUPPORT_EMAIL}
              </a>{" "}
              from the address you sign in to MAYA with. We aim to answer within one business day.
            </span>
          </p>
          <ul className="mt-4 list-disc space-y-1.5 pl-12 text-[0.975rem] text-muted-foreground marker:text-primary/60">
            <li>Name your property.</li>
            <li>For a question about a price, add the night, the room type and the sentence the change log shows for it.</li>
            <li>Never send passwords, card numbers or guest details.</li>
          </ul>
          <p className="mt-4 pl-8 text-sm text-muted-foreground">
            For a problem inside Cloudbeds itself, such as signing in to Cloudbeds or a missing permission there, ask{" "}
            <a
              href="https://myfrontdesk.cloudbeds.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"
            >
              Cloudbeds Support
            </a>
            . <Link href="/docs/help/contact-support" className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">Contact support</Link> has the rest.
          </p>
        </div>
      </section>
    </div>
  );
}
