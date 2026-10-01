/**
 * Someone on the property switching it between simulation and live, as a
 * change log line where it happened (hotel_mode_history 'switch' rows, read
 * by modeSwitchesFrom in price-mode.ts):
 *
 *   "Sam took pricing live. From the next cycle, MAYA sends its prices to Cloudbeds."
 *   "Sam switched pricing back to simulation. MAYA stopped sending prices to Cloudbeds."
 *
 * The line marks the moment the change log's wording changes: runs before it
 * say what would have happened, runs after it what was sent. It says what
 * going live does, not that a given price went out: each change's own line
 * says that, from the send ledger. MAYA support's switch in the Command
 * Center is already a support change ("Took pricing live."), and its row
 * names nobody, so it is not repeated here. Client-safe.
 */

import { pmsLabel, pmsSendsPrices, type ModeSwitch } from "@/lib/price-mode";
import type { ChangelogItem, ChangelogModeSwitch } from "@/types/domain";

export function isModeSwitch(item: ChangelogItem): item is ChangelogModeSwitch {
  return "kind" in item && item.kind === "mode_switch";
}

/** The line for one switch. `who` is the person's name, "MAYA support", or "A manager" when not known. */
export function modeSwitchTitle(to: ModeSwitch["to"], who: string, pmsType: string | null | undefined): string {
  const pms = pmsLabel(pmsType);
  const sends = pmsType == null || pmsSendsPrices(pmsType);
  if (to === "live") {
    return sends
      ? `${who} took pricing live. From the next cycle, MAYA sends its prices to ${pms}.`
      : `${who} took pricing live. MAYA doesn't send prices to ${pms} yet, so nothing goes to it.`;
  }
  return sends
    ? `${who} switched pricing back to simulation. MAYA stopped sending prices to ${pms}.`
    : `${who} switched pricing back to simulation.`;
}

/** The switches as change log items, newest first. */
export function buildModeSwitches(
  switches: readonly ModeSwitch[],
  p: { names: Map<string, string>; pmsType: string | null | undefined },
): ChangelogModeSwitch[] {
  return [...switches]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((s) => ({
      kind: "mode_switch" as const,
      id: `mode|${s.to}|${s.at}`,
      timestamp: s.at,
      to: s.to,
      title: modeSwitchTitle(s.to, p.names.get(s.by) ?? "A manager", p.pmsType),
    }));
}
