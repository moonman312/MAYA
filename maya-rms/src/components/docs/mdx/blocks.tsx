import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Calculator, ChevronRight, CircleDashed, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { A, Li, P } from "./elements";
import { PmsTabsClient, type PmsTabContent } from "./pms-tabs-client";
import { AppLink } from "../app-links/server";

// The docs' own building blocks, used by name in the MDX pages.

export function InPlainWords({ children }: { children?: ReactNode }) {
  return (
    <section
      aria-label="In plain words"
      className="my-8 rounded-2xl border border-primary/20 bg-primary/5 px-5 py-5 sm:px-6 [&_p]:my-0 [&_p+p]:mt-3"
    >
      <p className="mb-2! text-xs font-semibold tracking-widest text-primary uppercase">In plain words</p>
      <div className="text-[1.0625rem] leading-relaxed text-foreground sm:text-lg">{children}</div>
    </section>
  );
}

const CALLOUTS = {
  "good-to-know": {
    label: "Good to know",
    Icon: Info,
    box: "border-primary/25 bg-primary/5",
    tint: "text-primary",
  },
  careful: {
    label: "Careful",
    Icon: TriangleAlert,
    box: "border-warning/40 bg-warning/10",
    tint: "text-warning",
  },
  example: {
    label: "Example",
    Icon: Calculator,
    box: "border-border bg-muted/40",
    tint: "text-muted-foreground",
  },
  "not-yet": {
    label: "Not yet",
    Icon: CircleDashed,
    box: "border-dashed border-border bg-muted/30",
    tint: "text-muted-foreground",
  },
} as const;

export function Callout({
  kind = "good-to-know",
  title,
  children,
}: {
  kind?: keyof typeof CALLOUTS;
  title?: string;
  children?: ReactNode;
}) {
  const c = CALLOUTS[kind] ?? CALLOUTS["good-to-know"];
  const showTitle = title && title.trim().toLowerCase() !== c.label.toLowerCase();
  return (
    <aside
      data-callout={kind}
      aria-label={showTitle ? `${c.label}: ${title}` : c.label}
      className={cn("my-7 flex gap-3.5 rounded-xl border px-4 py-4 sm:px-5", c.box)}
    >
      <c.Icon className={cn("mt-0.5 size-5 shrink-0", c.tint)} aria-hidden />
      <div className="min-w-0 flex-1 text-[0.975rem] leading-relaxed [&_p]:my-2 [&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0">
        <p className="mt-0! mb-1! font-semibold text-foreground">
          <span className={c.tint}>{c.label}</span>
          {showTitle ? <span className="text-foreground"> · {title}</span> : null}
        </p>
        <div>{children}</div>
      </div>
    </aside>
  );
}

/**
 * An on-screen label. With `to` (set by the docs linker from app-labels.json,
 * or by hand) it also opens that place in MAYA for a signed-in reader.
 * `off` keeps the linker away from it.
 */
export function Ui({ children, to, q }: { children?: ReactNode; to?: string; q?: string; off?: boolean }) {
  const strong = <strong className="font-semibold text-foreground">{children}</strong>;
  if (!to) return strong;
  return (
    <AppLink to={to} q={q}>
      {strong}
    </AppLink>
  );
}

export function Example({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <details className="group/ex my-7 rounded-xl border border-border bg-card/40 open:bg-card/70" data-example>
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3.5 select-none hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-5 [&::-webkit-details-marker]:hidden">
        <Calculator className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="flex-1 font-medium text-foreground">
          <span className="sr-only">Example: </span>
          {title}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open/ex:rotate-90" aria-hidden />
      </summary>
      <div className="border-t border-border px-4 pb-1 sm:px-5 [&>:first-child]:mt-4">{children}</div>
    </details>
  );
}

const PMS_LABELS: Record<string, string> = {
  cloudbeds: "Cloudbeds",
  thinkreservations: "ThinkReservations",
  mews: "Mews",
};

