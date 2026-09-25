"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface Heading {
  depth: number;
  text: string;
  id: string;
}

function useActiveHeading(ids: string[]) {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (!els.length) return;
    // The current heading is the last one that has scrolled past the top bar.
    // An IntersectionObserver wakes this up as headings cross the upper part
    // of the screen; scrolling keeps it right in between.
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let current = els[0].id;
        for (const el of els) {
          if (el.getBoundingClientRect().top < 140) current = el.id;
          else break;
        }
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
        setActive(atBottom ? els[els.length - 1].id : current);
      });
    };
    const observer = new IntersectionObserver(update, { rootMargin: "-96px 0px -55% 0px" });
    els.forEach((el) => observer.observe(el));
    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", update);
    };
  }, [ids]);
  return active;
}

function TocList({ headings, active, onPick }: { headings: Heading[]; active: string | null; onPick?: () => void }) {
  return (
    <ul className="space-y-1 text-[0.8125rem] leading-snug">
      {headings.map((h) => (
        <li key={h.id} className={h.depth === 3 ? "pl-3" : undefined}>
          <a
            href={`#${h.id}`}
            onClick={onPick}
            aria-current={active === h.id ? "location" : undefined}
            className={cn(
              "-ml-px block border-l py-1 pl-3 transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active === h.id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {h.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** "On this page", beside the page on wide screens. */
export function Toc({ headings }: { headings: Heading[] }) {
  const key = headings.map((h) => h.id).join("|");
  const ids = useMemo(() => (key ? key.split("|") : []), [key]);
  const active = useActiveHeading(ids);
  if (!headings.length) return null;
  return (
    <nav aria-label="On this page">
      <p className="mb-3 text-xs font-semibold tracking-widest text-muted-foreground uppercase">On this page</p>
      <div className="border-l border-border">
        <TocList headings={headings} active={active} />
      </div>
    </nav>
  );
}

/** "On this page", above the page on narrower screens. */
export function MobileToc({ headings }: { headings: Heading[] }) {
  const [open, setOpen] = useState(false);
  if (!headings.length) return null;
  return (
    <nav aria-label="On this page" className="my-6 rounded-xl border border-border xl:hidden" data-print-hide>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        On this page
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div className="border-t border-border px-4 py-3">
          <div className="border-l border-border">
            <TocList headings={headings} active={null} onPick={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </nav>
  );
}
