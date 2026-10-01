/**
 * The strip at the top of every property screen that says which mode the
 * property is in (Jake, 2026-09-30: "I can't even tell that it's in
 * simulation mode"; approved audit item A41).
 *
 *   Simulating  a slim amber strip: "Simulation · MAYA works out prices but
 *               sends nothing to Cloudbeds", with Go live for the people who
 *               may switch it and a "?" for everyone.
 *   Live        a small green "Live" tag in the same spot, no strip.
 *
 * Go live is offered on the same terms as the review card's button and the
 * database's own check (enforce_simulation_mode_rank): a General Manager or
 * Hotel Admin of the property, by their own membership. MAYA staff looking at
 * a property they don't belong to (a platform admin's support view, God Mode
 * or not) never get it, and nor does anyone below General Manager: they are
 * told who can. A property on a system MAYA doesn't send prices to (Mews) has
 * nothing to switch on, so it gets no Go live either, here, on the review
 * card or from POST /api/onboarding/activate, which refuses it. With no
 * connection at all Go live is still offered; the confirm says nothing is
 * sent until one is.
 *
 * Pure: the route (/api/property/mode) builds it, the strip shows it.
 */

import { pmsLabel, pmsSendsPrices } from "@/lib/price-mode";
import { canManageFinances } from "@/lib/roles";

/** Connection statuses the scheduled sync does not pick up (claim_pms_sync_batch), as the go-live dialog reads them. */
const NOT_SYNCED = new Set(["disconnected", "pending"]);

export type PropertyMode = {
  mode: "simulation" | "live";
  /** pms_connections.pms_type of the connection prices go through, or null with none. */
  pmsType: string | null;
  /** Whether MAYA sends prices to that system at all. */
  sendsPrices: boolean;
  /** Whether the scheduled sync picks the connection up, for the confirm's words. */
  connected: boolean;
  /** Offer Go live: simulating, a system MAYA sends to (or none yet), and a General Manager or Hotel Admin. */
  canGoLive: boolean;
  /** The push window in nights, for the confirm. */
  windowDays: number | null;
};

/** The connection prices go through: a working one first, then one MAYA keeps trying, then any. */
export function pickConnection<T extends { pms_type?: unknown; status?: unknown }>(rows: readonly T[]): T | null {
  return (
    rows.find((r) => r.status === "connected" || r.status === "degraded") ?? rows.find((r) => r.status === "error") ?? rows[0] ?? null
  );
}

export function propertyMode(p: {
  /** hotel_settings.simulation_mode; a missing row is simulation, as the push reads it. */
  simulationMode: boolean | null | undefined;
  connections: readonly { pms_type?: unknown; status?: unknown }[];
  /** The person's own role on the property, from their membership; null without one. */
  memberRole: string | null;
  windowDays: number | null;
}): PropertyMode {
  const mode = p.simulationMode === false ? "live" : "simulation";
  const conn = pickConnection(p.connections);
  const pmsType = conn?.pms_type != null ? String(conn.pms_type) : null;
  const sendsPrices = pmsSendsPrices(pmsType);
  const connected = conn != null && conn.status != null && !NOT_SYNCED.has(String(conn.status));
  return {
    mode,
    pmsType,
    sendsPrices,
    connected,
    canGoLive: mode === "simulation" && (pmsType == null || sendsPrices) && canManageFinances(p.memberRole),
    windowDays: p.windowDays,
  };
}

/** The strip's one line: "Simulation · MAYA works out prices but sends nothing to Cloudbeds". */
export function simulationStripText(m: Pick<PropertyMode, "pmsType">): string {
  return `Simulation · MAYA works out prices but sends nothing to ${pmsLabel(m.pmsType)}`;
}

/** The go-live route's answer when the page shows another property than the active one (a switch in another tab). */
export const OTHER_PROPERTY = "This page is for another property. Reload and try again.";

/** Who may switch the property to live, for everyone else. */
export const WHO_CAN_GO_LIVE = "A General Manager or Hotel Admin can switch this property to live.";

/** The "?" beside the strip: what simulation means here, and how it ends. */
export function simulationHelp(m: Pick<PropertyMode, "pmsType" | "sendsPrices" | "canGoLive">): { title: string; lines: string[] } {
  const pms = pmsLabel(m.pmsType);
  const lines = [
    `Your rules run as they will live, and their prices show on the calendar and in the change log. ${m.pmsType ? pms : "Your property system"} keeps its own rates.`,
  ];
  lines.push(noGoLiveLine(m) ?? "Go live starts sending on the next cycle, about 5 minutes later. To go back to simulation, email us.");
  return { title: "Simulation", lines };
}

/**
 * Why there is no Go live, for someone who sees the property simulating
 * without it: nothing to switch on (a system MAYA doesn't send prices to), or
 * who can. Null when they can go live. The review card says it in place of
 * its button.
 */
export function noGoLiveLine(m: Pick<PropertyMode, "pmsType" | "sendsPrices" | "canGoLive">): string | null {
  if (m.canGoLive) return null;
  if (m.pmsType != null && !m.sendsPrices) return `MAYA doesn't send prices to ${pmsLabel(m.pmsType)} yet, so there is nothing to switch on here.`;
  return WHO_CAN_GO_LIVE;
}

/** The "?" beside the Live tag, only where it needs saying: nothing goes to a system MAYA doesn't send to. */
export function liveHelp(m: Pick<PropertyMode, "pmsType" | "sendsPrices">): { title: string; lines: string[] } | null {
  if (m.pmsType == null || m.sendsPrices) return null;
  return { title: "Live", lines: [`MAYA doesn't send prices to ${pmsLabel(m.pmsType)} yet, so nothing goes to it, live or not.`] };
}

/** The Live tag's hover words. */
export function liveTitle(m: Pick<PropertyMode, "pmsType" | "sendsPrices">): string {
  return m.sendsPrices ? `MAYA sends its prices to ${pmsLabel(m.pmsType)}.` : "Live";
}
