import type { ReactNode } from "react";
import { links } from "@/lib/deep-links";
import { AppLinkClient, OpenInMayaClient } from "./app-link";

// The docs' links into MAYA, worked out when the page is built. The docs
// build (scripts/docs/extract.mjs) has already refused any link the registry
// would change or drop; checking again here means a page can never render a
// link the app would read differently, even if that check were skipped.

type LinkProps = { to?: string; q?: string; children?: ReactNode } & Record<string, unknown>;

const NOT_PARAMS = new Set(["to", "q", "children", "off"]);

function paramsOf(props: LinkProps): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof props.q === "string") for (const [k, v] of new URLSearchParams(props.q)) out[k] = v;
  for (const [k, v] of Object.entries(props)) if (!NOT_PARAMS.has(k) && typeof v === "string") out[k] = v;
  return out;
}

/** The /go address for a docs link, or null when it is not a link the docs may make. */
export function docsAppHref(to: string | undefined, params: Record<string, string>): string | null {
  if (!to || !links.isDestination(to) || !links.destination(to).docsLinkable) return null;
  const parsed = links.parseLink(to, params, { source: "docs" });
  if (parsed.problems.length || parsed.dest !== to) return null;
  return links.goHref(to, parsed.params);
}

/** Words that open a place in MAYA for a signed-in reader. */
export function AppLink(props: LinkProps) {
  const href = docsAppHref(props.to, paramsOf(props));
  if (!href) return <>{props.children}</>;
  return <AppLinkClient href={href}>{props.children}</AppLinkClient>;
}

/** A how-to's "open it in MAYA" button, pre-filled where the page says exactly what to enter. */
export function OpenInMaya(props: LinkProps) {
  const params = paramsOf(props);
  const href = docsAppHref(props.to, params);
  if (!href || !props.to) return null;
  const dest = links.destination(props.to);
  const note = dest.saveButton && links.fills(params) ? `Nothing is saved until you click ${dest.saveButton}.` : null;
  return (
    <OpenInMayaClient href={href} note={note}>
      {props.children ?? dest.label}
    </OpenInMayaClient>
  );
}
