import { describe, expect, it } from "vitest";
import {
  CHALLENGE_REASONS,
  CORROBORATION_DISTINCT_YEARS,
  buildReinforcementModel,
  createChallenge,
  describeInstanceExclusion,
  describePendingProgress,
  describePromotedWindow,
  expandPromotedWindowToPeriods,
  isDateReinforcementExcluded,
  isKnownChallengeReason,
  reinforcementExclusionPredicate,
  seasonExclusionPeriods,
  type AssumptionChallenge,
} from "../../../supabase/functions/_shared/observations/reinforcement";

const NO_MATH_SYMBOLS = /[<>]/;

function challenge(
  overrides: Partial<AssumptionChallenge> & Pick<AssumptionChallenge, "id" | "date">,
): AssumptionChallenge {
  return createChallenge({
    reasonKey: "local_event",
    scope: "this_date",
    raisedAt: overrides.date,
    ...overrides,
  });
}

describe("challenge catalog", () => {
  it("has a dozen reasons including the requested five, several new ones, and Other", () => {
    expect(CHALLENGE_REASONS.length).toBeGreaterThanOrEqual(11);
    const keys = CHALLENGE_REASONS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const required of ["holiday", "local_event", "renovation", "group_buyout", "severe_weather", "other"]) {
      expect(keys).toContain(required);
    }
    expect(keys.length).toBeGreaterThan(6);
    expect(CHALLENGE_REASONS[CHALLENGE_REASONS.length - 1].key).toBe("other");
  });

  it("validates known reasons", () => {
    expect(isKnownChallengeReason("holiday")).toBe(true);
    expect(isKnownChallengeReason("made_up_reason")).toBe(false);
  });
});

describe("createChallenge", () => {
  it("rejects an unknown reason", () => {
    expect(() =>
      createChallenge({
        id: "c1",
        date: "2026-07-04",
        reasonKey: "not_a_reason",
        scope: "this_date",
        raisedAt: "2026-07-04",
      }),
    ).toThrow();
  });

  it("requires otherText for the Other reason", () => {
    expect(() =>
      createChallenge({
        id: "c1",
        date: "2026-07-04",
        reasonKey: "other",
        scope: "this_date",
        raisedAt: "2026-07-04",
      }),
    ).toThrow();
    expect(() =>
      createChallenge({
        id: "c1",
        date: "2026-07-04",
        reasonKey: "other",
        otherText: "Town flooded the parking lot",
        scope: "this_date",
        raisedAt: "2026-07-04",
      }),
    ).not.toThrow();
  });
});

describe("this_date scope: always applied immediately", () => {
  it("excludes a single flagged date with zero corroboration needed", () => {
    const model = buildReinforcementModel(
      [challenge({ id: "c1", date: "2026-07-04", reasonKey: "severe_weather", scope: "this_date" })],
      { now: "2026-07-05" },
    );
    expect(isDateReinforcementExcluded(model, "2026-07-04")).toBe(true);
    expect(isDateReinforcementExcluded(model, "2026-07-05")).toBe(false);
    expect(CORROBORATION_DISTINCT_YEARS.this_date).toBe(1);
  });
});

describe("corroboration is counted by distinct YEARS, not distinct dates", () => {
  it("does NOT promote a single incident just because it spans several dates in one year", () => {
    // The exact adversarial case: one renovation, three flagged nights,
    // all in the same year — this must not clear the improve_future bar.
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2025-03-10", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2025-03-12", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2025-03-14", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2025-03-15" },
    );
    expect(model.promotedSeasonExclusionWindows).toHaveLength(0);
    expect(model.promotedAnnualWindows).toHaveLength(0);
    // One cluster reports progress toward BOTH milestones it could reach:
    // the annual generalization (any pattern-scope report counts) and the
    // season-model change (explicit improve_future reports only).
    expect(model.pending).toHaveLength(2);
    const annualPending = model.pending.find((p) => p.scope === "annual");
    const seasonPending = model.pending.find((p) => p.scope === "improve_future");
    expect(annualPending?.count).toBe(1); // one distinct year, however many dates
    expect(annualPending?.needed).toBe(2);
    expect(seasonPending?.count).toBe(1);
    expect(seasonPending?.needed).toBe(3);
    // The three individual dates are still excluded outright (this_date-level safety).
    expect(isDateReinforcementExcluded(model, "2025-03-10")).toBe(true);
  });

  it("promotes once the SAME reason is reported across enough distinct years", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2023-03-10", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2024-03-12", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2025-03-11", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2025-03-15" },
    );
    expect(model.promotedSeasonExclusionWindows).toHaveLength(1);
  });

  it("does not let a single year's multiple reports masquerade as extra years", () => {
    // Four dates, but only two distinct years — still short of improve_future's 3.
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2024-03-10", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2024-03-11", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2024-03-12", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c4", date: "2025-03-11", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2025-03-15" },
    );
    expect(model.promotedSeasonExclusionWindows).toHaveLength(0);
    expect(model.pending[0].count).toBe(2);
  });
});

