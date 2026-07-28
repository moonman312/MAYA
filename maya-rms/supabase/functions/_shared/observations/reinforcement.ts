/**
 * Reinforcement: how owners challenge assumptions without ever editing
 * outputs directly.
 *
 * Per the product doctrine: users never set "Expected Bookings = 10". They
 * flag that a specific date isn't a fair comparison and say why — a
 * holiday we don't model, a one-off local event, a renovation. Every
 * challenge always does one safe, contained thing immediately: the exact
 * date they flagged stops being used as a comparable or as season-modeling
 * input. Anything bigger than that — generalizing the fix to every future
 * occurrence of a recurring pattern, or feeding it into the season model
 * itself — requires multiple independent reports pointing the same
 * direction first. A single disgruntled correction should never be able to
 * bend the model; a real recurring pattern, reported a few times over a
 * few years, should.
 *
 * Scope ladder (each level does strictly more than the one below it):
 * - "this_date": only this exact instance is set aside. Always applied
 *   immediately — the blast radius is one date, so there is nothing to
 *   overfit.
 * - "annual": the owner believes this happens every year (an annual
 *   festival, a recurring closure window). Generalizes to a whole
 *   recurring calendar window, once corroborated by CORROBORATION_DISTINCT_DATES
 *   distinct dates.
 * - "improve_future": the owner believes this should also stop distorting
 *   the season model itself (the window shouldn't count as "normal"
 *   Winter/Summer/whatever demand). Requires the most corroboration, since
 *   it changes shared model output, not just one comparison.
 *
 * Corroboration is counted by DISTINCT dates, not distinct challenges — one
 * person flagging the same date five times is one data point, not five.
 */

import {
  addDays,
  circularDayDistance,
  dayOfYearIndex,
  foldedKeyIndex,
  keyToHuman,
  YEAR_KEYS,
} from "./calendar.ts";
import type { DatePeriod } from "./seasons.ts";

/* ── Challenge catalog ───────────────────────────────────────── */

export type ChallengeCategory = "calendar" | "property" | "market" | "external" | "data" | "other";

export interface ChallengeReason {
  key: string;
  label: string;
  category: ChallengeCategory;
  /** UI guidance only — which scopes make sense to offer for this reason. */
  suggestedScopes: ChallengeScope[];
}

export const CHALLENGE_REASONS: ChallengeReason[] = [
  { key: "holiday", label: "Holiday We Don't Have Modeled", category: "calendar", suggestedScopes: ["this_date", "annual", "improve_future"] },
  { key: "local_event", label: "Local Event or Festival", category: "calendar", suggestedScopes: ["this_date", "annual", "improve_future"] },
  { key: "sporting_event", label: "Sporting Event or Tournament", category: "calendar", suggestedScopes: ["this_date", "annual", "improve_future"] },
  { key: "conference", label: "Conference or Convention", category: "market", suggestedScopes: ["this_date", "annual", "improve_future"] },
  { key: "renovation", label: "Renovation or Rooms Out of Service", category: "property", suggestedScopes: ["this_date", "improve_future"] },
  { key: "utility_or_amenity_outage", label: "Utility or Amenity Outage", category: "property", suggestedScopes: ["this_date", "improve_future"] },
  { key: "group_buyout", label: "Group Buyout", category: "market", suggestedScopes: ["this_date"] },
  { key: "competitor_disruption", label: "Nearby Competitor Closed or Sold Out", category: "market", suggestedScopes: ["this_date", "improve_future"] },
  { key: "severe_weather", label: "Severe Weather", category: "external", suggestedScopes: ["this_date", "annual"] },
  { key: "road_or_transit_disruption", label: "Road, Transit, or Flight Disruption", category: "external", suggestedScopes: ["this_date"] },
  { key: "data_or_sync_issue", label: "Booking Data Looks Wrong", category: "data", suggestedScopes: ["this_date"] },
  { key: "other", label: "Other", category: "other", suggestedScopes: ["this_date", "annual", "improve_future"] },
];

const REASON_BY_KEY = new Map(CHALLENGE_REASONS.map((r) => [r.key, r]));

export function isKnownChallengeReason(key: string): boolean {
  return REASON_BY_KEY.has(key);
}

export function challengeReasonLabel(key: string): string {
  return REASON_BY_KEY.get(key)?.label ?? key;
}

/* ── Challenges ──────────────────────────────────────────────── */

export type ChallengeScope = "this_date" | "annual" | "improve_future";

