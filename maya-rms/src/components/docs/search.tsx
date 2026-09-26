"use client";

import { forwardRef, useCallback, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search as SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAsk } from "./ask/ask-context";
import { buildSearch, searchDocs, type DocsSearchIndex, type SearchPage, type SearchResult as Result } from "@/lib/docs/search-index";

// The index is a static file bundled on its own; it loads the first time a
// search box gets focus, and every keystroke after that searches in memory.
// A load that fails is forgotten, so the next focus or keystroke tries again.
let indexPromise: Promise<DocsSearchIndex> | null = null;
function loadIndex() {
  if (!indexPromise) {
    indexPromise = import("@/lib/docs/generated/index.json")
      .then((mod) => buildSearch((mod.default as { pages: SearchPage[] }).pages))
      .catch((e) => {
        indexPromise = null;
        throw e;
      });
  }
  return indexPromise;
}

export interface DocsSearchHandle {
  focus: () => void;
}

export const DocsSearch = forwardRef<DocsSearchHandle, { onNavigate?: () => void; size?: "sm" | "lg"; autoFocus?: boolean; className?: string }>(
  function DocsSearch({ onNavigate, size = "sm", autoFocus, className }, ref) {
    const router = useRouter();
    const { enabled: askEnabled, openAsk } = useAsk();
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [data, setData] = useState<Awaited<ReturnType<typeof loadIndex>> | null>(null);
    const [failed, setFailed] = useState(false);
    const [active, setActive] = useState(0);
    const [focused, setFocused] = useState(false);
    const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const listId = useId();

    useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

    const load = useCallback(() => {
      setFailed(false);
      loadIndex().then(setData, () => setFailed(true));
    }, []);

    const results: Result[] = useMemo(() => (data ? searchDocs(data, query) : []), [data, query]);

    function go(r: Result) {
      router.push(r.anchor ? `${r.url}#${r.anchor}` : r.url);
      setQuery("");
      inputRef.current?.blur();
      onNavigate?.();
    }

    function askHelper() {
      openAsk(query);
      setQuery("");
    }

    const showList = focused && query.trim() !== "";
    const optionId = (i: number) => `${listId}-opt-${i}`;

    return (
      <div
        className={cn("relative", className)}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setFocused(true);
        }}
        onBlur={(e) => {
          // Stay open while focus moves within the search, such as from the
          // box to the "Ask the docs helper" button under it.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          blurTimer.current = setTimeout(() => setFocused(false), 150);
        }}
      >
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border border-input bg-background px-3 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
            size === "lg" ? "h-12" : "h-9"
          )}
        >
          <SearchIcon className={cn("shrink-0 text-muted-foreground", size === "lg" ? "size-5" : "size-4")} aria-hidden />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label="Search the docs"
            aria-expanded={showList && results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && results[active] ? optionId(active) : undefined}
            placeholder={size === "lg" ? "Search the docs" : "Search"}
            autoComplete="off"
            autoFocus={autoFocus}
            value={query}
            onFocus={load}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              if (!data) load();
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                if (results[active]) {
                  e.preventDefault();
                  go(results[active]);
                } else if (data && askEnabled && query.trim()) {
                  e.preventDefault();
                  askHelper();
                }
              } else if (e.key === "Escape") {
                if (query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                } else inputRef.current?.blur();
              }
            }}
            className={cn("h-full w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground/80", size === "lg" ? "text-base" : "text-sm")}
          />
          {size === "sm" ? (
            <kbd className="hidden rounded border border-border px-1.5 font-mono text-[0.7rem] text-muted-foreground lg:inline" aria-hidden>
              /
            </kbd>
          ) : null}
        </div>
        <div
          hidden={!showList}
          className={cn(
            "absolute top-full left-0 z-50 mt-2 max-h-[min(28rem,70vh)] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl",
            size === "lg" ? "right-0" : "w-[min(26rem,calc(100vw-2rem))]"
          )}
        >
          <div id={listId} role="listbox" aria-label="Search results" hidden={!results.length}>
            {results.map((r, i) => (
              <div
                key={`${r.url}-${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(r)}
                onMouseEnter={() => setActive(i)}
                className={cn("cursor-pointer rounded-lg px-3 py-2", i === active ? "bg-primary/10" : "")}
              >
                <p className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">{r.section}</p>
                <p className="text-sm font-medium text-foreground">{r.title}</p>
                {r.heading ? <p className="truncate text-xs text-muted-foreground">› {r.heading}</p> : null}
              </div>
            ))}
          </div>
          {/* Outside the listbox, which may hold only options. */}
          {!data ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              {failed ? "The search could not load. Check your connection and type again." : "Loading the search…"}
            </p>
          ) : results.length ? null : (
            <div className="px-3 py-3 text-sm text-muted-foreground">
              <p>No page matches.{askEnabled ? " Ask the docs helper, or email us." : " Email us."}</p>
              <div className="mt-2 flex gap-2">
                {askEnabled ? (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={askHelper}
                    className="rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground"
                  >
                    Ask the docs helper
                  </button>
                ) : null}
                <a
                  href={`mailto:info@modern-hospitality-solutions.com?subject=${encodeURIComponent("Docs question")}`}
                  className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground"
                >
                  Email us
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);