describe("years are occurrences, not calendar-year strings", () => {
  it("does NOT let one New Year's incident spanning Dec 31 and Jan 1 count as two years", () => {
    // One party, flagged in one sitting: the dates straddle the calendar
    // boundary but they are ONE occurrence — no promotion.
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2025-12-31", reasonKey: "local_event", scope: "annual", raisedAt: "2026-01-02" }),
        challenge({ id: "c2", date: "2026-01-01", reasonKey: "local_event", scope: "annual", raisedAt: "2026-01-02" }),
      ],
      { now: "2026-01-05" },
    );
    expect(model.promotedAnnualWindows).toHaveLength(0);
    expect(model.pending).toHaveLength(1);
    expect(model.pending[0].count).toBe(1);
  });

  it("still promotes a genuinely recurring New Year's pattern reported in two different years", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2024-12-31", reasonKey: "local_event", scope: "annual", raisedAt: "2025-01-02" }),
        challenge({ id: "c2", date: "2026-01-01", reasonKey: "local_event", scope: "annual", raisedAt: "2026-01-02" }),
      ],
      { now: "2026-01-05" },
    );
    // Dec 31 2024 belongs to the 2024/25 turn; Jan 1 2026 to the 2025/26
    // turn — two distinct occurrences, so the pattern is corroborated.
    expect(model.promotedAnnualWindows).toHaveLength(1);
    expect(model.promotedAnnualWindows[0].distinctYears).toBe(2);
  });

  it("does not halve the improve_future bar via boundary-spanning incidents", () => {
    // Two incidents (2024/25 turn and 2025/26 turn) touching three
    // calendar-year strings — still only two occurrence-years, short of 3.
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2024-12-31", reasonKey: "local_event", scope: "improve_future", raisedAt: "2025-01-02" }),
        challenge({ id: "c2", date: "2025-01-01", reasonKey: "local_event", scope: "improve_future", raisedAt: "2025-01-02" }),
        challenge({ id: "c3", date: "2025-12-30", reasonKey: "local_event", scope: "improve_future", raisedAt: "2026-01-02" }),
        challenge({ id: "c4", date: "2026-01-02", reasonKey: "local_event", scope: "improve_future", raisedAt: "2026-01-03" }),
      ],
      { now: "2026-01-05" },
    );
    expect(model.promotedSeasonExclusionWindows).toHaveLength(0);
    // Two occurrences DO earn the weaker annual generalization.
    expect(model.promotedAnnualWindows).toHaveLength(1);
    expect(model.promotedAnnualWindows[0].scope).toBe("annual");
  });
});

describe("pattern scopes corroborate each other (each level does strictly more)", () => {
  it("counts an improve_future report toward the annual threshold", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2024-07-10", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c2", date: "2025-07-11", reasonKey: "local_event", scope: "improve_future" }),
      ],
      { now: "2025-07-15" },
    );
    // Same reason, two years, two pattern-scope reports: the annual window
    // promotes even though the scopes differ.
    expect(model.promotedAnnualWindows).toHaveLength(1);
    expect(model.promotedAnnualWindows[0].scope).toBe("annual");
    // The season-model change still waits for explicit improve_future years.
    expect(model.promotedSeasonExclusionWindows).toHaveLength(0);
    const seasonPending = model.pending.find((p) => p.scope === "improve_future");
    expect(seasonPending?.count).toBe(1);
    expect(seasonPending?.needed).toBe(3);
  });

  it("never counts this_date reports toward any pattern", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2024-07-10", reasonKey: "local_event", scope: "this_date" }),
        challenge({ id: "c2", date: "2025-07-11", reasonKey: "local_event", scope: "annual" }),
      ],
      { now: "2025-07-15" },
    );
    // this_date is deliberately not a recurrence claim: only the annual
    // report counts, so nothing promotes.
    expect(model.promotedAnnualWindows).toHaveLength(0);
    const annualPending = model.pending.find((p) => p.scope === "annual");
    expect(annualPending?.count).toBe(1);
  });

  it("promotes the season change once three distinct years explicitly ask for it", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2023-07-10", reasonKey: "local_event", scope: "improve_future" }),
        challenge({ id: "c2", date: "2024-07-11", reasonKey: "local_event", scope: "improve_future" }),
        challenge({ id: "c3", date: "2025-07-12", reasonKey: "local_event", scope: "improve_future" }),
      ],
      { now: "2025-07-15" },
    );
    expect(model.promotedSeasonExclusionWindows).toHaveLength(1);
    // One promoted entry serves both arrays — no duplicate description.
    expect(model.promotedAnnualWindows).toHaveLength(1);
    expect(model.pending).toHaveLength(0);
  });
});

