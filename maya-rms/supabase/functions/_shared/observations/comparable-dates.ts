/**
 * Comparable-date selection for the Observation Engine.
 *
 * Finds the historical stay dates that are honestly "like" a target date:
 *
 * - Day of week is aligned strictly. July 25 2025 (a Friday) is never a
 *   comparable for July 25 2026 (a Saturday), no matter how tidy the
 *   calendar match looks.
 * - Holiday dates match by holiday identity and offset, not calendar date:
 *   the Saturday after Thanksgiving matches the Saturday after Thanksgiving
 *   in earlier years. Fixed-date holidays prefer years with a similar
 *   weekday placement (July 4th on a Saturday vs on a Wednesday).
 * - Non-holiday dates match inside the same detected season, and never
 *   against holiday-context days.
 * - Closed periods, challenged dates, and anything the caller excludes are
 *   skipped outright.
 * - When history is too thin for strict matching, the search relaxes in
 *   documented tiers (same weekend/weekday class, then nearby weeks in
 *   prior years) and says so in the assumptions.
 *
 * Every comparable carries its reasons; the assumptions block is what the
 * drill-down UI renders and what "challenge an assumption" edits.
 */

import {
  addDays,
  dayOfWeek,
  dayOfWeekName,
  dayOfYearIndex,
  daysBetween,
  dowClass,
  holidayContextForDate,
  holidayDateInYear,
  holidayPlacement,
  keyToHuman,
  circularDayDistance,
  type DowClass,
  type HolidayContext,
} from "./calendar.ts";
import { seasonForDate, type SeasonModel } from "./seasons.ts";

/* ── Tunables ────────────────────────────────────────────────── */

export const MAX_COMPARABLES = 8;
export const MIN_TARGET_COMPARABLES = 4;
export const MAX_YEARS_BACK = 3;
/** Fallback season window (± days around the target's day of year) when no season model exists. */
export const NO_MODEL_SEASON_SPAN_DAYS = 45;

/* ── Types ───────────────────────────────────────────────────── */

export type ComparableTier = 1 | 2 | 3;

export interface ComparableDate {
  date: string;
  tier: ComparableTier;
  reasons: string[];
  score: number;
}

export interface ComparableAssumptions {
  dayOfWeek: string;
  dowClass: DowClass;
  holiday: HolidayContext | null;
  seasonLabel: string | null;
  seasonRange: string | null;
  /** True when strict matching starved and a relaxation tier was used. */
  relaxed: boolean;
}

export interface ComparableSelection {
  target: string;
  comparables: ComparableDate[];
  assumptions: ComparableAssumptions;
}

export interface SelectComparableOptions {
  /** Season model from detectSeasons; null falls back to a nearby-weeks window. */
  seasonModel?: SeasonModel | null;
  /** First date with usable history. */
  historyStart: string;
  /** Last fully observed date (usually yesterday relative to as-of). */
  historyEnd: string;
  /** Closed periods, challenged dates, renovations — never comparable. */
  isExcluded?: (date: string) => boolean;
  maxComparables?: number;
  maxYearsBack?: number;
}

/* ── Helpers ─────────────────────────────────────────────────── */

/**
 * Labels a comparable by how long ago it falls, for the drill-down's
 * "reasons" text — which sits one line above the comparable's own date
 * (with its year printed in full). A pure elapsed-day bucket doesn't know
 * about calendar-year boundaries: every comparable is at or before
 * historyEnd (always yesterday or earlier) and every target is a future
 * stay date, so for any target in roughly the first ten months of a
 * calendar year, the closest same-day-of-week comparables routinely land
 * in the PREVIOUS calendar year while still only weeks away — a day-count
 * bucket alone called that "earlier this year," directly contradicting the
 * year printed right next to it.
 *
 * Comparing calendar years directly fixes that, but naively — "different
 * year, so it must be about a year back" — creates the opposite mistake at
 * the boundary itself: a candidate just 1-2 weeks before target that
 * happens to cross Dec 31/Jan 1 is genuinely recent, not "about a year
 * earlier." Recency wins for a short crossing; the calendar-year label
 * only applies once the gap is large enough that "recent" would itself be
 * misleading.
 */