export interface AssumptionChallenge {
  id: string;
  /** The stay date the owner is challenging as non-comparable. */
  date: string;
  reasonKey: string;
  /** Required and shown verbatim when reasonKey === "other". */
  otherText?: string;
  scope: ChallengeScope;
  /** ISO date the challenge was raised — caller-supplied, never computed here. */
  raisedAt: string;
  raisedBy?: string;
}

export interface CreateChallengeInput {
  id: string;
  date: string;
  reasonKey: string;
  otherText?: string;
  scope: ChallengeScope;
  raisedAt: string;
  raisedBy?: string;
}

/** Validates and constructs a challenge. Throws on an unknown reason or a missing "Other" explanation. */
export function createChallenge(input: CreateChallengeInput): AssumptionChallenge {
  if (!isKnownChallengeReason(input.reasonKey)) {
    throw new Error(`Unknown challenge reason: ${input.reasonKey}`);
  }
  if (input.reasonKey === "other" && !input.otherText?.trim()) {
    throw new Error('"Other" challenges require otherText explaining the reason.');
  }
  return { ...input };
}

/* ── Corroboration thresholds ────────────────────────────────── */

/** Distinct dates required before a scope generalizes beyond its own instance. */
export const CORROBORATION_DISTINCT_DATES: Record<ChallengeScope, number> = {
  this_date: 1,
  annual: 2,
  improve_future: 3,
};

/** Calendar-day tolerance for treating two challenged dates as "the same recurring thing". */
export const RECURRENCE_TOLERANCE_DAYS = 5;

/** Challenges older than this, relative to `now`, stop counting toward corroboration. */
export const CORROBORATION_MAX_AGE_YEARS = 3;

/* ── Model ───────────────────────────────────────────────────── */

export interface PendingCluster {
  reasonKey: string;
  scope: ChallengeScope;
  dates: string[];
  centerKey: string;
  count: number;
  needed: number;
}

export interface PromotedWindow {
  reasonKey: string;
  scope: "annual" | "improve_future";
  centerKey: string;
  toleranceDays: number;
  supportingDates: string[];
}

export interface ReinforcementModel {
  /** Exact dates to always exclude — one per raised challenge, any scope, no corroboration needed. */
  instanceExclusions: Set<string>;
  /** Corroborated recurring-window exclusions (annual scope and up) — exclude from comparisons every year. */
  promotedAnnualWindows: PromotedWindow[];
  /** Corroborated structural exclusions (improve_future only) — also exclude from season detection's input. */
  promotedSeasonExclusionWindows: PromotedWindow[];
  /** Clusters short of their threshold, with progress for transparent messaging. */
  pending: PendingCluster[];
}

function dedupeByDate(list: AssumptionChallenge[]): AssumptionChallenge[] {
  const seen = new Map<string, AssumptionChallenge>();
  for (const c of list) if (!seen.has(c.date)) seen.set(c.date, c);
  return [...seen.values()];
}

/** Union-find over circular day-of-year distance: groups dates that recur "in the same spot" each year. */
function clusterByProximity(dates: string[], toleranceDays: number): number[] {
  const idx = dates.map((d) => dayOfYearIndex(d));
  const parent = dates.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i: number, j: number) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }
  for (let i = 0; i < dates.length; i++) {
    for (let j = i + 1; j < dates.length; j++) {
      if (circularDayDistance(idx[i], idx[j]) <= toleranceDays) union(i, j);
    }
  }
  return dates.map((_, i) => find(i));
}

function medianFoldedKey(dates: string[]): string {
  const idxs = dates.map((d) => dayOfYearIndex(d)).sort((a, b) => a - b);
  return YEAR_KEYS[idxs[Math.floor(idxs.length / 2)]];
}

export interface BuildReinforcementModelOptions {
  /** As-of date; challenges are age-filtered relative to this, never to a clock read internally. */
  now: string;
  maxAgeYears?: number;
  toleranceDays?: number;
}

