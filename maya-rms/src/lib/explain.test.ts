import { describe, expect, it } from "vitest";
import { buildExplainView, humanDate } from "./explain";

const comparableSnapshot = {
  target: "2026-08-14",
  asOf: "2026-07-28",
  daysOut: 17,
  windowDays: 7,
  recentBookings: 9,
  expectedBookings: 4.2,
  method: "comparable",
  perComparable: [
    { date: "2025-08-15", bookings: 4, tier: 0, reasons: ["same season", "about a year earlier"], hasData: true },
    { date: "2024-08-16", bookings: 5, tier: 0, reasons: ["same season"], hasData: true },
    { date: "2023-08-18", bookings: 0, tier: 1, reasons: ["nearby weeks"], hasData: false },
  ],
  selection: {
    target: "2026-08-14",
    comparables: [],
    assumptions: {
      dayOfWeek: "Friday",
      dowClass: "weekend",
      holiday: null,
      seasonLabel: "Summer",
      seasonRange: "Jun 10 – Aug 24",
      relaxed: false,
    },
  },
  classification: {
    speed: "much_faster",
    rank: 2,
    label: "Much Faster Than Normal",
    ratio: 2.14,
    difference: 4.8,
    guard: "none",
    recentBookings: 9,
    expectedBookings: 4.2,
  },
};