describe("annual scope", () => {
  it("does not generalize on a single year's report", () => {
    const model = buildReinforcementModel(
      [challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" })],
      { now: "2026-06-14" },
    );
    expect(isDateReinforcementExcluded(model, "2026-06-13")).toBe(true);
    expect(isDateReinforcementExcluded(model, "2025-06-14")).toBe(false);
    expect(model.pending).toHaveLength(1);
    expect(model.pending[0].count).toBe(1);
    expect(model.pending[0].needed).toBe(2);
    expect(model.promotedAnnualWindows).toHaveLength(0);
  });

  it("generalizes to the whole recurring window once a second distinct year corroborates", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "local_event", scope: "annual" }),
      ],
      { now: "2026-06-14" },
    );
    expect(model.promotedAnnualWindows).toHaveLength(1);
    expect(model.pending).toHaveLength(0);
    // A THIRD year's date near that window, never individually flagged,
    // is now excluded because the pattern generalized.
    expect(isDateReinforcementExcluded(model, "2024-06-15")).toBe(true);
    expect(isDateReinforcementExcluded(model, "2024-09-01")).toBe(false);
  });

  it("does not merge different reasons even when the dates are close", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "renovation", scope: "annual" }),
      ],
      { now: "2026-06-14" },
    );
    expect(model.promotedAnnualWindows).toHaveLength(0);
    expect(model.pending).toHaveLength(2);
  });
});

describe("anchor-based clustering does not chain beyond tolerance", () => {
  it("keeps a cluster's true diameter within toleranceDays of its own anchor, even under a pairwise-adjacent chain", () => {
    // Five dates, each exactly 5 days (the default tolerance) from the
    // next: 2018-01-01, 2019-01-06, 2020-01-11, 2021-01-16, 2022-01-21.
    // Naive single-linkage chaining would merge all five into one cluster
    // spanning 20 days — double the stated tolerance. Anchored clustering
    // must not let that happen: the promoted window(s) must actually cover
    // every date that corroborated them.
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2018-01-01", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c2", date: "2019-01-06", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c3", date: "2020-01-11", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c4", date: "2021-01-16", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c5", date: "2022-01-21", reasonKey: "local_event", scope: "annual" }),
      ],
      { now: "2022-01-21", maxAgeYears: 10 },
    );
    for (const promoted of model.promotedAnnualWindows) {
      for (const d of promoted.supportingDates) {
        expect(isDateReinforcementExcluded(model, d)).toBe(true);
      }
    }
    // Sanity: something was actually promoted (not everything left pending).
    const promotedDates = model.promotedAnnualWindows.flatMap((w) => w.supportingDates);
    expect(promotedDates.length).toBeGreaterThan(0);
  });

  it("keeps every promoted window's supporting dates within its own exclusion radius", () => {
    // A direct (non-chained) triangle: all three mutually within tolerance
    // of a genuine circular center, straddling the Dec 31 / Jan 1 seam.
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2022-12-29", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c2", date: "2023-12-31", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c3", date: "2025-01-02", reasonKey: "local_event", scope: "annual" }),
      ],
      { now: "2025-01-02", maxAgeYears: 10 },
    );
    expect(model.promotedAnnualWindows).toHaveLength(1);
    const window = model.promotedAnnualWindows[0];
    for (const d of window.supportingDates) {
      expect(isDateReinforcementExcluded(model, d)).toBe(true);
    }
  });
});

describe("improve_future scope: the highest bar", () => {
  it("needs three distinct years, not two", () => {
    const twoOnly = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2026-06-14" },
    );
    expect(twoOnly.promotedSeasonExclusionWindows).toHaveLength(0);
    expect(twoOnly.pending[0].count).toBe(2);
    expect(twoOnly.pending[0].needed).toBe(3);

    const threeDistinct = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2024-06-12", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2026-06-14" },
    );
    expect(threeDistinct.promotedSeasonExclusionWindows).toHaveLength(1);
  });

  it("promoted improve_future windows also count as promoted annual windows (a strict superset)", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2024-06-12", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2026-06-14" },
    );
    expect(model.promotedAnnualWindows).toHaveLength(1);
    expect(model.promotedSeasonExclusionWindows).toHaveLength(1);
  });

  it("annual-only promotions do not leak into season-exclusion windows", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "local_event", scope: "annual" }),
      ],
      { now: "2026-06-14" },
    );
    expect(model.promotedAnnualWindows).toHaveLength(1);
    expect(model.promotedSeasonExclusionWindows).toHaveLength(0);
  });

  it("expands into concrete per-year periods, padded so wraparound coverage is never dropped", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2024-06-12", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2026-06-14" },
    );
    const periods = seasonExclusionPeriods(model, 2023, 2026);
    // fromYear-1 through toYear+1 inclusive = 6 years' worth of periods.
    expect(periods).toHaveLength(6);
    for (const p of periods) expect(p.start_date < p.end_date).toBe(true);
  });

  it("does not drop a promoted window's coverage at the start of the requested range when it wraps the year end", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2023-12-31", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2024-12-31", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2025-12-31", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2025-12-31" },
    );
    const window = model.promotedSeasonExclusionWindows[0];
    const periods = expandPromotedWindowToPeriods(window, 2025, 2025);
    // Early January of fromYear itself must be covered by the (fromYear - 1)
    // instance's tail, not silently dropped.
    const earlyJan = "2025-01-02";
    const covered = periods.some((p) => earlyJan >= p.start_date && earlyJan <= p.end_date);
    expect(covered).toBe(true);
    expect(isDateReinforcementExcluded(model, earlyJan)).toBe(true);
  });
});

