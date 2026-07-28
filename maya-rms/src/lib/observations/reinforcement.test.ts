import { describe, expect, it } from "vitest";
import {
  CHALLENGE_REASONS,
  CORROBORATION_DISTINCT_DATES,
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
    // Genuinely new reasons beyond Jake's original five.
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
    expect(CORROBORATION_DISTINCT_DATES.this_date).toBe(1);
  });
});

describe("annual scope: requires corroboration before generalizing", () => {
  it("does not generalize on a single report", () => {
    const model = buildReinforcementModel(
      [challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" })],
      { now: "2026-06-14" },
    );
    // The instance itself is excluded immediately...
    expect(isDateReinforcementExcluded(model, "2026-06-13")).toBe(true);
    // ...but the SAME window in a different, unflagged year is not, yet.
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
    // Far outside the tolerance window, unaffected.
    expect(isDateReinforcementExcluded(model, "2024-09-01")).toBe(false);
  });

  it("does not let repeated reports of the SAME date count as corroboration", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" }),
        challenge({ id: "c2", date: "2026-06-13", reasonKey: "local_event", scope: "annual", raisedBy: "user-2" }),
      ],
      { now: "2026-06-14" },
    );
    expect(model.promotedAnnualWindows).toHaveLength(0);
    expect(model.pending[0].count).toBe(1);
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

describe("improve_future scope: the highest bar", () => {
  it("needs three distinct dates, not two", () => {
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

  it("expands into concrete per-year periods usable directly by detectSeasons", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2024-06-12", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2026-06-14" },
    );
    const periods = seasonExclusionPeriods(model, 2023, 2026);
    expect(periods).toHaveLength(4);
    for (const p of periods) {
      expect(p.start_date < p.end_date).toBe(true);
      expect(p.start_date.slice(0, 4)).toMatch(/^202[3-6]$/);
    }
    const window = model.promotedSeasonExclusionWindows[0];
    const single = expandPromotedWindowToPeriods(window, 2026, 2026)[0];
    expect(single.start_date <= `2026-${window.centerKey}`).toBe(true);
    expect(single.end_date >= `2026-${window.centerKey}`).toBe(true);
  });
});

describe("age decay", () => {
  it("stops counting challenges older than the max age toward corroboration", () => {
    const model = buildReinforcementModel(
      [
        // Stale: raised long before `now`, beyond the default 3-year window.
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

  it("describes pending progress with an honest count toward the threshold", () => {
    const model = buildReinforcementModel(
      [challenge({ id: "c1", date: "2026-06-13", reasonKey: "local_event", scope: "annual" })],
      { now: "2026-06-14" },
    );
    const text = describePendingProgress(model.pending[0]);
    expect(text).toContain("1 of the 2 reports");
    expect(text).not.toMatch(NO_MATH_SYMBOLS);
  });

  it("describes a promoted window and its consequence", () => {
    const model = buildReinforcementModel(
      [
        challenge({ id: "c1", date: "2026-06-13", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c2", date: "2025-06-14", reasonKey: "renovation", scope: "improve_future" }),
        challenge({ id: "c3", date: "2024-06-12", reasonKey: "renovation", scope: "improve_future" }),
      ],
      { now: "2026-06-14" },
    );
    const text = describePromotedWindow(model.promotedSeasonExclusionWindows[0]);
    expect(text).toContain("3 separate reports");
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
