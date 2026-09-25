import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Plain Markdown elements, styled for reading. Links to other docs pages go
// through next/link; links out open in a new tab.

function HeadingAnchor({ id }: { id?: string }) {
  if (!id) return null;
  return (
    <a
      href={`#${id}`}
      aria-label="Link to this section"
      className="ml-2 inline-flex translate-y-[-1px] align-middle text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/70 focus-visible:text-muted-foreground focus-visible:outline-none"
      data-print-hide
    >
      <Link2 className="size-4" aria-hidden />
    </a>
  );
}

export function H2({ id, children }: { id?: string; children?: ReactNode }) {
  return (
    <h2 id={id} className="group mt-14 mb-4 scroll-mt-28 text-2xl font-semibold tracking-tight text-foreground">
      {children}
      <HeadingAnchor id={id} />
    </h2>
  );
}

export function H3({ id, children }: { id?: string; children?: ReactNode }) {
  return (
    <h3 id={id} className="group mt-10 mb-3 scroll-mt-28 text-lg font-semibold text-foreground">
      {children}
      <HeadingAnchor id={id} />
    </h3>
  );
}

export function H4({ id, children }: { id?: string; children?: ReactNode }) {
  return (
    <h4 id={id} className="mt-8 mb-2 scroll-mt-28 font-semibold text-foreground">
      {children}
    </h4>
  );
}

export function P(props: ComponentProps<"p">) {
  return <p className="my-5 [li>&]:my-2" {...props} />;
}

export function A({ href = "", children, ...rest }: ComponentProps<"a">) {
  const className =
    "font-medium text-primary underline decoration-primary/30 underline-offset-4 transition-colors hover:decoration-primary";
  if (href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  if (href.startsWith("#") || href.startsWith("mailto:")) {
    return (
      <a href={href} className={className} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

export function Ul(props: ComponentProps<"ul">) {
  return <ul className="my-5 list-disc space-y-2 pl-6 marker:text-primary/60" {...props} />;
}

export function Ol(props: ComponentProps<"ol">) {
  return <ol className="my-5 list-decimal space-y-2 pl-6 marker:font-medium marker:text-muted-foreground" {...props} />;
}

export function Li(props: ComponentProps<"li">) {
  return <li className="pl-1 [&>ol]:my-2 [&>ul]:my-2" {...props} />;
}

export function Strong(props: ComponentProps<"strong">) {
  return <strong className="font-semibold text-foreground" {...props} />;
}

export function Table({ children }: ComponentProps<"table">) {
  return (
    <div className="my-6 overflow-x-auto rounded-xl border border-border" role="region" aria-label="Table" tabIndex={0}>
      <table className="w-full border-collapse text-left text-[0.9375rem] leading-relaxed">{children}</table>
    </div>
  );
}

export function Th(props: ComponentProps<"th">) {
  return (
    <th
      className="border-b border-border bg-muted/60 px-4 py-2.5 align-bottom text-sm font-semibold whitespace-nowrap text-foreground first:pl-4"
      {...props}
    />
  );
}

export function Td(props: ComponentProps<"td">) {
  return <td className="border-b border-border/60 px-4 py-2.5 align-top [tr:last-child>&]:border-b-0" {...props} />;
}

export function Blockquote(props: ComponentProps<"blockquote">) {
  return <blockquote className="my-6 border-l-2 border-primary/40 pl-5 text-muted-foreground" {...props} />;
}

export function Hr() {
  return <hr className="my-10 border-border" />;
}

export function Code(props: ComponentProps<"code">) {
  return <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em]")} {...props} />;
}
