import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import sections from "@/lib/docs/sections.json";

/**
 * The docs helper's count of questions asked, for the Command Center
 * (99_supabase_migration_docs_ask_tally_v1.sql). Reads run under the admin's
 * own session through two functions that respect row level security, so
 * the policy decides who sees the counts. Everything past the read is pure
 * and tested (docs-tally.test.ts).
 */

export const TALLY_OUTCOMES = ["answered", "canned", "unsure", "none"] as const;
export type TallyOutcome = (typeof TALLY_OUTCOMES)[number];

/** Plain words for each kind of reply. */
export const OUTCOME_LABEL: Record<TallyOutcome, string> = {
  answered: "From the docs",
  canned: "Set reply",
  unsure: "Might help",
  none: "No answer",
};

export type TallyTotals = {
  asked: number;
  byOutcome: Record<TallyOutcome, number>;
  /** answered from the docs plus set replies, as a share of asked (0 to 1), or null with nothing asked */
  answeredShare: number | null;
  /** no answer, as a share of asked (0 to 1), or null with nothing asked */
  noneShare: number | null;
};

const zero = (): Record<TallyOutcome, number> => ({ answered: 0, canned: 0, unsure: 0, none: 0 });
const isOutcome = (o: unknown): o is TallyOutcome => TALLY_OUTCOMES.includes(o as TallyOutcome);

export function totalsFrom(rows: { outcome: string; n: number | string }[]): TallyTotals {
  const byOutcome = zero();
  for (const r of rows) if (isOutcome(r.outcome)) byOutcome[r.outcome] += Number(r.n) || 0;
  const asked = TALLY_OUTCOMES.reduce((n, o) => n + byOutcome[o], 0);
  return {
    asked,
    byOutcome,
    answeredShare: asked ? (byOutcome.answered + byOutcome.canned) / asked : null,
    noneShare: asked ? byOutcome.none / asked : null,
  };
}

/** A row of docs_ask_tally_weekly: grouped by week and outcome, and by one of signed_in, section or app_area. */
export type WeeklyRow = {
  week: string;
  outcome: string;
  signed_in: boolean | null;
  section: string | null;
  app_area: string | null;
  n: number | string;
};

export type WeekLine = {
  /** Monday, YYYY-MM-DD */
  week: string;
  asked: number;
  byOutcome: Record<TallyOutcome, number>;
  signedIn: number;
  signedOut: number;
};

export type PlaceLine = {
  key: string;
  label: string;
  /** asked per week, in the order of `weeks` */
  perWeek: number[];
  asked: number;
  none: number;
};

export type WeeklyTally = {
  weeks: string[];
  lines: WeekLine[];
  /** where it was asked: the docs home, the support page or a docs section */
  places: PlaceLine[];
  /** the MAYA screen whose Help link opened the docs, for questions that came that way */
  areas: PlaceLine[];
};

const DAY = 86_400_000;

/** The Monday on or before a YYYY-MM-DD day. */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * DAY).toISOString().slice(0, 10);
}

/** The Mondays of the last `count` weeks up to the one holding `today`, oldest first. */
export function weeksEndingAt(today: string, count: number): string[] {
  const last = Date.parse(`${mondayOf(today)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(last - (count - 1 - i) * 7 * DAY).toISOString().slice(0, 10));
}

const SECTION_LABEL = new Map<string, string>(sections.map((s) => [s.slug, s.label]));

export function placeLabel(key: string): string {
  if (key === "home") return "Docs home";
  if (key === "support") return "Support page";
  return SECTION_LABEL.get(key) ?? key;
}

/** Plain words for a MAYA screen id from lib/deep-links/registry.json (help.screens). */
export function areaLabel(key: string): string {
  const words: Record<string, string> = {
    calendar: "Calendar",
    rules: "Rules",
    "rules.builder": "Rule builder",
    simulator: "Rate Simulator",
    changelog: "Change Log",
    pms: "PMS",
    settings: "Settings",
    team: "Team",
    billing: "Billing",
    review: "Review",
    questions: "The five questions",
    onboarding: "Setup",
    other: "Other screens",
  };
  return words[key] ?? key;
}

export function weeklyFrom(rows: WeeklyRow[], weeks: string[]): WeeklyTally {
  const at = new Map(weeks.map((w, i) => [w, i]));
  const lines: WeekLine[] = weeks.map((week) => ({ week, asked: 0, byOutcome: zero(), signedIn: 0, signedOut: 0 }));
  const places = new Map<string, PlaceLine>();
  const areas = new Map<string, PlaceLine>();
  const bump = (map: Map<string, PlaceLine>, key: string, label: string, i: number, n: number, outcome: TallyOutcome) => {
    let line = map.get(key);
    if (!line) {
      line = { key, label, perWeek: weeks.map(() => 0), asked: 0, none: 0 };
      map.set(key, line);
    }
    line.perWeek[i] += n;
    line.asked += n;
    if (outcome === "none") line.none += n;
  };
  for (const r of rows) {
    const i = at.get(String(r.week).slice(0, 10));
    const n = Number(r.n) || 0;
    if (i === undefined || !n || !isOutcome(r.outcome)) continue;
    if (r.signed_in !== null && r.signed_in !== undefined) {
      const line = lines[i];
      line.asked += n;
      line.byOutcome[r.outcome] += n;
      if (r.signed_in) line.signedIn += n;
      else line.signedOut += n;
    } else if (r.section !== null && r.section !== undefined) {
      bump(places, r.section, placeLabel(r.section), i, n, r.outcome);
    } else if (r.app_area) {
      bump(areas, r.app_area, areaLabel(r.app_area), i, n, r.outcome);
    }
  }
  const byAsked = (a: PlaceLine, b: PlaceLine) => b.asked - a.asked || a.label.localeCompare(b.label);
  return { weeks, lines, places: [...places.values()].sort(byAsked), areas: [...areas.values()].sort(byAsked) };
}

/** The last 30 days, today included, for the Command Center tile. */
export async function loadTallyTotals(ssr: SupabaseClient, today: string): Promise<TallyTotals> {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * DAY).toISOString().slice(0, 10);
  const { data, error } = await ssr.rpc("docs_ask_tally_counts", { p_since: since });
  if (error) throw new Error(error.message);
  return totalsFrom((data ?? []) as { outcome: string; n: number }[]);
}

/** The last `count` weeks, this one included, for /admin/docs-questions. */
export async function loadTallyWeekly(ssr: SupabaseClient, today: string, count = 12): Promise<WeeklyTally> {
  const weeks = weeksEndingAt(today, count);
  const { data, error } = await ssr.rpc("docs_ask_tally_weekly", { p_since: weeks[0] });
  if (error) throw new Error(error.message);
  return weeklyFrom((data ?? []) as WeeklyRow[], weeks);
}

/** A share as "12%" ("0.4%" under one percent), or "-" when nothing was asked. */
export function percent(share: number | null): string {
  if (share === null) return "-";
  const p = share * 100;
  return `${p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}