describe("buildExplainView", () => {
  it("renders the comparable-method levels", () => {
    const view = buildExplainView(comparableSnapshot);
    expect(view).not.toBeNull();
    expect(view!.observed).toContain("9 bookings");
    expect(view!.observed).toContain("17 days");
    expect(view!.expected).toContain("about 4 bookings");
    expect(view!.verdict).toContain("Much Faster Than Normal");
    expect(view!.guard_note).toBeNull();
    expect(view!.method).toBe("comparable");
    expect(view!.assumptions.join(" ")).toContain("Friday");
    expect(view!.assumptions.join(" ")).toContain("Summer");
    expect(view!.comparables).toHaveLength(3);
    // hasData false reads as "we don't know", never as zero bookings.
    expect(view!.comparables[2].summary).toBe("no history for this night");
    expect(view!.comparables[0].summary).toBe("4 bookings in the same stretch");
  });

  it("explains holiday matching instead of season when a holiday is in play", () => {
    const snap = structuredClone(comparableSnapshot);
    snap.selection.assumptions.holiday = {
      key: "us_thanksgiving",
      label: "Thanksgiving",
      offset: -1,
      placement: "thursday",
      holidayDate: "2026-11-26",
    } as never;
    const view = buildExplainView(snap);
    const text = view!.assumptions.join(" ");
    expect(text).toContain("Thanksgiving");
    expect(text).not.toContain("Summer");
  });

  it("notes when strict matching was relaxed", () => {
    const snap = structuredClone(comparableSnapshot);
    snap.selection.assumptions.relaxed = true;
    expect(buildExplainView(snap)!.assumptions.join(" ")).toContain("relaxed");
  });

  it("translates evidence guards into honesty notes", () => {
    const snap = structuredClone(comparableSnapshot);
    snap.classification.guard = "few_comparables";
    expect(buildExplainView(snap)!.guard_note).toContain("only a few");
    snap.classification.guard = "small_difference";
    expect(buildExplainView(snap)!.guard_note).toContain("noise");
    snap.classification.guard = "extreme_demoted";
    expect(buildExplainView(snap)!.guard_note).toContain("softened");
  });

  it("renders the momentum story with matched pairs, direction, and challengeable evidence", () => {
    const view = buildExplainView({
      ...comparableSnapshot,
      method: "momentum",
      perComparable: [],
      momentum: {
        expectedBookings: 3.1,
        momentumRatio: 1.4,
        neighborsUsed: 8,
        matchedPairs: 2,
        pairs: [
          { date: "2026-08-12", bookings: 3, yearAgoDate: "2025-08-13", yearAgoBookings: 2 },
          { date: "2026-08-16", bookings: 4, yearAgoDate: "2025-08-17", yearAgoBookings: 3 },
        ],
        naiveBaselineBookings: 2.2,
        baselineSource: "target_year_ago",
        baselineDate: "2025-08-15",
      },
    });
    expect(view!.method).toBe("momentum");
    expect(view!.momentum_notes.join(" ")).toContain("2 nearby nights");
    expect(view!.momentum_notes.join(" ")).toContain("40% faster");
    expect(view!.momentum_notes.join(" ")).toContain("best effort");
    expect(view!.assumptions.join(" ")).toContain("momentum");
    // The pairings and the baseline are challengeable evidence rows keyed
    // on the year-ago side — the falsifiability path for momentum reads.
    expect(view!.comparables.map((c) => c.date)).toEqual([
      "2025-08-13",
      "2025-08-17",
      "2025-08-15",
    ]);
    expect(view!.comparables[0].summary).toContain("2 bookings at this point last year");
    expect(view!.comparables[2].reasons.join(" ")).toContain("a year ago");
  });

  it("never claims an unchanged pace when zero pairs were measured", () => {
    // matchedPairs 0 makes the engine emit its neutral ratio placeholder of
    // exactly 1 — a no-evidence sentinel, not a measurement.
    const view = buildExplainView({
      ...comparableSnapshot,
      method: "momentum",
      perComparable: [],
      momentum: {
        expectedBookings: 2.2,
        momentumRatio: 1,
        neighborsUsed: 4,
        matchedPairs: 0,
        pairs: [],
        naiveBaselineBookings: 2.2,
        baselineSource: "neighbor_pace",
        baselineDate: null,
      },
    });
    const notes = view!.momentum_notes.join(" ");
    expect(notes).toContain("cannot say whether the pace has changed");
    expect(notes).not.toContain("same pace as a year ago");
  });

  it("treats a near-1 measured ratio as unchanged, matching the level-1 wording", () => {
    const view = buildExplainView({
      ...comparableSnapshot,
      method: "momentum",
      perComparable: [],
      momentum: {
        expectedBookings: 2.3,
        momentumRatio: 1.03,
        neighborsUsed: 5,
        matchedPairs: 4,
        pairs: [],
        naiveBaselineBookings: 2.2,
        baselineSource: "neighbor_pace",
        baselineDate: null,
      },
    });
    expect(view!.momentum_notes.join(" ")).toContain("same pace as a year ago");
  });

  it("keeps the insufficient-data story honest against the shape the engine really persists", () => {
    // The engine writes expectedBookings: 0 (never null) and a fully
    // computed classification even when it blocked every booking-speed
    // rule — the view must not render that classification as a verdict.
    const view = buildExplainView({
      ...comparableSnapshot,
      method: "insufficient_data",
      recentBookings: 3,
      expectedBookings: 0,
      perComparable: [],
      classification: {
        speed: "faster",
        rank: 1,
        label: "Faster Than Normal",
        ratio: 6,
        difference: 2.5,
        guard: "few_comparables",
        recentBookings: 3,
        expectedBookings: 0,
      },
    });
    expect(view!.method).toBe("insufficient_data");
    expect(view!.expected).toContain("not have enough history");
    expect(view!.verdict).not.toContain("Faster Than Normal");
    expect(view!.verdict).toContain("No booking-speed call was made");
    expect(view!.guard_note).toBeNull();
    expect(view!.assumptions.join(" ")).toContain("not enough history");
  });

  it("returns null for legacy or malformed snapshots", () => {
    expect(buildExplainView(null)).toBeNull();
    expect(buildExplainView("nope")).toBeNull();
    expect(buildExplainView({})).toBeNull();
    expect(buildExplainView({ target: "2026-08-14" })).toBeNull();
    const noClassification = { ...comparableSnapshot, classification: undefined };
    expect(buildExplainView(noClassification)).toBeNull();
  });

  it("never uses math symbols in the prose", () => {
    const view = buildExplainView(comparableSnapshot)!;
    const all = [view.observed, view.expected, view.verdict, ...view.assumptions].join(" ");
    expect(all).not.toMatch(/[<>=≤≥]/);
  });
});

describe("humanDate", () => {
  it("formats with weekday and year", () => {
    expect(humanDate("2026-08-14")).toBe("Fri, Aug 14 2026");
    expect(humanDate("2024-02-29")).toBe("Thu, Feb 29 2024");
  });

  it("passes through unparseable input", () => {
    expect(humanDate("not-a-date")).toBe("not-a-date");
  });
});
