/**
 * Links into MAYA, bound to the one registry (registry.json beside this file).
 *
 * The docs and the app share this: the docs build validates every docs link
 * with the same parser, /go/<destination> checks every link again, and a
 * landing page re-reads what arrived instead of trusting that /go ran.
 */

import registryJson from "./registry.json";
import { createLinks, docsHref, safeNext, type Registry } from "./core.mjs";

export const links = createLinks(registryJson as unknown as Registry);
export const registry = links.registry;

export { docsHref, safeNext };
export type { Arrival, DestinationSpec, ParsedLink, Registry } from "./core.mjs";

/** A "?" panel's docs passage, by its id in registry.help.panels. */
export function panelDocsHref(panel: HelpPanel): string {
  return docsHref(registry.help.panels[panel] ?? "");
}

/** The docs page about a screen, by its id in registry.help.screens. */
export function screenDocsHref(screen: string): string {
  return docsHref(registry.help.screens[screen] ?? "");
}

export type HelpPanel =
  | "rule-fires"
  | "stopped-nights"
  | "booking-speed"
  | "booking-speed-wait"
  | "split"
  | "rule-behavior"
  | "ask-for-help"
  | "alert-choice"
  | "alert-limit"
  | "manual-price"
  | "counts-as-room"
  | "out-of-service"
  | "roles"
  | "not-now"
  | "simulator"
  | "how-did-we-know"
  | "corrections"
  | "reconnect"
  | "go-live"
  | "room-count"
  | "rule-activation"
  | "no-rate"
  | "calendar-colors"
  | "settings-colours";