function yearsAgoText(target: string, candidate: string): string {
  const days = daysBetween(candidate, target);
  const targetYear = Number(target.slice(0, 4));
  const candidateYear = Number(candidate.slice(0, 4));
  if (candidateYear === targetYear) return "earlier this year";
  if (days < 45) return "recently";
  const yearsBack = Math.max(1, targetYear - candidateYear);
  return yearsBack === 1 ? "about a year earlier" : `${yearsBack} years earlier`;
}

function offsetText(offset: number): string {
  if (offset === 0) return "the holiday itself";
  const n = Math.abs(offset);
  const unit = n === 1 ? "day" : "days";
  return offset < 0 ? `${n} ${unit} before the holiday` : `${n} ${unit} after the holiday`;
}

/* ── Selection ───────────────────────────────────────────────── */

export function selectComparableDates(
  target: string,
  opts: SelectComparableOptions,
): ComparableSelection {
  const {
    seasonModel = null,
    historyStart,
    historyEnd,
    isExcluded = () => false,
    maxComparables = MAX_COMPARABLES,
    maxYearsBack = MAX_YEARS_BACK,
  } = opts;

  const targetDow = dayOfWeek(target);
  const targetCtx = holidayContextForDate(target);
  const usable = (date: string) =>
    date >= historyStart && date <= historyEnd && !isExcluded(date);

  const comparables: ComparableDate[] = [];
  let relaxed = false;

  if (targetCtx) {
    // Holiday targets: same holiday, same offset, in earlier years. Anchor
    // on the YEAR THE HOLIDAY ITSELF FALLS IN (targetCtx.holidayDate),
    // never the target date's own calendar year — a date can carry a
    // holiday context from the NEXT calendar year (Dec 31 sits 1 day
    // before New Year's Day of year+1, closer than Christmas), and anchoring
    // on the target's year in that case silently skips the most recent real
    // occurrence and reaches an extra year further back than intended.
    const anchorYear = Number(targetCtx.holidayDate.slice(0, 4));
    for (let back = 1; back <= maxYearsBack; back++) {
      const holidayThatYear = holidayDateInYear(targetCtx.key, anchorYear - back);
      const candidate = addDays(holidayThatYear, targetCtx.offset);
      if (!usable(candidate)) continue;
      const candidateCtx = holidayContextForDate(candidate);
      // The placement bonus is about whether THIS holiday landed on a
      // similar weekday in the candidate year — computed from the target's
      // own holiday date that year, never from candidateCtx.placement,
      // which describes whichever holiday the candidate happens to sit
      // nearest to and can be a different one entirely (see below).
      const placementMatch = holidayPlacement(dayOfWeek(holidayThatYear)) === targetCtx.placement;
      // Two holidays with overlapping influence windows (Juneteenth/Father's
      // Day, Valentine's/Presidents Day) can put the reconstructed candidate
      // date closer to a DIFFERENT holiday than the one it was built from.
      // That candidate's demand driver isn't the one being priced for, so it
      // is demoted rather than trusted at full strength — but not thrown
      // out, since it's still the same time of year and often still a
      // reasonable comparison.
      const crossHoliday = !!candidateCtx && candidateCtx.key !== targetCtx.key;
      const reasons = [
        `${targetCtx.label} ${anchorYear - back}`,
        offsetText(targetCtx.offset),
      ];
      if (placementMatch) reasons.push("similar weekend placement");
      if (crossHoliday) reasons.push(`also ${candidateCtx!.label} that year`);
      comparables.push({
        date: candidate,
        tier: crossHoliday ? 2 : 1,
        reasons,
        score: (crossHoliday ? 4_000 : 10_000) - back * 1_000 + (placementMatch ? 500 : 0),
      });
    }
  } else {
    const targetSeason = seasonModel ? seasonForDate(seasonModel, target) : null;
    const targetIdx = dayOfYearIndex(target);
    const horizonStart =
      historyStart > addDays(target, -maxYearsBack * 366)
        ? historyStart
        : addDays(target, -maxYearsBack * 366);

    const sameRegime = (date: string): boolean => {
      if (targetSeason && seasonModel) {
        return seasonForDate(seasonModel, date).id === targetSeason.id;
      }
      return circularDayDistance(dayOfYearIndex(date), targetIdx) <= NO_MODEL_SEASON_SPAN_DAYS;
    };

    const seasonReason = targetSeason
      ? `your ${targetSeason.label}`
      : "a similar time of year";

    // Tier 1: same day of week, same season, no holiday context.
    for (let d = addDays(target, -7); d >= horizonStart; d = addDays(d, -7)) {
      if (!usable(d)) continue;
      if (holidayContextForDate(d) !== null) continue;
      if (!sameRegime(d)) continue;
      comparables.push({
        date: d,
        tier: 1,
        reasons: [`a ${dayOfWeekName(target)}`, seasonReason, yearsAgoText(target, d)],
        score: 10_000 - daysBetween(d, target),
      });
    }

    // Tier 2: same weekend/weekday class inside the season.
    if (comparables.length < MIN_TARGET_COMPARABLES) {
      relaxed = true;
      const chosen = new Set(comparables.map((c) => c.date));
      for (let d = addDays(target, -1); d >= horizonStart; d = addDays(d, -1)) {
        if (comparables.length >= maxComparables) break;
        if (chosen.has(d) || !usable(d)) continue;
        const dow = dayOfWeek(d);
        if (dow === targetDow || dowClass(dow) !== dowClass(targetDow)) continue;
        if (holidayContextForDate(d) !== null) continue;
        if (!sameRegime(d)) continue;
        chosen.add(d);
        comparables.push({
          date: d,
          tier: 2,
          reasons: [
            `a ${dayOfWeekName(d)}, similar to a ${dayOfWeekName(target)}`,
            seasonReason,
            yearsAgoText(target, d),
          ],
          score: 5_000 - daysBetween(d, target),
        });
      }
    }

    // Tier 3: same day of week in nearby weeks of prior years, season ignored.
    if (comparables.length < MIN_TARGET_COMPARABLES) {
      relaxed = true;
      const chosen = new Set(comparables.map((c) => c.date));
      for (let d = addDays(target, -7); d >= horizonStart; d = addDays(d, -7)) {
        if (comparables.length >= maxComparables) break;
        if (chosen.has(d) || !usable(d)) continue;
        if (holidayContextForDate(d) !== null) continue;
        if (circularDayDistance(dayOfYearIndex(d), targetIdx) > NO_MODEL_SEASON_SPAN_DAYS) continue;
        chosen.add(d);
        comparables.push({
          date: d,
          tier: 3,
          reasons: [
            `a ${dayOfWeekName(target)}`,
            "a nearby time of year",
            yearsAgoText(target, d),
          ],
          score: 2_000 - daysBetween(d, target),
        });
      }
    }
  }

  comparables.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  const picked = comparables.slice(0, maxComparables);

  const targetSeasonForAssumptions =
    !targetCtx && seasonModel ? seasonForDate(seasonModel, target) : null;

  return {
    target,
    comparables: picked,
    assumptions: {
      dayOfWeek: dayOfWeekName(target),
      dowClass: dowClass(targetDow),
      holiday: targetCtx,
      seasonLabel: targetSeasonForAssumptions?.label ?? null,
      seasonRange: targetSeasonForAssumptions
        ? `${keyToHuman(targetSeasonForAssumptions.startKey)} through ${keyToHuman(targetSeasonForAssumptions.endKey)}`
        : null,
      relaxed,
    },
  };
}

/* ── Explainability ──────────────────────────────────────────── */

/** Level 2 text: how the comparison set was chosen, in plain words. */
export function describeComparableSelection(sel: ComparableSelection): string {
  const parts: string[] = [];
  if (sel.assumptions.holiday) {
    const h = sel.assumptions.holiday;
    parts.push(
      `We compared this date with ${h.label} in earlier years, lining up ${offsetText(h.offset)} each time.`,
    );
  } else {
    const season = sel.assumptions.seasonLabel
      ? `your ${sel.assumptions.seasonLabel}`
      : "a similar time of year";
    parts.push(
      `We compared this ${sel.assumptions.dayOfWeek} with other ${sel.assumptions.dayOfWeek}s in ${season}, skipping holidays and dates marked as unusual.`,
    );
  }
  if (sel.assumptions.relaxed) {
    parts.push("Your history is thin here, so we widened the comparison slightly.");
  }
  return parts.join(" ");
}
