"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavSection {
  slug: string;
  label: string;
  pages: { url: string; title: string }[];
}

/**
 * The docs menu: every section, the current one open. Other sections open
 * on click, and stay open until closed.
 */
export function DocsNav({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const currentSection = pathname.split("/")[2] ?? "";
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  return (
    <nav aria-label="Docs" className="text-[0.9375rem]">
      <Link
        href="/docs"
        onClick={onNavigate}
        aria-current={pathname === "/docs" ? "page" : undefined}
        className={cn(
          "mb-3 block rounded-lg px-2.5 py-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          pathname === "/docs" ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
        )}
      >
        Docs home
      </Link>
      <ul className="space-y-0.5">
        {sections.map((s) => {
          const isCurrent = s.slug === currentSection;
          const open = opened[s.slug] ?? isCurrent;
          const listId = `docs-nav-${s.slug}`;
          return (
            <li key={s.slug}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpened((o) => ({ ...o, [s.slug]: !open }))}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  isCurrent ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
                {s.label}
              </button>
              <ul id={listId} hidden={!open} className="mt-0.5 mb-2 ml-[1.1rem] space-y-0.5 border-l border-border pl-2.5">
                {s.pages.map((p) => {
                  const active = pathname === p.url;
                  return (
                    <li key={p.url}>
                      <Link
                        href={p.url}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "block rounded-md px-2 py-1 text-[0.875rem] leading-snug transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                          active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        {p.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
