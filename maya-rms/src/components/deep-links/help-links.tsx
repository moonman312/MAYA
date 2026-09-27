"use client";

import { panelDocsHref, screenDocsHref, type HelpPanel } from "@/lib/deep-links";
import { track } from "@/lib/analytics/track";

// MAYA's way into its docs. Both open a new tab, so whatever is half-filled
// on the screen stays exactly as it was.

/**
 * The docs page about a screen, with ?from=<screen> so the docs helper knows
 * which screen Help was opened from (components/docs/ask/help-origin.ts).
 */
export function helpHref(screen: string): string {
  const [page, anchor] = screenDocsHref(screen).split("#");
  return `${page}?from=${encodeURIComponent(screen)}${anchor ? `#${anchor}` : ""}`;
}

/** "Help" in a header: the docs page about the screen the owner is on. */
export function HelpLink({ screen, className }: { screen: string; className?: string }) {
  return (
    <a
      href={helpHref(screen)}
      target="_blank"
      rel="noopener"
      onClick={() => track("help.opened", { from: "header" })}
      className={className}
    >
      Help
    </a>
  );
}

/**
 * Where a hover "?" panel sits: flush under the "?" with a see-through 8px
 * top padding, so the pointer moving down to Learn more never crosses a gap
 * that belongs to neither and closes the panel.
 */
export const HOVER_BRIDGE = "absolute left-1/2 top-full z-20 -translate-x-1/2 pt-2";

/** "Learn more" at the foot of a "?" panel: the passage that explains it in full. */
export function LearnMore({ panel, onBlurOut }: { panel: HelpPanel; onBlurOut?: (e: React.FocusEvent<HTMLAnchorElement>) => void }) {
  return (
    <a
      href={panelDocsHref(panel)}
      target="_blank"
      rel="noopener"
      onClick={() => track("help.opened", { from: "panel" })}
      onBlur={onBlurOut}
      className="mt-2 inline-block text-xs font-medium text-sky-400 underline decoration-sky-400/40 underline-offset-2 hover:text-sky-300"
    >
      Learn more
    </a>
  );
}
