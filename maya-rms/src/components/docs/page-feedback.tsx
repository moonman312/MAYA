"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

/** "Was this page useful?": sends which page and which button, and nothing else. */
export function PageFeedback({ page }: { page: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  async function vote(useful: boolean) {
    setState("sending");
    try {
      const res = await fetch("/api/docs-ask/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: useful ? "page-useful" : "page-not-useful", page }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="mt-12 flex flex-wrap items-center gap-3 border-t border-border pt-6 text-sm text-muted-foreground" data-print-hide>
      {state === "done" ? (
        <p role="status">Thanks for telling us.</p>
      ) : state === "error" ? (
        <p role="status">That did not send. You can email us instead.</p>
      ) : (
        <>
          <span>Was this page useful?</span>
          <div className="flex gap-2">
            {[true, false].map((useful) => (
              <button
                key={String(useful)}
                type="button"
                disabled={state === "sending"}
                onClick={() => vote(useful)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
              >
                {useful ? <ThumbsUp className="size-4" aria-hidden /> : <ThumbsDown className="size-4" aria-hidden />}
                {useful ? "Yes" : "No"}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
