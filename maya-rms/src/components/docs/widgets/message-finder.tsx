"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";

function normalise(s: string) {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A filter box over the messages on this page. It hides the entries that do
 * not match and opens every group that holds one. The list itself is plain
 * text on the page, so it prints and reads without this box.
 */
export function MessageFinder() {
  const id = useId();
  const [query, setQuery] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const openedByUs = useRef(new Set<HTMLDetailsElement>());

  useEffect(() => {
    const article = root.current?.closest("article") ?? document;
    const groups = Array.from(article.querySelectorAll<HTMLDetailsElement>("details[data-message-group]"));
    const q = normalise(query);
    if (!q) {
      for (const g of groups) {
        g.querySelectorAll<HTMLLIElement>("li").forEach((li) => (li.hidden = false));
        if (openedByUs.current.has(g)) g.open = false;
      }
      openedByUs.current.clear();
      setCount(null);
      return;
    }
    const words = q.split(" ");
    let total = 0;
    for (const g of groups) {
      let inGroup = 0;
      g.querySelectorAll<HTMLLIElement>(":scope > div > ul > li, :scope > div > ol > li").forEach((li) => {
        const text = normalise(li.textContent ?? "");
        const match = words.every((w) => text.includes(w));
        li.hidden = !match;
        if (match) inGroup++;
      });
      total += inGroup;
      if (inGroup > 0 && !g.open) {
        g.open = true;
        openedByUs.current.add(g);
      } else if (inGroup === 0 && openedByUs.current.has(g)) {
        g.open = false;
        openedByUs.current.delete(g);
      }
    }
    setCount(total);
  }, [query]);

  return (
    <div ref={root} className="not-prose my-8 rounded-2xl border border-border bg-card/60 p-4 sm:p-5" data-print-hide>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-foreground">
        Type a few words of the message
      </label>
      <div className="flex h-11 items-center gap-2 rounded-xl border border-input bg-background px-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          id={id}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='For example "connection link has expired"'
          className="h-full w-full min-w-0 bg-transparent text-[0.975rem] outline-none placeholder:text-muted-foreground/70"
          autoComplete="off"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear"
            className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className="mt-2 min-h-5 text-sm text-muted-foreground">
        {count === null
          ? ""
          : count === 0
            ? "No message matches. Try fewer words, or ask the docs helper."
            : count === 1
              ? "1 message matches. The group that holds it is open below."
              : `${count} messages match. The groups that hold them are open below.`}
      </p>
    </div>
  );
}