type WithChildren = { children?: ReactNode };

export function PmsTab({ children }: { pms: string; children?: ReactNode }) {
  // Rendered by PmsTabs; on its own it is just its content.
  return <div>{children}</div>;
}

export function PmsTabs({ children }: WithChildren) {
  const tabs: PmsTabContent[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ pms?: string; children?: ReactNode }>(child) || !child.props.pms) return;
    const pms = child.props.pms;
    tabs.push({ pms, label: PMS_LABELS[pms] ?? pms, content: child.props.children });
  });
  return <PmsTabsClient tabs={tabs} />;
}

function isStep(node: ReactNode): node is ReactElement<{ title?: string; children?: ReactNode }> {
  return isValidElement(node) && node.type === Step;
}

export function Step({ children }: { title?: string; children?: ReactNode }) {
  return <>{children}</>;
}

export function Steps({ children }: WithChildren) {
  // A run of one-line <Step>s with no blank lines between them arrives
  // wrapped in a paragraph; unwrap it.
  const steps: ReactElement<{ title?: string; children?: ReactNode }>[] = [];
  Children.forEach(children, (child) => {
    if (isStep(child)) steps.push(child);
    else if (isValidElement<{ children?: ReactNode }>(child) && (child.type === P || child.type === "p")) {
      Children.forEach(child.props.children, (inner) => {
        if (isStep(inner)) steps.push(inner);
      });
    }
  });
  return (
    <ol className="my-7 space-y-0" data-steps>
      {steps.map((step, i) => (
        <li key={i} className="relative flex gap-4 pb-6 last:pb-0">
          {i < steps.length - 1 ? (
            <span className="absolute top-8 bottom-1 left-[0.9375rem] w-px bg-border" aria-hidden />
          ) : null}
          <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-background text-sm font-semibold text-primary">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1 pt-1 [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-2">
            {step.props.title ? <p className="mt-0! font-semibold text-foreground">{step.props.title}</p> : null}
            {step.props.children}
          </div>
        </li>
      ))}
    </ol>
  );
}

function countItems(node: ReactNode): number {
  let n = 0;
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === Li || child.type === "li") n++;
    n += countItems(child.props.children);
  });
  return n;
}

/** One closed group of entries on a long list page. */
export function Group({ children }: WithChildren) {
  const n = countItems(children);
  return (
    <details className="group/grp my-5 rounded-xl border border-border" data-message-group>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-muted-foreground select-none hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open/grp:rotate-90" aria-hidden />
        <span data-group-label>{n === 1 ? "Show the message" : `Show the ${n} messages`}</span>
      </summary>
      <div className="border-t border-border px-4 sm:px-5 [&>ul]:my-4">{children}</div>
    </details>
  );
}

export function Figure({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  return (
    <figure className="my-8">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="w-full rounded-xl border border-border" />
      {caption ? <figcaption className="mt-2 text-sm text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

function collectLinks(node: ReactNode, out: { href: string; label: ReactNode }[]) {
  Children.forEach(node, (child) => {
    if (!isValidElement<{ href?: string; children?: ReactNode }>(child)) return;
    if ((child.type === A || child.type === "a") && child.props.href) {
      out.push({ href: child.props.href, label: child.props.children });
      return;
    }
    collectLinks(child.props.children, out);
  });
  return out;
}

export function Related({ children }: WithChildren) {
  const links = collectLinks(children, []).slice(0, 3);
  if (!links.length) return null;
  return (
    <section aria-labelledby="related-heading" className="mt-14" data-print-hide>
      <h2 id="related-heading" className="mb-4 text-sm font-semibold tracking-widest text-muted-foreground uppercase">
        Related
      </h2>
      <ul className="grid gap-3 sm:grid-cols-3">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="group flex h-full items-start justify-between gap-3 rounded-xl border border-border px-4 py-3.5 text-[0.9375rem] font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span>{l.label}</span>
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