describe("age decay", () => {
  it("stops counting challenges older than the max age toward corroboration", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2019-06-13", reasonKey: "local_event", scope: "annual", raisedAt: "2019-06-13" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "local_event", scope: "annual", raisedAt: "2025-06-14" }),
      ],
      { now: "2026-06-14" },
    );
    expect(model.promotedAnnualWindows).toHaveLength(0);
    expect(model.pending[0].count).toBe(1);
  });

  it("still promotes once enough FRESH corroboration exists on its own", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2019-06-13", reasonKey: "local_event", scope: "annual", raisedAt: "2019-06-13" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "local_event", scope: "annual", raisedAt: "2025-06-14" }),
        challenge({ id: "c3", date: "2024-06-12", reasonKey: "local_event", scope: "annual", raisedAt: "2024-06-12" }),
      ],
      { now: "2026-06-14" },
    );
    expect(model.promotedAnnualWindows).toHaveLength(1);
  });

  it("uses true calendar-year subtraction so a Feb 29 in the span never shifts the cutoff by a day", () => {
    // 3 years back from 2026-07-28 is exactly 2023-07-28 on the calendar,
    // even though a Feb 29 (2024) falls inside that span.
    const exactlyOnBoundary = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2023-07-28", reasonKey: "local_event", scope: "annual", raisedAt: "2023-07-28" }),
        challenge({ id: "c2", date: "2025-07-28", reasonKey: "local_event", scope: "annual", raisedAt: "2025-07-28" }),
      ],
      { now: "2026-07-28" },
    );
    expect(exactlyOnBoundary.promotedAnnualWindows).toHaveLength(1);
  });
});

describe("reinforcementExclusionPredicate", () => {
  it("produces a closure suitable for selectComparableDates's isExcluded option", () => {
    const model = buildReinforcementModel(
      [challenge({ id: "c1", date: "2026-07-04", reasonKey: "severe_weather", scope: "this_date" })],
      { now: "2026-07-05" },
    );
    const isExcluded = reinforcementExclusionPredicate(model);
    expect(isExcluded("2026-07-04")).toBe(true);
    expect(isExcluded("2026-07-05")).toBe(false);
  });
});

describe("explainability", () => {
  it("describes an instance exclusion, using the freeform text for Other", () => {
    expect(describeInstanceExclusion("severe_weather")).toContain("severe weather");
    expect(describeInstanceExclusion("other", "Bridge closure downtown")).toContain(
      "bridge closure downtown",
    );
  });

  it("describes pending progress in terms of years, with an honest count toward the threshold", () => {
    const model = buildReinforcementModel(
      [challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" })],
      { now: "2026-06-14" },
    );
    const text = describePendingProgress(model.pending[0]);
    expect(text).toContain("1 year");
    expect(text).toContain("2 different years");
    expect(text).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("describes a promoted window and its consequence in terms of years", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2024-06-12", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2026-06-14" },
    );
    const text = describePromotedWindow(model.promotedSeasonExclusionWindows[0]);
    expect(text).toContain("3 different years");
    expect(text).toContain("seasonal calculations");
    expect(text).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("never emits math symbols across every message type", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c3", date: "2026-01-10", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2026-06-14" },
    );
    for (const p of model.pending) expect(describePendingProgress(p)).not.toMatch(NO_MATH_SYMBOLS);
    for (const w of model.promotedAnnualWindows) expect(describePromotedWindow(w)).not.toMatch(NO_MATH_SYMBOLS);
  });
});

describe("determinism", () => {
  it("produces identical models for identical input", () => {
    const challenges = [
      challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" }),
      challenge({ id: "c2", date: "2025-06-14", reasonKey: "local_event", scope: "annual" }),
    ];
    expect(buildReinforcementModel(challenges, { now: "2026-06-14" })).toEqual(
      buildReinforcementModel(challenges, { now: "2026-06-14" }),
    );
  });
});
