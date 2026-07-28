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
 * itself — requires multiple independent YEARS of corroborating evidence
 * first. A single renovation that keeps three nights closed is one
 * incident, not three data points — corroboration is counted by distinct
 * YEARS represented, not distinct dates, so nothing about a single event
 * (however many nights it spans) can defeat this on its own. A single
 * disgruntled correction should never be able to bend the model; a real
 * recurring pattern, reported a few times over a few years, should.
 *
 * Scope ladder (each level does strictly more than the one below it):
 * - "this_date": only this exact instance is set aside. Always applied
 *   immediately — the blast radius is one date, so there is nothing to
 *   overfit. Deliberately NOT a recurrence claim: it never counts toward
 *   promoting a pattern.
 * - "annual": the owner believes this happens every year (an annual
 *   festival, a recurring closure window). Generalizes to a whole
 *   recurring calendar window, once corroborated by challenges spanning
 *   CORROBORATION_DISTINCT_YEARS distinct years.
 * - "improve_future": the owner believes this should also stop distorting
 *   the season model itself (the window shouldn't count as "normal"
 *   Winter/Summer/whatever demand). Requires the most corroboration, since
 *   it changes shared model output, not just one comparison.
 *
 * Because each level strictly contains the one below it, an improve_future
 * report is also evidence for the weaker annual claim: annual promotion
 * counts reports from BOTH pattern scopes, while season-model promotion
 * counts only explicit improve_future reports.
 *
 * "Distinct years" means distinct OCCURRENCES, not calendar-year strings:
 * a New Year's incident flagged on Dec 31 and Jan 1 is one occurrence even
 * though the dates straddle a calendar-year boundary — clustering already
 * bridges the Dec 31/Jan 1 seam, and year counting folds a
 * wrapped-into-January date back onto the occurrence anchored in the
 * previous year.
 */

