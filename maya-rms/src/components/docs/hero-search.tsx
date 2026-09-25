"use client";

import { MessageCircleQuestion } from "lucide-react";
import { DocsSearch } from "./search";
import { useAsk } from "./ask/ask-context";

/** The big search box with the docs helper button beside it. */
export function HeroSearch() {
  const { enabled, openAsk } = useAsk();
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <DocsSearch size="lg" className="flex-1" />
      {enabled ? (
        <button
          type="button"
          onClick={() => openAsk()}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/50"
        >
          <MessageCircleQuestion className="size-5" aria-hidden />
          Ask MAYA docs
        </button>
      ) : null}
    </div>
  );
}