export function buildReinforcementModel(
  challenges: AssumptionChallenge[],
  opts: BuildReinforcementModelOptions,
): ReinforcementModel {
  const maxAgeYears = opts.maxAgeYears ?? CORROBORATION_MAX_AGE_YEARS;
  const toleranceDays = opts.toleranceDays ?? RECURRENCE_TOLERANCE_DAYS;
  const cutoff = addDays(opts.now, -maxAgeYears * 365);
  const fresh = challenges.filter((c) => c.raisedAt >= cutoff && c.raisedAt <= opts.now);

  const instanceExclusions = new Set(fresh.map((c) => c.date));
  const promotedAnnualWindows: PromotedWindow[] = [];
  const promotedSeasonExclusionWindows: PromotedWindow[] = [];
  const pending: PendingCluster[] = [];

  for (const scope of ["annual", "improve_future"] as const) {
    const byReason = new Map<string, AssumptionChallenge[]>();
    for (const c of fresh) {
      if (c.scope !== scope) continue;
      const list = byReason.get(c.reasonKey);
      if (list) list.push(c);
      else byReason.set(c.reasonKey, [c]);
    }

    for (const [reasonKey, list] of byReason) {
      const uniqueByDate = dedupeByDate(list);
      const dates = uniqueByDate.map((c) => c.date);
      const clusterIds = clusterByProximity(dates, toleranceDays);
      const groups = new Map<number, string[]>();
      dates.forEach((d, i) => {
        const id = clusterIds[i];
        const g = groups.get(id);
        if (g) g.push(d);
        else groups.set(id, [d]);
      });

      for (const groupDates of groups.values()) {
        const sorted = [...groupDates].sort();
        const needed = CORROBORATION_DISTINCT_DATES[scope];
        const centerKey = medianFoldedKey(sorted);

        if (sorted.length >= needed) {
          const promoted: PromotedWindow = {
            reasonKey,
            scope,
            centerKey,
            toleranceDays,
            supportingDates: sorted,
          };
          promotedAnnualWindows.push(promoted);
          if (scope === "improve_future") promotedSeasonExclusionWindows.push(promoted);
        } else {
          pending.push({ reasonKey, scope, dates: sorted, centerKey, count: sorted.length, needed });
        }
      }
    }
  }

  return { instanceExclusions, promotedAnnualWindows, promotedSeasonExclusionWindows, pending };
}

/* ── Consuming the model ─────────────────────────────────────── */

/** True when `date` should be treated as a non-comparable, per every challenge raised so far. */
export function isDateReinforcementExcluded(model: ReinforcementModel, date: string): boolean {
  if (model.instanceExclusions.has(date)) return true;
  const idx = dayOfYearIndex(date);
  return model.promotedAnnualWindows.some(
    (w) => circularDayDistance(idx, foldedKeyIndex(w.centerKey)) <= w.toleranceDays,
  );
}

/** Builds an `isExcluded` closure compatible with selectComparableDates's options. */
export function reinforcementExclusionPredicate(model: ReinforcementModel): (date: string) => boolean {
  return (date) => isDateReinforcementExcluded(model, date);
}

/**
 * Expands a promoted window into concrete [start, end] periods per calendar
 * year — ready to feed directly into detectSeasons's `exclusions` option
 * alongside closed periods.
 */
export function expandPromotedWindowToPeriods(
  window: PromotedWindow,
  fromYear: number,
  toYear: number,
): DatePeriod[] {
  const periods: DatePeriod[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    const center = `${y}-${window.centerKey}`;
    periods.push({
      start_date: addDays(center, -window.toleranceDays),
      end_date: addDays(center, window.toleranceDays),
    });
  }
  return periods;
}

/** All season-exclusion windows expanded across a year span — the direct input to detectSeasons. */
export function seasonExclusionPeriods(
  model: ReinforcementModel,
  fromYear: number,
  toYear: number,
): DatePeriod[] {
  return model.promotedSeasonExclusionWindows.flatMap((w) =>
    expandPromotedWindowToPeriods(w, fromYear, toYear),
  );
}

/* ── Explainability ──────────────────────────────────────────── */

export function describeInstanceExclusion(reasonKey: string, otherText?: string): string {
  const label = reasonKey === "other" && otherText ? otherText : challengeReasonLabel(reasonKey);
  return `You told us this date was affected by ${label.toLowerCase()}, so we leave it out of comparisons.`;
}

export function describePendingProgress(cluster: PendingCluster): string {
  const label = challengeReasonLabel(cluster.reasonKey);
  const consequence =
    cluster.scope === "annual"
      ? "a pattern that repeats every year"
      : "a change to how we read the season around here";
  return `We have seen ${cluster.count} of the ${cluster.needed} reports we would want before treating "${label}" near ${keyToHuman(cluster.centerKey)} as ${consequence}.`;
}

export function describePromotedWindow(window: PromotedWindow): string {
  const label = challengeReasonLabel(window.reasonKey);
  const consequence =
    window.scope === "improve_future"
      ? "we now leave it out of comparisons and out of our seasonal calculations, every year"
      : "we now leave it out of comparisons every year";
  const count = window.supportingDates.length;
  const times = count === 1 ? "1 report" : `${count} separate reports`;
  return `${times} flagged "${label}" near ${keyToHuman(window.centerKey)}, so ${consequence}.`;
}