import {
  YEAR_KEYS,
  addDays,
  circularDayDistance,
  dayOfYearIndex,
  foldedKeyIndex,
  keyToHuman,
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

/**
 * Distinct YEARS required before a scope generalizes beyond its own
 * instance — not distinct dates. A single incident (a renovation spanning
 * several nights, a storm week flagged on three separate stay-dates) is
 * still just one year of evidence no matter how many dates it touches;
 * only reports from genuinely different years show the pattern recurs.
 */
export const CORROBORATION_DISTINCT_YEARS: Record<ChallengeScope, number> = {
  this_date: 1,
  annual: 2,
  improve_future: 3,
};

/** Calendar-day tolerance for treating challenged dates as "the same recurring thing". */
export const RECURRENCE_TOLERANCE_DAYS = 5;

/** Challenges older than this, relative to `now`, stop counting toward corroboration. */
export const CORROBORATION_MAX_AGE_YEARS = 3;

/* ── Model ───────────────────────────────────────────────────── */

export interface PendingCluster {
  reasonKey: string;
  scope: ChallengeScope;
  dates: string[];
  centerKey: string;
  /** Distinct years represented so far. */
  count: number;
  needed: number;
}

export interface PromotedWindow {
  reasonKey: string;
  scope: "annual" | "improve_future";
  centerKey: string;
  toleranceDays: number;
  supportingDates: string[];
  /** Distinct occurrence-years of the supporting reports (seam-safe — see header). */
  distinctYears: number;
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

/** True calendar-year subtraction (not a fixed day count), so a Feb 29 in the span never shifts the boundary by a day. */
function yearsBefore(date: string, years: number): string {
  const year = Number(date.slice(0, 4)) - years;
  const rest = date.slice(5);
  if (rest === "02-29" && !((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) {
    return `${year}-02-28`;
  }
  return `${year}-${rest}`;
}

/**
 * Groups dates that recur "in the same spot" each year, anchoring each
 * cluster to the day-of-year of its own first (chronological, post-gap)
 * member rather than chaining pairwise — so every member of a cluster is
 * guaranteed within toleranceDays of that cluster's own anchor. Plain
 * single-linkage clustering can chain a string of pairwise-close dates
 * arbitrarily far from each other; anchoring bounds the whole cluster.
 *
 * Rotates to start right after the widest circular gap between sorted
 * points, so the walk never has to reason about wrapping past Dec 31/Jan 1
 * mid-cluster — the center this produces is a genuine circular median.
 */
function clusterDatesByProximity(
  dates: string[],
  toleranceDays: number,
): { dates: string[]; centerKey: string; occurrenceYearOf: Map<string, string> }[] {
  const n = dates.length;
  if (n === 0) return [];
  const items = dates.map((d) => ({ d, idx: dayOfYearIndex(d) }));
  const byIdx = [...items].sort((a, b) => a.idx - b.idx);

  let gapAfter = 0;
  let maxGap = -1;
  for (let k = 0; k < byIdx.length; k++) {
    const cur = byIdx[k].idx;
    const next = byIdx[(k + 1) % byIdx.length].idx;
    const gap = ((next - cur + 365) % 365) || 365;
    if (gap > maxGap) {
      maxGap = gap;
      gapAfter = k;
    }
  }

  const base = byIdx[(gapAfter + 1) % n].idx;
  const unwrapped = Array.from({ length: n }, (_, k) => {
    const item = byIdx[(gapAfter + 1 + k) % n];
    return { d: item.d, u: item.idx >= base ? item.idx : item.idx + 365 };
  });

  const groups: { d: string; u: number }[][] = [];
  let anchor = -Infinity;
  for (const item of unwrapped) {
    if (groups.length === 0 || item.u - anchor > toleranceDays) {
      groups.push([]);
      anchor = item.u;
    }
    groups[groups.length - 1].push(item);
  }

  return groups.map((g) => {
    const us = g.map((x) => x.u).sort((a, b) => a - b);
    const centerU = us[Math.floor(us.length / 2)];
    const foldedIdx = ((centerU % 365) + 365) % 365;
    // A member wrapped past the Dec 31/Jan 1 seam (u >= 365) is an
    // early-January date belonging to the occurrence anchored in the
    // PREVIOUS calendar year — Dec 31 + Jan 1 of one party is one
    // occurrence, not two years of evidence.
    const occurrenceYearOf = new Map(
      g.map((x) => [x.d, String(Number(x.d.slice(0, 4)) - (x.u >= 365 ? 1 : 0))]),
    );
    return { dates: g.map((x) => x.d), centerKey: YEAR_KEYS[foldedIdx], occurrenceYearOf };
  });
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
  const cutoff = yearsBefore(opts.now, maxAgeYears);
  const fresh = challenges.filter((c) => c.raisedAt >= cutoff && c.raisedAt <= opts.now);

  const instanceExclusions = new Set(fresh.map((c) => c.date));
  const promotedAnnualWindows: PromotedWindow[] = [];
  const promotedSeasonExclusionWindows: PromotedWindow[] = [];
  const pending: PendingCluster[] = [];

  // Pattern scopes are counted together per reason ("strictly more"): an
  // improve_future report is also evidence for the annual claim, so both
  // feed one clustering pass. Per date we keep only the strongest claim.
  const byReason = new Map<string, Map<string, "annual" | "improve_future">>();
  for (const c of fresh) {
    if (c.scope !== "annual" && c.scope !== "improve_future") continue;
    let scopeByDate = byReason.get(c.reasonKey);
    if (!scopeByDate) {
      scopeByDate = new Map();
      byReason.set(c.reasonKey, scopeByDate);
    }
    const prev = scopeByDate.get(c.date);
    if (!prev || (prev === "annual" && c.scope === "improve_future")) {
      scopeByDate.set(c.date, c.scope);
    }
  }

  for (const [reasonKey, scopeByDate] of byReason) {
    const clusters = clusterDatesByProximity([...scopeByDate.keys()], toleranceDays);

    for (const cluster of clusters) {
      const sorted = [...cluster.dates].sort();
      const allYears = new Set(sorted.map((d) => cluster.occurrenceYearOf.get(d)));
      const seasonDates = sorted.filter((d) => scopeByDate.get(d) === "improve_future");
      const seasonYears = new Set(seasonDates.map((d) => cluster.occurrenceYearOf.get(d)));

      // Season-model promotion wants explicit improve_future reports only,
      // and subsumes the annual window (one entry serves both arrays).
      if (seasonYears.size >= CORROBORATION_DISTINCT_YEARS.improve_future) {
        const promoted: PromotedWindow = {
          reasonKey,
          scope: "improve_future",
          centerKey: cluster.centerKey,
          toleranceDays,
          supportingDates: sorted,
          distinctYears: allYears.size,
        };
        promotedAnnualWindows.push(promoted);
        promotedSeasonExclusionWindows.push(promoted);
        continue;
      }

      if (allYears.size >= CORROBORATION_DISTINCT_YEARS.annual) {
        promotedAnnualWindows.push({
          reasonKey,
          scope: "annual",
          centerKey: cluster.centerKey,
          toleranceDays,
          supportingDates: sorted,
          distinctYears: allYears.size,
        });
      } else {
        pending.push({
          reasonKey,
          scope: "annual",
          dates: sorted,
          centerKey: cluster.centerKey,
          count: allYears.size,
          needed: CORROBORATION_DISTINCT_YEARS.annual,
        });
      }

      if (seasonYears.size >= 1) {
        pending.push({
          reasonKey,
          scope: "improve_future",
          dates: seasonDates,
          centerKey: cluster.centerKey,
          count: seasonYears.size,
          needed: CORROBORATION_DISTINCT_YEARS.improve_future,
        });
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
 * alongside closed periods. Pads one year on each side of the requested
 * range: a window centered late in the year also covers early days of the
 * FOLLOWING calendar year (and vice versa for one centered early), so
 * without the padding, dates isDateReinforcementExcluded already treats as
 * excluded could silently leak back into season-detection's input at
 * either edge of the caller's requested span.
 */
export function expandPromotedWindowToPeriods(
  window: PromotedWindow,
  fromYear: number,
  toYear: number,
): DatePeriod[] {
  const periods: DatePeriod[] = [];
  for (let y = fromYear - 1; y <= toYear + 1; y++) {
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
  const years = cluster.count === 1 ? "1 year" : `${cluster.count} different years`;
  const neededYears = cluster.needed === 1 ? "1 year" : `${cluster.needed} different years`;
  return `We have seen this reported in ${years} of the ${neededYears} we would want before treating "${label}" near ${keyToHuman(cluster.centerKey)} as ${consequence}.`;
}

export function describePromotedWindow(window: PromotedWindow): string {
  const label = challengeReasonLabel(window.reasonKey);
  const consequence =
    window.scope === "improve_future"
      ? "we now leave it out of comparisons and out of our seasonal calculations, every year"
      : "we now leave it out of comparisons every year";
  const times =
    window.distinctYears === 1 ? "1 year" : `${window.distinctYears} different years`;
  return `Reports across ${times} flagged "${label}" near ${keyToHuman(window.centerKey)}, so ${consequence}.`;
}
